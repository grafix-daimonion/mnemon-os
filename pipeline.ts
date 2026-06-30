// pipeline.ts — Synapsis write path with the Ownership & Identity model (v2):
// archive verbatim -> gather context -> extract -> resolve (KIND-DEPENDENT) -> persist -> contradiction.
//
// Identity (Ownership v2 §3):
//   - INDEPENDENT entities (person/org) resolve GLOBALLY by name (one Alice everywhere).
//   - DEPENDENT entities (project/deadline/…) resolve OWNER-SCOPED — matched only within their
//     owner's children, and CREATED with an owner edge (never orphaned).
// Owner scope is supplied explicitly (the account/--scope); placement-by-inference is deferred (§7.1).
import type { Db } from "./db";
import { extractFacts } from "./extract.ts";
import { createCommitment, applyReversal } from "./commitments.ts";
import { contradicts, type Fact } from "./synapsis/resolve.ts";
import { logEvent } from "./logger.ts";
import { chunkText } from "./chunk.ts";
import { embed, toVector } from "./embed.ts";
import { faithful, sourceHash, sameEntity } from "./synapsis/verify.ts";
import { osaDistance, normLabel, fuzzyCap, parseVersion, versionVerdict } from "./synapsis/fuzzy.ts";
import { buildDiary } from "./diary.ts";

export interface Interaction {
  content: string;
  speaker: string | null;
  occurred_at: string;
}

export interface IngestOpts {
  account?: string | null; // the account/owner this conversation is about (scopes dependent entities)
  owner?: string | null;   // Lock 2: the human Owner's name → anchored as Person:Human (not guessed)
  aiPersonas?: string[];   // Lock 4: names that are AI agents/personas → anchored as Persona:AI
}

const toISO = (v: any): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// Parse a free-text due ("by Friday", "Q2", "2026-06-30") into an ISO timestamp, or null when it
// isn't a concrete date. Keeps `commitments.due_at` (timestamptz) clean; fuzzy dues stay in `action`.
function isoOrNull(v: any): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const INDEPENDENT = new Set(["person", "org", "Person:Human", "Persona:AI"]);
// Lock 4: identity sub-kinds — once an entity is a known Person/Persona, it is authoritative.
const isIdentityKind = (t: string) => /^(Person|Persona):/.test((t ?? "").trim());
const OWNERSHIP_PREDS = ["has", "owns", "part of", "runs", "leads", "member of"];

// Predicates whose facts ACCUMULATE (a person has many commitments, many tasks, many
// responsibilities), so the LLM's "shape" must be forced to "multi" — never "single",
// which would make a later commitment wrongly supersede an earlier one (commitment loss,
// F-MNEMON-17). Ambiguous predicates like "wants to"/"plans to" are NOT here — they stay
// LLM-decided (they can be either a new wish or a reversal of an earlier one).
const ACCUMULATOR_PREDS = new Set([
  "commitment", "commits to", "promised", "promise",
  "task", "todo", "action item",
  "responsible for", "works on",
  // ownership preds — already multi by the extractor; included as a safety belt:
  "has", "owns", "part of", "runs", "leads", "member of",
  // feedback mind-facts (corrections/errors/praise) — each is a distinct lesson, so they ACCUMULATE
  // and must never supersede one another, regardless of the shape the extractor returns.
  "received_correction", "erred", "hallucinated", "praised",
]);

// Force a predicate's shape to "multi" if it's a known accumulator; otherwise honour the
// LLM's shape (default single). Pure + deterministic so it's unit-testable without DB/LLM.
export function correctShape(predicate: string, llmShape: string): "single" | "multi" {
  if (ACCUMULATOR_PREDS.has(String(predicate ?? "").toLowerCase().trim())) return "multi";
  return llmShape === "multi" ? "multi" : "single";
}

// Promote an entity's type toward specificity. F-MNEMON-23 rule (ENGINE_SPEC_v5 §11):
//   - Promote only if incoming is more specific (not 'thing'/empty).
//   - 'thing'/empty → specific: simple promotion, no log.
//   - specific A → specific B (conflict): last-writer-wins, logged as
//     `entity.type_promotion_conflict` for audit. Caller (operator) can review.
//   - Never demote to 'thing' (existing rule, kept).
async function promoteType(db: Db, id: number, currentType: string, incomingType: string): Promise<void> {
  const inc = (incomingType || "thing").trim();
  const cur = (currentType || "thing").trim();
  if (inc === "thing" || inc === cur) return;
  // Lock 4: an identity sub-kind (Person:Human / Persona:AI), once set, is authoritative —
  // a later extractor guess must never demote it (e.g. Pythia: Persona:AI must not become "thing").
  if (isIdentityKind(cur)) return;
  if (cur === "thing" || !cur) {
    await db.query(`update entities set type = $1 where id = $2`, [inc, id]);
    return;
  }
  // Two distinct non-'thing' types — conflict; last-writer-wins; audit-log.
  logEvent("entity.type_promotion_conflict", { entity_id: id, prior_type: cur, new_type: inc, action: "last_writer_wins" });
  await db.query(`update entities set type = $1 where id = $2`, [inc, id]);
}

// Resolve a mention to a node. IDENTITY = the canonical label, decoupled from the LLM's
// volatile `type` (so "Daimonion" is one node whether typed org or thing). Layers:
//   1. exact (normalized) match  → reuse        [cheap, certain]
//   2. remembered alias          → reuse        [a previously-confirmed variant]
//   3. fuzzy lexical (typo)      → QA → reuse    [Daimonion ≈ Daiamnion]
//   4. no match                  → create       [independent=global; dependent=owner-scoped + edge]
// `type` only decides how a GENUINELY-NEW node is created; it never forks an existing identity.
export async function resolveOrCreate(
  db: Db, label: string, type: string | undefined,
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

  // 2.5. version-aware policy (deterministic for clear cases; ambiguous falls through to fuzzy+QA):
  //   - person/org + version suffix          → merge   (versions don't apply → artifact)
  //   - same base, bare ↔ versioned          → merge   (umbrella absorbs instance)
  //   - same base, two distinct version Ns   → distinct (separate releases)
  //   precedence: distinct > merge — once versioned siblings exist, preserve specificity.
  const vVerdicts = ents.map((e) => ({ e, v: versionVerdict(display, e.label, t, e.type) }));
  const vDistinct = vVerdicts.filter((x) => x.v === "distinct");
  const vMerge = vVerdicts.filter((x) => x.v === "merge");
  if (vDistinct.length === 0 && vMerge.length > 0) {
    const m = vMerge[0]; // first merge target (typically the bare umbrella)
    logEvent("entity.version-rule", { incoming: display, type: t, verdict: "merge", target: m.e.label, target_type: m.e.type });
    await db.query(
      `insert into entity_aliases (entity_id, alias, norm) values ($1, $2, $3) on conflict (norm) do nothing`,
      [m.e.id, display, norm]);
    await promoteType(db, m.e.id, m.e.type, t);
    return m.e.id;
  }
  const skipFuzzyBase = vDistinct.length > 0;
  if (skipFuzzyBase) {
    logEvent("entity.version-rule", { incoming: display, type: t, verdict: "create-distinct", siblings: vDistinct.map((x) => x.e.label) });
  }

  // 3. fuzzy lexical candidate — nearest existing label within a length-scaled edit cap.
  const iv = parseVersion(display);
  const iBase = (iv?.base ?? display).toLowerCase().trim();
  let best: { id: number; label: string; type: string; d: number } | null = null;
  for (const e of ents) {
    if (skipFuzzyBase) {
      // distinct version siblings exist → don't let fuzzy re-merge against same-base candidates
      const ev = parseVersion(e.label);
      const eBase = (ev?.base ?? e.label).toLowerCase().trim();
      if (eBase === iBase) continue;
    }
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

// Concurrency cap for parallel per-chunk extraction (ENGINE_SPEC_v5 §2).
// At ~3 LLM calls per chunk × 8 chunks = up to 24 concurrent Anthropic requests per batch —
// well inside Haiku's per-minute budget for typical save sizes; Sonnet too. Sequential
// opt-out via MNEMON_EXTRACT_SEQUENTIAL=1 for installs hitting rate limits.
const EXTRACT_MAX_CONCURRENCY = 8;

// Bridge fix per ASYNC_EXTRACTION_PLAN_v2 §10 + dev-review §8 (2026-05-27):
// `ingest()` returns an IngestResult so the caller can surface per-chunk extract
// failures and outer-pipeline errors to the user — closing the silent-loss trust gap
// (W-MNEMON-26). Visibility is the close; data-layer quarantine state (Option C from
// §10) is deferred to v6's synapsis_runs schema because facts.subject_id NOT NULL
// blocks writing a quarantine fact row without an entity (would require a sentinel
// or a schema change — out of bridge-fix scope).
export interface IngestResult {
  total_chunks: number;
  failed_chunks: number;        // count of chunks whose extractFacts() threw
  outer_error: string | null;   // non-extract failure post-loop (resolve / persist / QA / Diary)
}

/**
 * Per-chunk processing context. Computed once per interaction in ingest() (or in Z2 by claim
 * batch); reused for every extractChunk() call so neither path re-mints the LLM context.
 */
export interface ChunkContext {
  /** the interaction this chunk belongs to */
  interactionId: number;
  speaker: string | null;
  occurredAt: string;
  /** explicit account/owner scope for resolving dependent entities */
  account: string | null;
  accountId: number | null;
  /** LLM extraction context (passed straight to extractFacts) */
  extractCtx: {
    entities: { label: string; type: string }[];
    predicates: string[];
    account: string | null;
    owner: string | null;
    ai_personas: string[];
  };
}

/**
 * Result of processing a single chunk end-to-end (extract → resolve → persist → QA → contradiction).
 * `status` mirrors `chunks.extraction_status` written by this function.
 */
export interface ExtractChunkResult {
  chunk_id: number;
  facts_persisted: number;
  facts_quarantined: number;
  status: "extracted" | "quarantined";
  error?: string;
}

/**
 * Per-chunk extraction body (DECOUPLING_IMPL_SPEC_v2 §10 Task 5 factor).
 *
 * Called once per chunk by ingest() (inline path) AND by Z2 synapsis-worker.ts (decoupled path).
 * Encapsulates: LLM extract → per-fact resolve → persist provisional → faithfulness QA → contradiction.
 *
 * **Error isolation (A5)**: the try/catch lives INSIDE this function. A throw during extract or
 * downstream processing for ONE chunk:
 *   - is logged via `ingest.chunk_extract_failed`,
 *   - sets `chunks.extraction_status = 'quarantined'` for that chunk,
 *   - returns `{ status: 'quarantined', error: ... }` to the caller,
 * and CANNOT propagate to other chunks in the caller's loop. Regression guard:
 * `extractchunk-isolation-test.ts`.
 */
export async function extractChunk(
  db: Db,
  chunk: { id: number; content: string },
  ctx: ChunkContext,
): Promise<ExtractChunkResult> {
  let factsPersisted = 0;
  let factsQuarantined = 0;
  try {
    // extractFacts may return ExtractedFact[] (today) or {facts, commitments, reversals} (once the
    // prompt emits the new channels). Normalize so both shapes route — and so the existing
    // array-returning test mocks keep working.
    const extracted: any = await extractFacts(chunk.content, ctx.speaker, ctx.interactionId, ctx.extractCtx);
    const facts = Array.isArray(extracted) ? extracted : (extracted?.facts ?? []);
    const commitments = Array.isArray(extracted) ? [] : (extracted?.commitments ?? []);
    const reversals = Array.isArray(extracted) ? [] : (extracted?.reversals ?? []);

    for (const ex of facts) {
      if (!ex?.subject || !ex?.predicate || ex?.object == null) continue; // malformed
      const shape = correctShape(String(ex.predicate), String(ex.shape ?? "single"));

      // 4a. Resolve (identity = label): subject under account; object under its owner.
      const subjectId = await resolveOrCreate(
        db, String(ex.subject), ex.subject_type, ctx.accountId, ctx.occurredAt,
        ctx.interactionId, ctx.account);
      let objectEntityId: number | null = null;
      let objectLiteral: string | null = null;
      if (ex.object_kind === "entity") {
        const ownerForObject = OWNERSHIP_PREDS.includes(String(ex.predicate).toLowerCase()) ? subjectId : ctx.accountId;
        objectEntityId = await resolveOrCreate(
          db, String(ex.object), ex.object_type, ownerForObject, ctx.occurredAt,
          ctx.interactionId, ctx.account);
      } else {
        objectLiteral = String(ex.object);
      }

      // self-loop guard
      if (objectEntityId != null && objectEntityId === subjectId) {
        logEvent("skip.selfloop", { subject: ex.subject, predicate: ex.predicate, object: ex.object });
        continue;
      }

      // Cross-chunk-suspected heuristic (ENGINE_SPEC_v5 §18): if a fact's source_span exists
      // verbatim in OTHER chunks of the same interaction but NOT in its producing chunk,
      // it's a candidate cross-chunk reconstruction. Logged only; not blocking.
      if (ex.source_span && typeof ex.source_span === "string" && ex.source_span.length > 8) {
        const inChunk = chunk.content.includes(ex.source_span);
        if (!inChunk) {
          logEvent("extract.cross_chunk_suspected",
            { interaction_id: ctx.interactionId, source_chunk_id: chunk.id, source_span: ex.source_span.slice(0, 120) });
        }
      }

      // 4b. Persist as PROVISIONAL with source_chunk_id BY CONSTRUCTION (v5 §3 primary provenance).
      const factIns = await db.query<{ id: number }>(
        `insert into facts (subject_id, predicate, object_entity_id, object_literal, shape, valid_from,
                            source_interaction_id, source_chunk_id, source_span, source_hash, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'provisional') returning id`,
        [subjectId, ex.predicate, objectEntityId, objectLiteral, shape, ctx.occurredAt,
         ctx.interactionId, chunk.id, ex.source_span ?? null, sourceHash(ex.source_span ?? String(ex.object))]);
      const incoming: Fact = {
        id: factIns.rows[0].id, subjectId, subjectLabel: String(ex.subject),
        predicate: ex.predicate, object: String(ex.object), shape, validFrom: ctx.occurredAt,
      };

      // 4c. QA — faithfulness against THE PRODUCING CHUNK (v5 §4), not the whole turn.
      const v = await faithful({ subject: String(ex.subject), predicate: ex.predicate, object: String(ex.object) }, chunk.content, ctx.speaker);
      logEvent("qa", { fact_id: incoming.id, source_chunk_id: chunk.id, subject: ex.subject, predicate: ex.predicate, object: ex.object, supported: v.ok, reason: v.reason });
      if (!v.ok) {
        await db.query(`update facts set status = 'quarantined' where id = $1`, [incoming.id]);
        if (!process.env.MNEMON_QUIET) console.log(`  ⚠ quarantined #${incoming.id} ("${ex.object}") — ${v.reason}`);
        factsQuarantined++;
        continue;
      }
      await db.query(`update facts set status = 'confirmed' where id = $1`, [incoming.id]);
      factsPersisted++;

      // 4d. Contradiction → current-state: close any open CONFIRMED fact this one supersedes.
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
        const cv = await contradicts(incoming, existing);
        logEvent("contradiction", {
          subject: ex.subject,
          incoming: { predicate: incoming.predicate, object: incoming.object },
          existing: { predicate: existing.predicate, object: existing.object },
          verdict: cv.contradicts, reason: cv.reason,
        });
        if (cv.contradicts) {
          await db.query(`update facts set valid_until = $1, superseded_by = $2 where id = $3`,
            [incoming.validFrom, incoming.id, existing.id]);
          if (!process.env.MNEMON_QUIET)
            console.log(`  ↳ superseded fact #${existing.id} ("${existing.object}") — ${cv.reason}`);
        }
      }
    }

    // 4e. COMMITMENTS — directed obligations routed to their own table (COMMITMENTS_DESIGN_v1).
    //   A new commitment → a row keyed on (owner, about); a reversal flips the matching row's status.
    //   owner/recipient/about reuse the SAME entity resolver as facts, so paraphrase ("rollout" ≈
    //   "migration") collapses to one `about` node and the reversal finds its commitment.
    for (const c of commitments) {
      if (!c?.owner || !c?.action) continue;
      const ownerId = await resolveOrCreate(db, String(c.owner), c.owner_type, ctx.accountId, ctx.occurredAt, ctx.interactionId, ctx.account);
      const recipientId = c.recipient
        ? await resolveOrCreate(db, String(c.recipient), c.recipient_type, ctx.accountId, ctx.occurredAt, ctx.interactionId, ctx.account)
        : null;
      const aboutId = c.about
        ? await resolveOrCreate(db, String(c.about), c.about_type, ctx.accountId, ctx.occurredAt, ctx.interactionId, ctx.account)
        : null;
      const cid = await createCommitment(db, {
        ownerId, recipientId, aboutId, action: String(c.action), dueAt: isoOrNull(c.due),
        modality: c.modality, validFrom: ctx.occurredAt, sourceInteractionId: ctx.interactionId,
        sourceSpan: c.source_span ?? null, sourceChunkId: chunk.id,
      });
      // QA gate (mirror facts §4c): a commitment the source doesn't support is quarantined — kept for
      // audit, but `qa_status != 'confirmed'` so it never drives recall (recall.ts filters confirmed).
      const cv = await faithful(
        { subject: String(c.owner), predicate: c.modality ? `commits to (${c.modality})` : "commits to", object: String(c.action) },
        chunk.content, ctx.speaker);
      if (!cv.ok) {
        await db.query(`update commitments set qa_status = 'quarantined' where id = $1`, [cid]);
        if (!process.env.MNEMON_QUIET) console.log(`  ⚠ quarantined commitment #${cid} ("${c.action}") — ${cv.reason}`);
      }
      logEvent("commitment.created", { id: cid, owner: c.owner, recipient: c.recipient ?? null, about: c.about ?? null, action: c.action, qa_supported: cv.ok });
    }
    for (const r of reversals) {
      if (!r?.owner || !r?.status) continue;
      // QA gate: an unsupported reversal must NOT flip a real commitment — verify before applying.
      const rv = await faithful(
        { subject: String(r.owner), predicate: `reversal: ${r.status}`, object: String(r.about ?? r.status) },
        chunk.content, ctx.speaker);
      if (!rv.ok) {
        logEvent("commitment.reversal_quarantined", { owner: r.owner, about: r.about ?? null, status: r.status, reason: rv.reason });
        continue;
      }
      const ownerId = await resolveOrCreate(db, String(r.owner), undefined, ctx.accountId, ctx.occurredAt, ctx.interactionId, ctx.account);
      const aboutId = r.about
        ? await resolveOrCreate(db, String(r.about), undefined, ctx.accountId, ctx.occurredAt, ctx.interactionId, ctx.account)
        : null;
      const matched = await applyReversal(db, {
        ownerId, aboutId, status: r.status, at: ctx.occurredAt,
        sourceInteractionId: ctx.interactionId, sourceSpan: r.source_span ?? null,
      });
      logEvent("commitment.reversal", { owner: r.owner, about: r.about ?? null, status: r.status, matched });
    }

    // Mark chunk as extracted — empty facts is legit (the extractor found nothing durable).
    await db.query(`update chunks set extraction_status = 'extracted' where id = $1`, [chunk.id]);
    return { chunk_id: chunk.id, facts_persisted: factsPersisted, facts_quarantined: factsQuarantined, status: "extracted" };
  } catch (e: any) {
    // A5 chunk-level isolation: per-chunk failure cannot propagate to other chunks.
    const errStr = String(e?.message ?? e);
    logEvent("ingest.chunk_extract_failed", { interaction_id: ctx.interactionId, chunk_id: chunk.id, error: errStr });
    try {
      await db.query(`update chunks set extraction_status = 'quarantined' where id = $1`, [chunk.id]);
    } catch (dbErr: any) {
      // Belt-and-braces: legacy store without the extraction_status column degrades to today's behavior.
      logEvent("ingest.quarantine_write_failed", { chunk_id: chunk.id, error: String(dbErr?.message ?? dbErr) });
    }
    return { chunk_id: chunk.id, facts_persisted: 0, facts_quarantined: 0, status: "quarantined", error: errStr };
  }
}

export async function ingest(db: Db, it: Interaction, opts: IngestOpts = {}): Promise<IngestResult> {
  // 1. archive verbatim (append-only) — first, before anything that can fail.
  const ins = await db.query<{ id: number }>(
    `insert into interactions (content, speaker, occurred_at) values ($1, $2, $3) returning id`,
    [it.content, it.speaker, it.occurred_at]);
  const interactionId = ins.rows[0].id;

  // 1b. L0 floor: chunk + embed + store the verbatim (keyword + vector indexed).
  // Collect (id, content) so per-chunk extraction can attach source_chunk_id by construction.
  const pieces = chunkText(it.content);
  const chunkRecords: { id: number; content: string }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const vec = toVector(await embed(pieces[i]));
    const r = await db.query<{ id: number }>(
      `insert into chunks (interaction_id, ord, content, embedding) values ($1, $2, $3, $4::vector) returning id`,
      [interactionId, i, pieces[i], vec]);
    chunkRecords.push({ id: r.rows[0].id, content: pieces[i] });
  }

  // Bridge fix: track per-chunk and outer-loop failures so the caller can surface them
  // (W-MNEMON-26). Visibility is the close; data-layer quarantine state deferred to v6.
  let failedChunks = 0;
  let outerError: string | null = null;

  // Verbatim + chunks are CONFIRMED at L0 above. Per-chunk extraction is best-effort; a flaky
  // LLM call on one chunk must NOT lose facts from other chunks (per-chunk failure isolation).
  try {
    // Lock 2: resolve the Owner + AI personas from opts (env as fallback) so identity is
    // anchored deterministically, not guessed by the extractor.
    const ownerName = opts.owner ?? process.env.MNEMON_OWNER ?? null;
    const aiPersonas = opts.aiPersonas ??
      (process.env.MNEMON_AI_PERSONAS?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [];
    const aiSet = new Set(aiPersonas.map((s) => normLabel(s)));
    const isOwner = (name: string) => !!ownerName && normLabel(name) === normLabel(ownerName);

    // Owner scope for this conversation's dependent entities (explicit; Ownership v2 §7.1).
    // Lock 2: when the account IS the Owner, it is a Person:Human — not the hardcoded 'org'.
    const accountType = opts.account && isOwner(opts.account) ? "Person:Human" : "org";
    const accountId = opts.account
      ? await resolveOrCreate(db, opts.account, accountType, null, it.occurred_at, interactionId)
      : null;

    // Lock 4 + Lock 2: anchor the speaker's identity sub-kind before extraction so it is never
    // guessed — the Owner is Person:Human; a configured AI persona is Persona:AI.
    if (it.speaker) {
      const spType = isOwner(it.speaker) ? "Person:Human"
        : aiSet.has(normLabel(it.speaker)) ? "Persona:AI" : null;
      if (spType) await resolveOrCreate(db, it.speaker, spType, accountId, it.occurred_at, interactionId, opts.account ?? null);
    }

    // 2. Gather context once so all per-chunk extractions reuse, not re-mint.
    const ctxEntities = (await db.query<{ label: string; type: string }>(
      `select label, type from entities order by id desc limit 100`)).rows;
    const ctxPredicates = (await db.query<{ predicate: string }>(
      `select distinct predicate from facts limit 100`)).rows.map((r) => r.predicate);
    const ctx = { entities: ctxEntities, predicates: ctxPredicates, account: opts.account ?? null,
      owner: ownerName, ai_personas: aiPersonas };

    // 3. PER-CHUNK EXTRACTION — delegated to extractChunk() so Z2's standalone worker can reuse
    //    the same per-chunk body verbatim (DECOUPLING_IMPL_SPEC_v2 §10 Task 5). Each chunk:
    //    extract → resolve → persist provisional → faithfulness QA → contradiction. Per-chunk
    //    failure isolation lives INSIDE extractChunk() (A5 regression guard:
    //    extractchunk-isolation-test.ts). Parallel by default (Promise.all in batches of
    //    EXTRACT_MAX_CONCURRENCY); sequential via MNEMON_EXTRACT_SEQUENTIAL=1.
    const sequential = process.env.MNEMON_EXTRACT_SEQUENTIAL === "1";
    const chunkCtx: ChunkContext = {
      interactionId,
      speaker: it.speaker,
      occurredAt: it.occurred_at,
      account: opts.account ?? null,
      accountId,
      extractCtx: ctx,
    };
    const chunkResults: ExtractChunkResult[] = [];
    if (sequential) {
      for (const c of chunkRecords) chunkResults.push(await extractChunk(db, c, chunkCtx));
    } else {
      for (let i = 0; i < chunkRecords.length; i += EXTRACT_MAX_CONCURRENCY) {
        const batch = chunkRecords.slice(i, i + EXTRACT_MAX_CONCURRENCY);
        chunkResults.push(...await Promise.all(batch.map((c) => extractChunk(db, c, chunkCtx))));
      }
    }
    failedChunks = chunkResults.filter((r) => r.status === "quarantined" && r.error).length;

    // 5. L5 Diary rebuild from CONFIRMED facts (deterministic, lossless, heavy-refs).
    await buildDiary(db, it.occurred_at);
  } catch (e) {
    // Outer catch — only fires for non-extract failures (e.g. resolve/persist DB errors,
    // faithful() throws, contradicts() throws, Diary build throws). Per-chunk extract
    // failures are caught above and don't reach here.
    // Bridge fix: capture the error string so the caller can surface it (was: silent log only).
    outerError = String(e);
    logEvent("ingest.extract_failed", { interaction_id: interactionId, error: outerError });
  }

  return {
    total_chunks: chunkRecords.length,
    failed_chunks: failedChunks,
    outer_error: outerError,
  };
}
