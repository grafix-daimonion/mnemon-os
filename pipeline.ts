// pipeline.ts — Synapsis write path with the Ownership & Identity model (v2):
// archive verbatim -> gather context -> extract -> resolve (KIND-DEPENDENT) -> persist -> contradiction.
//
// Identity (Ownership v2 §3):
//   - INDEPENDENT entities (person/org) resolve GLOBALLY by name (one Alice everywhere).
//   - DEPENDENT entities (project/deadline/…) resolve OWNER-SCOPED — matched only within their
//     owner's children, and CREATED with an owner edge (never orphaned).
// Owner scope is supplied explicitly (the account/--scope); placement-by-inference is deferred (§7.1).
import type { PGlite } from "@electric-sql/pglite";
import { extractFacts } from "./extract.ts";
import { contradicts, type Fact } from "./synapsis/resolve.ts";
import { logEvent } from "./logger.ts";
import { chunkText } from "./chunk.ts";
import { embed, toVector } from "./embed.ts";
import { faithful, sourceHash, sameEntity } from "./synapsis/verify.ts";
import { osaDistance, normLabel, fuzzyCap } from "./synapsis/fuzzy.ts";
import { buildDiary } from "./diary.ts";

export interface Interaction {
  content: string;
  speaker: string | null;
  occurred_at: string;
}

export interface IngestOpts {
  account?: string | null; // the account/owner this conversation is about (scopes dependent entities)
}

const toISO = (v: any): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const INDEPENDENT = new Set(["person", "org"]);
const OWNERSHIP_PREDS = ["has", "owns", "part of", "runs", "leads", "member of"];

// Promote an entity's type toward specificity — a known `org`/`project` is never demoted
// back to the `"thing"` fallback once we've learned it. (Identity stays the label; the type
// is just a soft descriptive tag that sharpens over time.)
async function promoteType(db: PGlite, id: number, currentType: string, incomingType: string): Promise<void> {
  if (incomingType !== "thing" && (currentType === "thing" || !currentType))
    await db.query(`update entities set type = $1 where id = $2`, [incomingType, id]);
}

// Resolve a mention to a node. IDENTITY = the canonical label, decoupled from the LLM's
// volatile `type` (so "Daimonion" is one node whether typed org or thing). Layers:
//   1. exact (normalized) match  → reuse        [cheap, certain]
//   2. remembered alias          → reuse        [a previously-confirmed variant]
//   3. fuzzy lexical (typo)      → QA → reuse    [Daimonion ≈ Daiamnion]
//   4. no match                  → create       [independent=global; dependent=owner-scoped + edge]
// `type` only decides how a GENUINELY-NEW node is created; it never forks an existing identity.
export async function resolveOrCreate(
  db: PGlite, label: string, type: string | undefined,
  ownerId: number | null, occurred_at: string, interactionId: number,
  account: string | null = null,
): Promise<number> {
  const t = type || "thing";
  const display = String(label).trim();
  const norm = normLabel(display);

  const ents = (await db.query<{ id: number; label: string; type: string }>(
    `select id, label, type from entities`)).rows;

  // 1. exact normalized match — identity is the name, regardless of type.
  const exact = ents.find((e) => normLabel(e.label) === norm);
  if (exact) { await promoteType(db, exact.id, exact.type, t); return exact.id; }

  // 2. remembered alias (a previously-confirmed variant/typo).
  const al = await db.query<{ entity_id: number }>(
    `select entity_id from entity_aliases where norm = $1 limit 1`, [norm]);
  if (al.rows.length) return al.rows[0].entity_id;

  // 3. fuzzy lexical candidate — nearest existing label within a length-scaled edit cap.
  let best: { id: number; label: string; type: string; d: number } | null = null;
  for (const e of ents) {
    const en = normLabel(e.label);
    const cap = fuzzyCap(norm, en);
    if (cap < 1) continue;
    const d = osaDistance(norm, en);
    if (d >= 1 && d <= cap && (!best || d < best.d)) best = { ...e, d };
  }
  if (best) {
    // QA gate — fuzzy proposes, the guardrail confirms (rejects look-alikes like Pythia/Python).
    const same = await sameEntity(display, best.label, account);
    logEvent("entity.fuzzy", { incoming: display, candidate: best.label, distance: best.d, same: same.ok, reason: same.reason });
    if (same.ok) {
      await db.query(
        `insert into entity_aliases (entity_id, alias, norm) values ($1, $2, $3) on conflict (norm) do nothing`,
        [best.id, display, norm]);
      await promoteType(db, best.id, best.type, t);
      return best.id;
    }
  }

  // 4. no match → create. independent (person/org) is global; a dependent gets an owner edge.
  const independent = INDEPENDENT.has(t);
  const childId = (await db.query<{ id: number }>(
    `insert into entities (type, label) values ($1, $2) returning id`, [t, display])).rows[0].id;
  if (!independent && ownerId != null && ownerId !== childId) {
    await db.query(
      `insert into facts (subject_id, predicate, object_entity_id, shape, valid_from, source_interaction_id, source_span)
       values ($1, 'has', $2, 'multi', $3, $4, $5)`,
      [ownerId, childId, occurred_at, interactionId, "(owner scope)"]);
  }
  return childId;
}

export async function ingest(db: PGlite, it: Interaction, opts: IngestOpts = {}): Promise<void> {
  // 1. archive verbatim (append-only) — first, before anything that can fail
  const ins = await db.query<{ id: number }>(
    `insert into interactions (content, speaker, occurred_at) values ($1, $2, $3) returning id`,
    [it.content, it.speaker, it.occurred_at]);
  const interactionId = ins.rows[0].id;

  // 1b. L0 floor: chunk + embed + store the verbatim (keyword + vector indexed).
  const pieces = chunkText(it.content);
  for (let i = 0; i < pieces.length; i++) {
    const vec = toVector(await embed(pieces[i]));
    await db.query(`insert into chunks (interaction_id, ord, content, embedding) values ($1, $2, $3, $4::vector)`,
      [interactionId, i, pieces[i], vec]);
  }

  // verbatim + chunks are safe above. Extraction is best-effort: a flaky LLM call must NOT abort the
  // batch (failure-recovery, Synapsis §5) — the verbatim/chunks stay; catch-up reprocesses later.
  try {
  // owner scope for this conversation's dependent entities (explicit; Ownership v2 §7.1)
  const accountId = opts.account
    ? await resolveOrCreate(db, opts.account, "org", null, it.occurred_at, interactionId)
    : null;

  // 2. gather context so extraction reuses, not re-mints (replace with owner-scoped retrieval — Task #2)
  const ctxEntities = (await db.query<{ label: string; type: string }>(
    `select label, type from entities order by id desc limit 100`)).rows;
  const ctxPredicates = (await db.query<{ predicate: string }>(
    `select distinct predicate from facts limit 100`)).rows.map((r) => r.predicate);

  // 3. extract every durable fact, with context
  const facts = await extractFacts(it.content, it.speaker, interactionId, {
    entities: ctxEntities, predicates: ctxPredicates, account: opts.account ?? null,
  });

  for (const ex of facts) {
    if (!ex?.subject || !ex?.predicate || ex?.object == null) continue; // skip malformed
    const shape = ex.shape === "multi" ? "multi" : "single";

    // 4. resolve (identity = label): subject scoped to the account; object scoped to its owner
    const subjectId = await resolveOrCreate(db, String(ex.subject), ex.subject_type, accountId, it.occurred_at, interactionId, opts.account ?? null);
    let objectEntityId: number | null = null;
    let objectLiteral: string | null = null;
    if (ex.object_kind === "entity") {
      // an explicit ownership edge means the SUBJECT owns the object; otherwise default to the account
      const ownerForObject = OWNERSHIP_PREDS.includes(String(ex.predicate).toLowerCase()) ? subjectId : accountId;
      objectEntityId = await resolveOrCreate(db, String(ex.object), ex.object_type, ownerForObject, it.occurred_at, interactionId, opts.account ?? null);
    } else {
      objectLiteral = String(ex.object);
    }

    // self-loop guard: "X has X" / "X status X" carries no information (e.g. when the account
    // node and the extracted topic resolve to the same entity — the old "Daimonion has Daimonion").
    if (objectEntityId != null && objectEntityId === subjectId) {
      logEvent("skip.selfloop", { subject: ex.subject, predicate: ex.predicate, object: ex.object });
      continue;
    }

    // 5. persist as PROVISIONAL (+ source_hash for drift detection). Not trusted until QA passes.
    const factIns = await db.query<{ id: number }>(
      `insert into facts (subject_id, predicate, object_entity_id, object_literal, shape, valid_from, source_interaction_id, source_span, source_hash, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'provisional') returning id`,
      [subjectId, ex.predicate, objectEntityId, objectLiteral, shape, it.occurred_at, interactionId, ex.source_span ?? null, sourceHash(ex.source_span ?? String(ex.object))]);
    const incoming: Fact = {
      id: factIns.rows[0].id, subjectId, subjectLabel: String(ex.subject),
      predicate: ex.predicate, object: String(ex.object), shape, validFrom: it.occurred_at,
    };

    // 5b. QA — faithfulness cross-check vs the verbatim. Verify, don't trust.
    const v = await faithful({ subject: String(ex.subject), predicate: ex.predicate, object: String(ex.object) }, it.content);
    logEvent("qa", { fact_id: incoming.id, subject: ex.subject, predicate: ex.predicate, object: ex.object, supported: v.ok, reason: v.reason });
    if (!v.ok) {
      await db.query(`update facts set status = 'quarantined' where id = $1`, [incoming.id]);
      if (!process.env.MNEMON_QUIET) console.log(`  ⚠ quarantined #${incoming.id} ("${ex.object}") — ${v.reason}`);
      continue; // quarantined facts never drive current-state
    }
    await db.query(`update facts set status = 'confirmed' where id = $1`, [incoming.id]);

    // 6. contradiction -> current-state: close any open CONFIRMED fact this one supersedes
    const open = await db.query<any>(
      `select f.id, f.predicate, f.object_literal, oe.label as object_entity_label, f.shape, f.valid_from
       from facts f left join entities oe on oe.id = f.object_entity_id
       where f.subject_id = $1 and f.valid_until is null and f.status = 'confirmed' and f.id <> $2`,
      [subjectId, incoming.id]);
    for (const row of open.rows) {
      const existing: Fact = {
        id: row.id, subjectId, subjectLabel: String(ex.subject),
        predicate: row.predicate, object: row.object_literal ?? row.object_entity_label ?? "",
        shape: row.shape, validFrom: toISO(row.valid_from),
      };
      const v = await contradicts(incoming, existing);
      logEvent("contradiction", {
        subject: ex.subject,
        incoming: { predicate: incoming.predicate, object: incoming.object },
        existing: { predicate: existing.predicate, object: existing.object },
        verdict: v.contradicts, reason: v.reason,
      });
      if (v.contradicts) {
        await db.query(`update facts set valid_until = $1, superseded_by = $2 where id = $3`,
          [incoming.validFrom, incoming.id, existing.id]);
        if (!process.env.MNEMON_QUIET)
          console.log(`  ↳ superseded fact #${existing.id} ("${existing.object}") — ${v.reason}`);
      }
    }
  }
  // L5: rebuild the day's Diary from CONFIRMED facts (deterministic, lossless, heavy-refs).
  await buildDiary(db, it.occurred_at);
  } catch (e) {
    logEvent("ingest.extract_failed", { interaction_id: interactionId, error: String(e) });
  }
}
