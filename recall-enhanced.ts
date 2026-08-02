// Enhanced Recall with Three-Verdict System and Fast Path
// Adds "unresolved" state to distinguish "no answer" from "no evidence"
// Includes Class 2 fast recall for zero-cost deterministic queries

import type { PGlite } from "@electric-sql/pglite";

// Three-verdict system (enhancement from original two-verdict)
export interface RecallResult {
  type: "answer" | "honest_empty" | "unresolved"; // Added "unresolved"
  answer?: string;
  anchor?: string;
  source_occurred_at?: string;
  via?: "fact" | "verbatim";
  reason?: string;
  quote?: string;
}

// Fast recall candidates (Class 2 - no LLM needed)
export interface RecallCandidates {
  facts: FactCandidate[];
  chunks: ChunkCandidate[];
  docs: DocCandidate[];
}

interface FactCandidate {
  subject_label: string;
  predicate: string;
  object_value: string;
  valid_from: Date;
  source_span: string;
  source_ref?: string;
}

interface ChunkCandidate {
  content: string;
  occurred_at: Date;
  similarity?: number;
}

interface DocCandidate {
  title: string;
  content: string;
  updated_at: Date;
}

// Enhanced recall with scope isolation
export async function recall(
  db: PGlite,
  question: string,
  scopeId: number | null = null,
  asOf: Date | null = null
): Promise<RecallResult> {
  // Step 1: Extract subject (could use LLM or pattern matching)
  const subject = await extractSubject(question);

  // Step 2: Get candidates with scope filtering
  const candidates = await getCandidates(db, subject, scopeId, asOf);

  // Step 3: Check for evidence using keyword search (honest-empty arbiter)
  const hasEvidence = await checkKeywordEvidence(db, question, scopeId, asOf);

  if (!hasEvidence) {
    return {
      type: "honest_empty",
      reason: "no evidence in source"
    };
  }

  // Step 4: Try to resolve from candidates
  if (candidates.facts.length === 0 && candidates.chunks.length === 0) {
    return {
      type: "unresolved", // NEW: Evidence exists but can't resolve
      reason: "source mentions topic but no clear answer"
    };
  }

  // Step 5: Pick best answer (could use LLM or heuristics)
  const bestAnswer = await pickBestAnswer(candidates, question);

  if (!bestAnswer) {
    return {
      type: "unresolved",
      reason: "multiple candidates but none clearly answer the question"
    };
  }

  return {
    type: "answer",
    answer: bestAnswer.answer,
    anchor: bestAnswer.anchor,
    source_occurred_at: bestAnswer.source_occurred_at,
    via: bestAnswer.via,
    quote: bestAnswer.quote
  };
}

// Fast recall path (Class 2 - deterministic, no LLM)
export async function recallFast(
  db: PGlite,
  question: string,
  subject: string | null,
  scopeId: number | null = null,
  asOf: Date | null = null
): Promise<RecallCandidates> {
  // Get facts (SQL only, very fast)
  const facts = await getFactCandidates(db, subject, scopeId, asOf);

  // Get chunks (uses embeddings but no LLM)
  const chunks = await getChunkCandidates(db, question, scopeId, asOf);

  // Get wiki docs (if applicable)
  const docs = await getDocCandidates(db, question, scopeId);

  return { facts, chunks, docs };
}

// Check for keyword evidence (honest-empty arbiter)
async function checkKeywordEvidence(
  db: PGlite,
  query: string,
  scopeId: number | null,
  asOf: Date | null
): Promise<boolean> {
  // CRITICAL: Only keyword search can declare absence
  // Vector similarity gets NO vote on "there is nothing"

  let sql = `
    SELECT COUNT(*) as count
    FROM interactions i
    WHERE i.scope_id IS NOT DISTINCT FROM $1
      AND to_tsvector('english', i.content) @@ plainto_tsquery('english', $2)`;

  const params: any[] = [scopeId, query];

  if (asOf) {
    sql += ` AND i.occurred_at <= $3`;
    params.push(asOf);
  }

  const result = await db.query<{count: number}>(sql, params);
  return result.rows[0].count > 0;
}

// Get fact candidates with scope isolation
async function getFactCandidates(
  db: PGlite,
  subject: string | null,
  scopeId: number | null,
  asOf: Date | null
): Promise<FactCandidate[]> {
  if (!subject) return [];

  // Find subject entity within scope
  const entity = await db.query<{id: number}>(
    `SELECT id FROM entities
     WHERE lower(label) = lower($1)
       AND scope_id IS NOT DISTINCT FROM $2
       AND merged_into IS NULL
     LIMIT 1`,
    [subject, scopeId]
  );

  if (!entity.rows[0]) return [];

  // Get facts with bi-temporal filtering
  let sql = `
    SELECT
      e1.label as subject_label,
      f.predicate,
      COALESCE(f.object_literal, e2.label) as object_value,
      f.valid_from,
      f.source_span,
      i.source_ref
    FROM facts f
    JOIN entities e1 ON f.subject_id = e1.id
    LEFT JOIN entities e2 ON f.object_entity_id = e2.id
    JOIN interactions i ON f.source_interaction_id = i.id
    WHERE f.subject_id = $1
      AND i.scope_id IS NOT DISTINCT FROM $2`;

  const params: any[] = [entity.rows[0].id, scopeId];

  if (asOf) {
    sql += ` AND f.valid_from <= $3 AND (f.valid_until IS NULL OR f.valid_until > $3)`;
    params.push(asOf);
  } else {
    sql += ` AND f.valid_until IS NULL`;
  }

  sql += ` ORDER BY f.valid_from DESC LIMIT 20`;

  const result = await db.query<FactCandidate>(sql, params);
  return result.rows;
}

// Get chunk candidates with scope isolation
async function getChunkCandidates(
  db: PGlite,
  question: string,
  scopeId: number | null,
  asOf: Date | null,
  limit: number = 10
): Promise<ChunkCandidate[]> {
  // This would use embeddings for semantic search
  // Simplified version using keyword search

  let sql = `
    SELECT
      c.content,
      i.occurred_at,
      ts_rank(to_tsvector('english', c.content),
              plainto_tsquery('english', $1)) as rank
    FROM chunks c
    JOIN interactions i ON c.interaction_id = i.id
    WHERE i.scope_id IS NOT DISTINCT FROM $2
      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)`;

  const params: any[] = [question, scopeId];

  if (asOf) {
    sql += ` AND i.occurred_at <= $3`;
    params.push(asOf);
  }

  sql += ` ORDER BY rank DESC, i.occurred_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await db.query<ChunkCandidate>(sql, params);
  return result.rows;
}

// Get document candidates with scope isolation
async function getDocCandidates(
  db: PGlite,
  query: string,
  scopeId: number | null,
  limit: number = 5
): Promise<DocCandidate[]> {
  const sql = `
    SELECT
      title,
      content,
      updated_at
    FROM doc_index
    WHERE scope_id IS NOT DISTINCT FROM $1
      AND (title ILIKE $2 OR content ILIKE $2)
    ORDER BY updated_at DESC
    LIMIT $3`;

  const result = await db.query<DocCandidate>(
    sql,
    [scopeId, `%${query}%`, limit]
  );

  return result.rows;
}

// Extract subject from question (simplified version)
async function extractSubject(question: string): Promise<string | null> {
  // In production, this would use LLM or NER
  // Simplified pattern matching for demo

  const patterns = [
    /about ([A-Z][\w\s]+)/i,
    /([A-Z][\w\s]+)'s/i,
    /for ([A-Z][\w\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) return match[1].trim();
  }

  return null;
}

// Pick best answer from candidates (simplified)
async function pickBestAnswer(
  candidates: RecallCandidates,
  question: string
): Promise<any> {
  // In production, this would use LLM to evaluate candidates
  // Simplified heuristic for demo

  // Prefer facts over chunks
  if (candidates.facts.length > 0) {
    const fact = candidates.facts[0];
    return {
      answer: `${fact.predicate}: ${fact.object_value}`,
      anchor: fact.source_span,
      source_occurred_at: fact.valid_from.toISOString(),
      via: "fact" as const,
      quote: fact.source_span
    };
  }

  // Fall back to chunks
  if (candidates.chunks.length > 0) {
    const chunk = candidates.chunks[0];
    return {
      answer: chunk.content.slice(0, 200),
      anchor: chunk.content,
      source_occurred_at: chunk.occurred_at.toISOString(),
      via: "verbatim" as const,
      quote: chunk.content
    };
  }

  return null;
}