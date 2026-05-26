// recall-class2.ts — Class-2 read path: deterministic SQL only, NO LLM.
// The server returns RAW candidates (facts in scope + matching chunks); the host (Claude
// Code) picks the best one and reads its stance. The honest-empty arbiter stays here too
// because it is non-negotiably keyword-only (HONEST_EMPTY_SPEC_v2).
//
// Verbs exposed:
//   recallCandidates(question, subject?, as_of?, limit?) → {facts, chunks}
//   keywordEvidence(query, as_of?)                        → {has_evidence}
//   history(subject)                                       → {facts, supersessions}
//   readDiaryClass2(days?)                                 → {entries}
import type { PGlite } from "@electric-sql/pglite";
import { embed, toVector } from "./embed.ts";
import { readDiary } from "./diary.ts";
import { logEvent } from "./logger.ts";

const VEC_MAX_DIST = 0.45;
const TRAVERSAL_PREDS = ["has", "owns", "part of", "runs", "leads", "member of", "responsible for", "works on"];

const toISO = (v: any): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export interface RecallCandidate {
  fact_id: number;
  subject_label: string;
  predicate: string;
  object_display: string;
  shape: string;
  status: string;
  valid_from: string;
  valid_until: string | null;
  source_chunk_id: number | null;
  source_interaction_id: number;
  source_span: string | null;
  source_content: string;
  source_occurred_at: string;
}
export interface ChunkCandidate {
  content: string;
  source_occurred_at: string;
  source_interaction_id: number;
}
export interface CandidatesResult { facts: RecallCandidate[]; chunks: ChunkCandidate[]; }

export async function recallCandidates(
  db: PGlite, question: string,
  subject?: string | null, as_of?: string | null, limit: number = 10,
): Promise<CandidatesResult> {
  const facts: RecallCandidate[] = [];

  // FACTS — bi-temporal scope traversal from subject (current OR as_of windowed).
  if (subject) {
    const ent = await db.query<{ id: number }>(`select id from entities where lower(label) = lower($1) limit 1`, [subject]);
    if (ent.rows.length) {
      const subjectId = ent.rows[0].id;
      const asOfClause = as_of
        ? `f.valid_from <= $3 and (f.valid_until is null or f.valid_until > $3)`
        : `f.valid_until is null`;
      const params: any[] = as_of ? [subjectId, TRAVERSAL_PREDS, as_of] : [subjectId, TRAVERSAL_PREDS];
      const res = await db.query<any>(
        `with recursive scope(id, depth) as (
            select $1::bigint, 0
            union all
            select f.object_entity_id, s.depth + 1
            from scope s join facts f on f.subject_id = s.id
            where f.object_entity_id is not null and lower(f.predicate) = any($2) and s.depth < 3
         )
         select f.id as fact_id, f.predicate, f.object_literal, oe.label as object_entity_label,
                sj.label as subject_label, f.shape, f.status,
                f.valid_from, f.valid_until, f.source_chunk_id, f.source_interaction_id, f.source_span,
                i.content as source_content, i.occurred_at as source_occurred_at
         from facts f
         join entities sj on sj.id = f.subject_id
         join interactions i on i.id = f.source_interaction_id
         left join entities oe on oe.id = f.object_entity_id
         where f.subject_id in (select id from scope) and f.status = 'confirmed' and ${asOfClause}
         order by f.valid_from desc
         limit ${Math.max(1, Math.min(50, limit))}`, params);
      for (const r of res.rows) {
        facts.push({
          fact_id: r.fact_id, subject_label: r.subject_label, predicate: r.predicate,
          object_display: r.object_literal ?? r.object_entity_label ?? "",
          shape: r.shape, status: r.status,
          valid_from: toISO(r.valid_from),
          valid_until: r.valid_until ? toISO(r.valid_until) : null,
          source_chunk_id: r.source_chunk_id, source_interaction_id: r.source_interaction_id,
          source_span: r.source_span, source_content: r.source_content,
          source_occurred_at: toISO(r.source_occurred_at),
        });
      }
    }
  }

  // CHUNKS — hybrid vector + keyword search; merge/dedup; recency-bias.
  const qvec = toVector(await embed(question));
  const vWhere = as_of ? `and i.occurred_at <= $2` : ``;
  const vParams: any[] = as_of ? [qvec, as_of] : [qvec];
  const vres = await db.query<any>(
    `select c.content, i.occurred_at as source_occurred_at, i.id as source_interaction_id
     from chunks c join interactions i on i.id = c.interaction_id
     where c.embedding is not null and (c.embedding <=> $1::vector) < ${VEC_MAX_DIST} ${vWhere}
     order by c.embedding <=> $1::vector limit 5`, vParams);
  const kWhere = as_of ? `and i.occurred_at <= $2` : ``;
  const kParams: any[] = as_of ? [question, as_of] : [question];
  const kres = await db.query<any>(
    `select c.content, i.occurred_at as source_occurred_at, i.id as source_interaction_id
     from chunks c join interactions i on i.id = c.interaction_id
     where to_tsvector('english', c.content) @@ plainto_tsquery('english', $1) ${kWhere}
     order by i.occurred_at desc limit 5`, kParams);
  const seen = new Set<string>();
  const chunks: ChunkCandidate[] = [];
  for (const r of [...vres.rows, ...kres.rows]) {
    if (seen.has(r.content)) continue;
    seen.add(r.content);
    chunks.push({ content: r.content, source_occurred_at: toISO(r.source_occurred_at), source_interaction_id: r.source_interaction_id });
  }
  chunks.sort((a, b) => new Date(b.source_occurred_at).getTime() - new Date(a.source_occurred_at).getTime());
  chunks.splice(6);

  logEvent("class2.recall_candidates", { question, subject, as_of, facts: facts.length, chunks: chunks.length });
  return { facts, chunks };
}

// HONEST-EMPTY ARBITER — keyword-only by mandate. Never let an LLM (or vector noise) vote on absence.
export async function keywordEvidence(
  db: PGlite, query: string, as_of?: string | null,
): Promise<{ has_evidence: boolean }> {
  const where = as_of ? `and i.occurred_at <= $2` : ``;
  const params = as_of ? [query, as_of] : [query];
  const hit = await db.query(
    `select 1 from chunks c join interactions i on i.id = c.interaction_id
     where to_tsvector('english', c.content) @@ plainto_tsquery('english', $1) ${where} limit 1`, params);
  const has_evidence = hit.rows.length > 0;
  logEvent("class2.keyword_evidence", { query, as_of, has_evidence });
  return { has_evidence };
}

export async function history(
  db: PGlite, subject: string,
): Promise<{ facts: any[]; supersessions: any[] }> {
  const ent = await db.query<{ id: number }>(`select id from entities where lower(label) = lower($1) limit 1`, [subject]);
  if (!ent.rows.length) return { facts: [], supersessions: [] };
  const subjectId = ent.rows[0].id;
  const all = await db.query<any>(
    `select f.id, f.predicate, coalesce(f.object_literal, oe.label) as object,
            f.shape, f.status, f.valid_from, f.valid_until, f.superseded_by,
            i.occurred_at as source_occurred_at
     from facts f
     join interactions i on i.id = f.source_interaction_id
     left join entities oe on oe.id = f.object_entity_id
     where f.subject_id = $1 order by f.valid_from asc`, [subjectId]);
  const facts = all.rows.map((r: any) => ({
    fact_id: r.id, predicate: r.predicate, object: r.object,
    shape: r.shape, status: r.status,
    valid_from: toISO(r.valid_from),
    valid_until: r.valid_until ? toISO(r.valid_until) : null,
    superseded_by: r.superseded_by,
    source_occurred_at: toISO(r.source_occurred_at),
  }));
  const supersessions = facts.filter((f: any) => f.superseded_by !== null)
    .map((f: any) => ({ superseded_fact_id: f.fact_id, new_fact_id: f.superseded_by, at: f.valid_until }));
  return { facts, supersessions };
}

export async function readDiaryClass2(db: PGlite, days: number = 3): Promise<{ entries: string[] }> {
  const text = await readDiary(db, days);
  return { entries: [text] };
}
