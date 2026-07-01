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
import type { Db } from "./db";
import { llmJSON } from "./llm.ts";
import { logEvent } from "./logger.ts";
import { embed, toVector } from "./embed.ts";
import { commitmentVerdict } from "./commitments.ts";

// Vector relevance gate: only chunks within this cosine distance count as a semantic hit. Looser →
// catches more paraphrase but risks false-positive honest-empty; tighter → safer. [OPEN] tune on eval.
const VEC_MAX_DIST = 0.45;

export interface RecallResult {
  type: "answer" | "honest_empty" | "unresolved";
  answer?: string;
  anchor?: string;
  source_occurred_at?: string;
  // 5-verdict surface (DECOUPLING_IMPL_SPEC_v2 §5.4 / Task 9; honest_empty stays a separate `type`):
  //   "fact"                  current-state-resolved fact (the bi-temporal moat)
  //   "verbatim"              chunk content, extraction_status='extracted', no fact resolved
  //   "verbatim_pending"      chunk content, extraction_status='pending' — Z2 not done yet,
  //                           the host should recommend "wait ~30s and ask again"
  //   "verbatim_quarantined"  chunk content, extraction_status='quarantined' — Z2 ran but
  //                           Faithfulness QA rejected the facts; verbatim is safe, manual
  //                           re_extract is opt-in
  via?: "fact" | "verbatim" | "verbatim_pending" | "verbatim_quarantined";
  reason?: string;
}

const toISO = (v: any): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// Predicates that mean "this edge leads to the subject's thing" — walked when gathering candidates,
// so a question about a person reaches facts on the referent (Acme -> contract -> renewal date;
// Bob -committed to-> API migration -target date-> Q2). Ownership edges + COMMITMENT edges: a
// commitment TO a referent is, for traversal, a link to it — otherwise an as-of question about a
// commitment goes blind when the fallback facts path runs and extraction labeled the edge
// "committed to" instead of "responsible for" (the paraphrase-reversal-asof flake). The commitments
// TABLE is still the primary path (commitmentCheck, STEP 1.5); this only hardens the fallback.
const TRAVERSAL_PREDS = ["has", "owns", "part of", "runs", "leads", "member of", "responsible for", "works on",
  "committed to", "commits to", "commitment", "promised", "promise", "agreed to", "pledged to"];

// STEP 1 — LLM, one job: name the subject.
async function subjectOf(question: string): Promise<string | null> {
  const j = await llmJSON(
    `Extract the main subject (a person or org name) the question asks about. Return JSON {subject: string|null}.`,
    question);
  return j?.subject ?? null;
}

// STEP 2 — SQL, one job: the bi-temporal selection of candidate facts. (exported for unit testing)
export async function selectFacts(db: Db, subject: string, asOf: string | null): Promise<any[]> {
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
     where f.subject_id in (select id from scope) and f.status = 'confirmed' and ${asOfClause}
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
async function searchChunks(db: Db, question: string, asOf: string | null): Promise<any[]> {
  // SEMANTIC half (vector) — catches paraphrase; relevance-gated so it doesn't return nearest-always.
  const qvec = toVector(await embed(question));
  const vWhere = asOf ? `and i.occurred_at <= $2` : ``;
  const vParams = asOf ? [qvec, asOf] : [qvec];
  const vres = await db.query<any>(
    `select c.content, c.extraction_status, i.occurred_at as src_occurred_at
     from chunks c join interactions i on i.id = c.interaction_id
     where c.embedding is not null and (c.embedding <=> $1::vector) < ${VEC_MAX_DIST} ${vWhere}
     order by c.embedding <=> $1::vector limit 5`, vParams);

  // LEXICAL half (keyword) — catches exact terms/names the vector might miss.
  const kWhere = asOf ? `and i.occurred_at <= $2` : ``;
  const kParams = asOf ? [question, asOf] : [question];
  const kres = await db.query<any>(
    `select c.content, c.extraction_status, i.occurred_at as src_occurred_at
     from chunks c join interactions i on i.id = c.interaction_id
     where to_tsvector('english', c.content) @@ plainto_tsquery('english', $1) ${kWhere}
     order by i.occurred_at desc limit 5`, kParams);

  // merge, dedup by content, recency-biased (latest = most likely current)
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const r of [...vres.rows, ...kres.rows]) {
    if (seen.has(r.content)) continue;
    seen.add(r.content);
    merged.push(r);
  }
  merged.sort((a, b) => new Date(b.src_occurred_at).getTime() - new Date(a.src_occurred_at).getTime());
  return merged.slice(0, 6);
}

// The CERTAIN absence arbiter (honest-empty spec): keyword scan over the verbatim. Vector noise gets
// no vote on "there is nothing" — only the lexical scan can declare lexical absence.
async function keywordHasEvidence(db: Db, question: string, asOf: string | null): Promise<boolean> {
  const where = asOf ? `and i.occurred_at <= $2` : ``;
  const params = asOf ? [question, asOf] : [question];
  const hit = await db.query(
    `select 1 from chunks c join interactions i on i.id = c.interaction_id
     where to_tsvector('english', c.content) @@ plainto_tsquery('english', $1) ${where} limit 1`, params);
  return hit.rows.length > 0;
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

// COMMITMENT CHECK — for a commitment question ("did X agree?", "will X finish?"), the commitment's
// status is authoritative and shadows any stale "X committed to Y" fact. Bi-temporal: with `asOf` the
// verdict reconstructs the past state (open before the reversal), so recall_as_of works too. Returns
// a verdict, or null to fall through to facts/verbatim.
async function commitmentCheck(db: Db, subject: string, question: string, asOf: string | null): Promise<RecallResult | null> {
  const ent = await db.query<{ id: number }>(
    `select id from entities where lower(label) = lower($1) limit 1`, [subject]);
  if (!ent.rows.length) return null;
  // candidate commitments the owner had made BY asOf (so we don't offer a commitment from the future).
  const asOfClause = asOf ? `and c.valid_from <= $2` : ``;
  const params = asOf ? [ent.rows[0].id, asOf] : [ent.rows[0].id];
  const rows = (await db.query<any>(
    `select c.about_id, ab.label as about, c.action
       from commitments c
       left join entities ab on ab.id = c.about_id
      where c.owner_id = $1 and c.valid_until is null and c.qa_status = 'confirmed' ${asOfClause}
      order by c.valid_from desc`, params)).rows;
  if (!rows.length) return null;

  const list = rows.map((r, i) => ({ index: i, about: r.about, action: r.action }));
  const j = await llmJSON(
    `Each item is a COMMITMENT someone made ("will do <action>", about <thing>). The question asks
whether such a commitment stands. Pick the index of the commitment the question is about — the SAME
topic counts even if worded differently ("API rollout" = "API migration"). Return JSON {index}.
Use -1 ONLY if none of them concerns the question.`,
    JSON.stringify({ question, commitments: list }));
  const idx = Number.isInteger(j?.index) ? j.index : -1;
  if (idx < 0 || idx >= rows.length) return null;

  // the verdict (and its as-of reconstruction + anchor) is computed by the commitments module.
  const v = await commitmentVerdict(db, ent.rows[0].id, rows[idx].about_id ?? null, asOf);
  if (!v) return null;
  logEvent("recall.commitment", { subject, picked: rows[idx].about, asOf, status: v.status, answer: v.answer });
  return { type: "answer", via: "fact", answer: v.answer, anchor: v.anchor, source_occurred_at: v.source_occurred_at };
}

async function run(db: Db, question: string, asOf: string | null): Promise<RecallResult> {
  // STEP 1
  const subject = await subjectOf(question);
  logEvent("recall.subject", { question, asOf, subject });

  // STEP 1.5 — a commitment's status is authoritative for commitment questions (current AND as-of;
  // the verdict reconstructs past state from status_at), shadowing any stale "X committed to Y" fact.
  if (subject && !process.env.MNEMON_NO_FACTS) {
    const cv = await commitmentCheck(db, subject, question, asOf);
    if (cv) return cv;
  }

  // STEP 2 (MNEMON_NO_FACTS forces the L0 floor — proves graceful degradation)
  const facts = (subject && !process.env.MNEMON_NO_FACTS) ? await selectFacts(db, subject, asOf) : [];
  logEvent("recall.candidates", { subject, count: facts.length });

  // STEP 3
  let pick = { answer: "", index: -1 };
  if (facts.length) pick = await answerFrom(question, facts);
  logEvent("recall.pick", { index: pick.index, answer: pick.answer });

  const resolved = pick.index >= 0 && pick.index < facts.length && pick.answer && pick.answer !== "unknown";
  if (resolved) {
    const chosen = facts[pick.index];
    return { type: "answer", via: "fact", answer: pick.answer, anchor: chosen.src_content, source_occurred_at: toISO(chosen.src_occurred_at) };
  }

  // STEP 4 — L0 FLOOR: the fact layer didn't resolve. Fall back to the verbatim chunks.
  const chunks = await searchChunks(db, question, asOf);
  logEvent("recall.floor", { chunk_hits: chunks.length });
  if (chunks.length) {
    const fa = await answerFromChunks(question, chunks);
    logEvent("recall.floor_pick", { index: fa.index, answer: fa.answer });
    if (fa.index >= 0 && fa.index < chunks.length && fa.answer && fa.answer.toLowerCase() !== "unknown") {
      const c = chunks[fa.index];
      // floor answer = timestamped evidence, NOT current-state-resolved (no bi-temporal filter on chunks).
      // 5-verdict routing: read the chunk's extraction_status so the host knows whether Z2 is in flight
      // (verbatim_pending), failed (verbatim_quarantined), or done (verbatim).
      const status = String(c.extraction_status ?? "extracted");
      const via: "verbatim" | "verbatim_pending" | "verbatim_quarantined" =
        status === "pending"     ? "verbatim_pending" :
        status === "quarantined" ? "verbatim_quarantined" :
                                   "verbatim";
      return { type: "answer", via, answer: fa.answer, anchor: c.content, source_occurred_at: toISO(c.src_occurred_at) };
    }
  }
  // ABSENCE verdict — decided by the CERTAIN keyword scan, never by vector noise (honest-empty spec).
  const kw = await keywordHasEvidence(db, question, asOf);
  logEvent("recall.absence", { keyword_evidence: kw });
  return kw
    ? { type: "unresolved", reason: "the source mentions this, but no clear answer resolved" }
    : { type: "honest_empty", reason: "no evidence in source" };
}

export const recall = (db: Db, q: string) => run(db, q, null);
export const recallAsOf = (db: Db, q: string, asOf: string) => run(db, q, asOf);
