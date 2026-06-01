// archive.ts — Z1 verbatim capture (DECOUPLING_IMPL_SPEC_v2 §5.1).
//
// Wraps pipeline-class2.archive() with the Decoupling v2 additions:
//   - chunks land at extraction_status='pending' via schema DEFAULT (migration 001)
//   - a synapsis_runs row is written with stage='capture', status='completed' so the
//     caller can correlate observability via the returned run_id
//
// No LLM call. Idempotency: not enforced here (Z1 is append-only by design; dedup is a
// caller concern). Returns the run_id so the caller can pair Z1 (capture) with Z2 (extract)
// observability records.

import type { Db } from "./db";
import { archive as archiveVerbatim } from "./pipeline-class2";
import { logEvent } from "./logger";

export interface ArchiveTurnResult {
  interaction_id: number;
  chunk_ids: number[];
  run_id: number;
  pending_extraction: number;
}

export async function archiveTurn(
  db: Db,
  content: string,
  speaker: string | null,
  occurred_at: string,
): Promise<ArchiveTurnResult> {
  // 1. Persist interaction + chunks + embeddings. Chunks default to extraction_status='pending'.
  const { interaction_id, chunk_ids } = await archiveVerbatim(db, content, speaker, occurred_at);

  // 2. Record the capture run. Status='completed' because Z1 is synchronous — if it throws,
  //    no row is written (matches the impl-spec contract: no half-state captures).
  const r = await db.query<{ id: number }>(
    `insert into synapsis_runs (interaction_id, stage, status, chunks_total, chunks_ok, started_at, completed_at)
     values ($1, 'capture', 'completed', $2, $2, now(), now())
     returning id`,
    [interaction_id, chunk_ids.length],
  );
  const run_id = r.rows[0].id;

  logEvent("z1.archive_turn", { interaction_id, chunks: chunk_ids.length, run_id });

  return {
    interaction_id,
    chunk_ids,
    run_id,
    pending_extraction: chunk_ids.length,
  };
}
