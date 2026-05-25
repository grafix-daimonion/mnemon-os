// recall.ts — the read path, as an EXPLICIT, code-enforced sequence of single-job steps.
// The LLM has freedom WITHIN a step; the code owns the track. One job per step, each
// logged, so a failure localizes to exactly one line.
//
//   STEP 1  subject     (LLM)  who is this about?
//   STEP 2  candidates  (SQL)  time-filtered facts            <- the bi-temporal moat
//   STEP 3  pick+answer (LLM)  which fact answers it?
//   STEP 4  absence     (SQL)  honest-empty ONLY if the source is silent
//
// The LLM may say "no fact resolved" — it may NOT declare "there is nothing." That
// verdict is the deterministic source scan (Step 4), grounding honest-empty in the
// verbatim. Source mentions it but nothing resolved => "unresolved", never false-empty.
import type { PGlite } from "@electric-sql/pglite";
import { llmJSON } from "./llm.ts";
import { logEvent } from "./logger.ts";

export interface RecallResult {
  type: "answer" | "honest_empty" | "unresolved";
  answer?: string;
  anchor?: string;
  source_occurred_at?: string;
  reason?: string;
}

const toISO = (v: any): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// Predicates that mean "this is the subject's" — walked when gathering candidates, so a question
// about an owner reaches facts on the things it owns (Acme -> contract -> renewal date).
const TRAVERSAL_PREDS = ["has", "owns", "part of", "runs", "leads", "member of", "responsible for", "works on"];

// STEP 1 — LLM, one job: name the subject.
async function subjectOf(question: string): Promise<string | null> {
  const j = await llmJSON(
    `Extract the main subject (a person or org name) the question asks about. Return JSON {subject: string|null}.`,
    question);
  return j?.subject ?? null;
}

// STEP 2 — SQL, one job: the bi-temporal selection of candidate facts.
async function selectFacts(db: PGlite, subject: string, asOf: string | null): Promise<any[]> {
  const ent = await db.query<{ id: number }>(
    `select id from entities where lower(label) = lower($1) limit 1`, [subject]);
  if (!ent.rows.length) return [];
  const subjectId = ent.rows[0].id;
  // scope = the subject + everything it owns (ownership-edge descendants, bounded depth) — so a
  // question about Acme reaches the renewal date sitting on Acme's contract one hop down.
  const asOfClause = asOf
    ? `f.valid_from <= $3 and (f.valid_until is null or f.valid_until > $3)`
    : `f.valid_until is null`;
  const params = asOf ? [subjectId, TRAVERSAL_PREDS, asOf] : [subjectId, TRAVERSAL_PREDS];
  const res = await db.query<any>(
    `with recursive scope(id, depth) as (
        select $1::bigint, 0
        union all
        select f.object_entity_id, s.depth + 1
        from scope s
        join facts f on f.subject_id = s.id
        where f.object_entity_id is not null and lower(f.predicate) = any($2) and s.depth < 3
     )
     select f.predicate, f.object_literal, oe.label as object_entity_label, sj.label as subject_label,
            i.content as src_content, i.occurred_at as src_occurred_at
     from facts f
     join entities sj on sj.id = f.subject_id
     join interactions i on i.id = f.source_interaction_id
     left join entities oe on oe.id = f.object_entity_id
     where f.subject_id in (select id from scope) and ${asOfClause}
     order by f.valid_from desc`, params);
  return res.rows.map((r) => ({ ...r, object_display: r.object_literal ?? r.object_entity_label }));
}

// STEP 3 — LLM, one job: pick the relevant fact and read its stance.
async function answerFrom(question: string, facts: any[]): Promise<{ answer: string; index: number }> {
  const list = facts.map((f, i) => ({ index: i, about: f.subject_label, topic: f.predicate, value: f.object_display }));
  const j = await llmJSON(
    `Answer the question using the listed facts (each is "about" a subject or something it owns).
Return JSON {answer, index}.
Pick the SINGLE most relevant fact. A fact is relevant if it concerns the same topic as the question,
EVEN IF worded differently (e.g. "team commitment to SSO deadline = will meet" answers
"Did Alice agree to the SSO deadline?"). Use index -1 ONLY if no listed fact is even topically related.
- index: the array index of the fact you used (or -1).
- answer: for a yes/no question, infer from the fact's STANCE ("yes"/"no"); otherwise the short value.
  Interpret reasonably; do NOT refuse over wording or missing detail
  (e.g. "will be done by Q2" answers "on time?" as "yes").`,
    JSON.stringify({ question, facts: list }));
  return {
    answer: String(j?.answer ?? "").toLowerCase(),
    index: Number.isInteger(j?.index) ? j.index : -1,
  };
}

// STEP 4 — L0 FLOOR: keyword-search the verbatim chunks. This is both the absence arbiter AND a real
// fallback answer when the fact layer missed — no clean subject required. (Vector search joins here
// once the embedder lands.)
async function searchChunks(db: PGlite, question: string, asOf: string | null): Promise<any[]> {
  const where = asOf ? `and i.occurred_at <= $2` : ``;
  const params = asOf ? [question, asOf] : [question];
  const res = await db.query<any>(
    `select c.content, i.occurred_at as src_occurred_at
     from chunks c join interactions i on i.id = c.interaction_id
     where to_tsvector('english', c.content) @@ plainto_tsquery('english', $1) ${where}
     order by i.occurred_at desc, ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) desc
     limit 5`, params);
  return res.rows;
}

// LLM, one job: answer from the retrieved verbatim excerpts (the user's own words), or say unknown.
async function answerFromChunks(question: string, chunks: any[]): Promise<{ answer: string; index: number }> {
  const list = chunks.map((c, i) => ({ index: i, excerpt: c.content }));
  const j = await llmJSON(
    `Answer the question using ONLY the listed source excerpts (the user's own words). Return JSON {answer, index}.
- index: the array index of the excerpt you used, or -1 if none answers it.
- answer: a short direct answer drawn from that excerpt; "unknown" if the excerpts don't answer it.`,
    JSON.stringify({ question, excerpts: list }));
  return {
    answer: String(j?.answer ?? "").trim(),
    index: Number.isInteger(j?.index) ? j.index : -1,
  };
}

async function run(db: PGlite, question: string, asOf: string | null): Promise<RecallResult> {
  // STEP 1
  const subject = await subjectOf(question);
  logEvent("recall.subject", { question, asOf, subject });

  // STEP 2
  const facts = subject ? await selectFacts(db, subject, asOf) : [];
  logEvent("recall.candidates", { subject, count: facts.length });

  // STEP 3
  let pick = { answer: "", index: -1 };
  if (facts.length) pick = await answerFrom(question, facts);
  logEvent("recall.pick", { index: pick.index, answer: pick.answer });

  const resolved = pick.index >= 0 && pick.index < facts.length && pick.answer && pick.answer !== "unknown";
  if (resolved) {
    const chosen = facts[pick.index];
    return { type: "answer", answer: pick.answer, anchor: chosen.src_content, source_occurred_at: toISO(chosen.src_occurred_at) };
  }

  // STEP 4 — L0 FLOOR: the fact layer didn't resolve. Fall back to the verbatim chunks.
  const chunks = await searchChunks(db, question, asOf);
  logEvent("recall.floor", { chunk_hits: chunks.length });
  if (chunks.length) {
    const fa = await answerFromChunks(question, chunks);
    logEvent("recall.floor_pick", { index: fa.index, answer: fa.answer });
    if (fa.index >= 0 && fa.index < chunks.length && fa.answer && fa.answer.toLowerCase() !== "unknown") {
      const c = chunks[fa.index];
      return { type: "answer", answer: fa.answer, anchor: c.content, source_occurred_at: toISO(c.src_occurred_at) };
    }
    // the source mentions it, but no clear answer resolved — honest, never fabricated
    return { type: "unresolved", reason: "the source mentions this, but no clear answer resolved" };
  }
  // nothing in the source at all
  return { type: "honest_empty", reason: "no evidence in source" };
}

export const recall = (db: PGlite, q: string) => run(db, q, null);
export const recallAsOf = (db: PGlite, q: string, asOf: string) => run(db, q, asOf);
