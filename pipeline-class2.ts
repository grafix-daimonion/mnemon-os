// pipeline-class2.ts — Class-2 write path: NO LLM, no extraction, no QA inside the server.
// The host (Claude Code) has already extracted + QA'd the fact; this module just persists
// structured input into the bi-temporal schema. Reuses shared deterministic helpers
// (correctShape, sourceHash, chunkText, embed, buildDiary) — Class 1 files untouched.
//
// Verbs exposed:
//   archive(content, speaker, occurred_at)                       → {interaction_id, chunk_ids}
//   assertFact({subject_id, predicate, object…, source_chunk_ids, …}) → {fact_id}
//   markSuperseded(old_fact_id, new_fact_id, occurred_at)        → {ok}
import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { chunkText } from "./chunk.ts";
import { embed, toVector } from "./embed.ts";
import { buildDiary } from "./diary.ts";
import { logEvent } from "./logger.ts";

// Inlined from synapsis/verify.ts + pipeline.ts so this module pulls ZERO LLM imports —
// loading mcp-server-class2.ts must never trigger llm.ts (no API key required).
const sourceHash = (s: string): string =>
  createHash("sha256").update((s ?? "").trim().toLowerCase()).digest("hex").slice(0, 16);

const ACCUMULATOR_PREDS = new Set([
  "commitment", "commits to", "promised", "promise",
  "task", "todo", "action item",
  "responsible for", "works on",
  "has", "owns", "part of", "runs", "leads", "member of",
]);
function correctShape(predicate: string, llmShape: string): "single" | "multi" {
  if (ACCUMULATOR_PREDS.has(String(predicate ?? "").toLowerCase().trim())) return "multi";
  return llmShape === "multi" ? "multi" : "single";
}

export interface ArchiveResult { interaction_id: number; chunk_ids: number[]; }

export async function archive(
  db: PGlite, content: string, speaker: string | null, occurred_at: string,
): Promise<ArchiveResult> {
  const ins = await db.query<{ id: number }>(
    `insert into interactions (content, speaker, occurred_at) values ($1, $2, $3) returning id`,
    [content, speaker, occurred_at],
  );
  const interaction_id = ins.rows[0].id;
  const pieces = chunkText(content);
  const chunk_ids: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const vec = toVector(await embed(pieces[i]));
    const r = await db.query<{ id: number }>(
      `insert into chunks (interaction_id, ord, content, embedding) values ($1, $2, $3, $4::vector) returning id`,
      [interaction_id, i, pieces[i], vec],
    );
    chunk_ids.push(r.rows[0].id);
  }
  logEvent("class2.archive", { interaction_id, chunks: chunk_ids.length });
  return { interaction_id, chunk_ids };
}

export interface AssertFactInput {
  subject_id: number;
  predicate: string;
  object_entity_id?: number | null;
  object_literal?: string | null;
  shape?: "single" | "multi";
  source_chunk_ids: number[];
  source_span?: string | null;
  occurred_at: string;
  confidence?: number;
}

export async function assertFact(db: PGlite, f: AssertFactInput): Promise<{ fact_id: number }> {
  if (!f.source_chunk_ids?.length)
    throw new Error("assert_fact requires at least one source_chunk_id (host must archive() the turn first)");
  // Apply the accumulator-predicate shape override (commitments/tasks/ownerships are 'multi').
  const shape = correctShape(f.predicate, f.shape ?? "single");
  const source_chunk_id = f.source_chunk_ids[0];
  const r = await db.query<{ interaction_id: number }>(`select interaction_id from chunks where id=$1`, [source_chunk_id]);
  if (!r.rows.length) throw new Error(`source_chunk_id ${source_chunk_id} not found`);
  const source_interaction_id = r.rows[0].interaction_id;
  const ins = await db.query<{ id: number }>(
    `insert into facts (subject_id, predicate, object_entity_id, object_literal, shape, valid_from,
                        source_interaction_id, source_span, source_chunk_id, source_hash, status, confidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', $11) returning id`,
    [f.subject_id, f.predicate, f.object_entity_id ?? null, f.object_literal ?? null,
     shape, f.occurred_at, source_interaction_id, f.source_span ?? null, source_chunk_id,
     sourceHash(f.source_span ?? f.object_literal ?? ""), f.confidence ?? 1.0],
  );
  // Heavy-refs Diary stays in sync (deterministic, lossless, confirmed-current-state).
  await buildDiary(db, f.occurred_at);
  logEvent("class2.assert_fact", { fact_id: ins.rows[0].id, subject_id: f.subject_id, predicate: f.predicate, shape });
  return { fact_id: ins.rows[0].id };
}

export async function markSuperseded(
  db: PGlite, old_fact_id: number, new_fact_id: number, occurred_at: string,
): Promise<{ ok: boolean }> {
  const r = await db.query(
    `update facts set valid_until = $1, superseded_by = $2
     where id = $3 and valid_until is null returning id`,
    [occurred_at, new_fact_id, old_fact_id],
  );
  const ok = r.rows.length > 0;
  if (ok) await buildDiary(db, occurred_at);
  logEvent("class2.mark_superseded", { old_fact_id, new_fact_id, occurred_at, ok });
  return { ok };
}
