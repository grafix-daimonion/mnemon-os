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
  const where = asOf
    ? `f.subject_id = $1 and f.valid_from <= $2 and (f.valid_until is null or f.valid_until > $2)`
    : `f.subject_id = $1 and f.valid_until is null`;
  const params = asOf ? [subjectId, asOf] : [subjectId];
  const res = await db.query<any>(
    `select f.predicate, f.object_literal, oe.label as object_entity_label,
            i.content as src_content, i.occurred_at as src_occurred_at
     from facts f join interactions i on i.id = f.source_interaction_id
     left join entities oe on oe.id = f.object_entity_id
     where ${where} order by f.valid_from desc`, params);
  return res.rows.map((r) => ({ ...r, object_display: r.object_literal ?? r.object_entity_label }));
}

// STEP 3 — LLM, one job: pick the relevant fact and read its stance.
async function answerFrom(question: string, facts: any[]): Promise<{ answer: string; index: number }> {
  const list = facts.map((f, i) => ({ index: i, topic: f.predicate, value: f.object_display }));
  const j = await llmJSON(
    `Answer the question using the listed facts about the subject. Return JSON {answer, index}.
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

// STEP 4 — SQL, one job: the ABSENCE verdict. The LLM does not get a vote here.
// Embedding-free keyword scan over the verbatim: if the source never mentions it, it is empty.
async function sourceHasEvidence(db: PGlite, question: string): Promise<boolean> {
  const hit = await db.query(
    `select 1 from interactions where to_tsvector('english', content) @@ plainto_tsquery('english', $1) limit 1`,
    [question]);
  return hit.rows.length > 0;
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

  // STEP 4 — absence is decided here, by the source, not by the LLM above.
  const hasEvidence = await sourceHasEvidence(db, question);
  logEvent("recall.absence", { source_has_evidence: hasEvidence, verdict: hasEvidence ? "unresolved" : "honest_empty" });
  return hasEvidence
    ? { type: "unresolved", reason: "the source mentions this, but no structured fact resolved it (worded differently?)" }
    : { type: "honest_empty", reason: "no evidence in source" };
}

export const recall = (db: PGlite, q: string) => run(db, q, null);
export const recallAsOf = (db: PGlite, q: string, asOf: string) => run(db, q, asOf);
