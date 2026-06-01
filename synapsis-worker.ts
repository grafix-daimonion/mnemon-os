// synapsis-worker.ts — Z2 standalone extraction worker (DECOUPLING_IMPL_SPEC_v2 §6 + §10 Task 7).
//
// Long-running process beside the combined MCP server. Polls for chunks at
// extraction_status='pending', runs extractChunk() per claimed chunk, and writes
// the chunk's terminal state ('extracted' | 'quarantined') from inside extractChunk().
//
// O2 LOCKED: poll every 2s (MNEMON_WORKER_POLL_MS), batch=10 (MNEMON_WORKER_BATCH).
// FOR UPDATE OF c SKIP LOCKED — forward-compat for multi-worker deployments; the
// single-worker case (Phase 1) doesn't exercise true concurrency. When two workers
// become a real shape, add a worker_id/claimed_at column via a new migration so
// claims survive the implicit-transaction boundary.
//
// Run: bun run synapsis-worker.ts
// Env:
//   MNEMON_PG_URL          — Postgres connection (Option B; required for this worker)
//   ANTHROPIC_API_KEY      — for extractFacts() LLM call
//   MNEMON_OWNER           — Lock 2: anchor Owner sub-kind for the extractor context
//   MNEMON_AI_PERSONAS     — Lock 4: comma-separated AI persona names
//   MNEMON_WORKER_POLL_MS  — poll interval (default 2000)
//   MNEMON_WORKER_BATCH    — max chunks per claim (default 10)

import { initDb } from "./db.ts";
import { extractChunk, type ChunkContext } from "./pipeline.ts";
import { logEvent } from "./logger.ts";

const POLL_INTERVAL_MS = parseInt(process.env.MNEMON_WORKER_POLL_MS ?? "2000", 10);
const BATCH_SIZE = parseInt(process.env.MNEMON_WORKER_BATCH ?? "10", 10);

if (!process.env.MNEMON_PG_URL) {
  console.error("synapsis-worker requires MNEMON_PG_URL (Postgres backend; Option B).");
  console.error("PGLite single-writer cannot run a concurrent worker beside the live MCP server.");
  process.exit(2);
}

const db = await initDb();

interface ClaimedChunk {
  chunk_id: number;
  chunk_content: string;
  interaction_id: number;
  speaker: string | null;
  occurred_at: string;
}

async function claimBatch(): Promise<ClaimedChunk[]> {
  const r = await db.query<ClaimedChunk>(
    `select c.id as chunk_id, c.content as chunk_content,
            c.interaction_id, i.speaker, i.occurred_at::text as occurred_at
       from chunks c
       join interactions i on i.id = c.interaction_id
      where c.extraction_status = 'pending'
      order by c.id
      limit $1
      for update of c skip locked`,
    [BATCH_SIZE],
  );
  return r.rows;
}

async function gatherContext(): Promise<{ entities: any[]; predicates: string[] }> {
  const entities = (await db.query<{ label: string; type: string }>(
    `select label, type from entities order by id desc limit 100`,
  )).rows;
  const predicates = (await db.query<{ predicate: string }>(
    `select distinct predicate from facts limit 100`,
  )).rows.map((r) => r.predicate);
  return { entities, predicates };
}

async function processBatch(claimed: ClaimedChunk[]): Promise<{ ok: number; failed: number }> {
  if (claimed.length === 0) return { ok: 0, failed: 0 };

  // Owner + AI personas from env (Lock 2 / Lock 4) — anchor identity sub-kinds.
  const ownerName = process.env.MNEMON_OWNER ?? null;
  const aiPersonas = process.env.MNEMON_AI_PERSONAS
    ?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  // Gather LLM extraction context once per batch (acceptable approximation; the alternative
  // is per-interaction context which costs more queries when many interactions are mixed).
  const { entities: ctxEntities, predicates: ctxPredicates } = await gatherContext();

  // Group claimed chunks by interaction so we emit one synapsis_runs row per
  // (interaction, batch) — matches the impl spec's observability shape.
  const byInteraction = new Map<number, ClaimedChunk[]>();
  for (const c of claimed) {
    if (!byInteraction.has(c.interaction_id)) byInteraction.set(c.interaction_id, []);
    byInteraction.get(c.interaction_id)!.push(c);
  }

  let totalOk = 0, totalFailed = 0;

  for (const [interactionId, chunks] of byInteraction) {
    const first = chunks[0];
    const ctx: ChunkContext = {
      interactionId,
      speaker: first.speaker,
      occurredAt: first.occurred_at,
      account: null,    // Z2 worker has no explicit --account scope (future work)
      accountId: null,
      extractCtx: {
        entities: ctxEntities,
        predicates: ctxPredicates,
        account: null,
        owner: ownerName,
        ai_personas: aiPersonas,
      },
    };

    // Open the synapsis_runs row before processing so a crash mid-batch leaves a
    // 'running' row that the next start can sweep (forward-compat for §7.6).
    const runRow = await db.query<{ id: number }>(
      `insert into synapsis_runs (interaction_id, stage, status, chunks_total)
       values ($1, 'extract', 'running', $2) returning id`,
      [interactionId, chunks.length],
    );
    const runId = runRow.rows[0].id;

    let ok = 0, failed = 0;
    for (const c of chunks) {
      const result = await extractChunk(
        db, { id: c.chunk_id, content: c.chunk_content }, ctx,
      );
      if (result.status === "extracted") ok++;
      else failed++;
    }

    // Close the run with terminal status. 'failed' only if EVERY chunk in the batch
    // quarantined; otherwise 'completed' (partial extraction is still progress).
    const status = (ok === 0 && failed > 0) ? "failed" : "completed";
    await db.query(
      `update synapsis_runs
          set status = $1, chunks_ok = $2, chunks_failed = $3, completed_at = now()
        where id = $4`,
      [status, ok, failed, runId],
    );

    totalOk += ok;
    totalFailed += failed;
  }

  logEvent("z2.batch", {
    claimed: claimed.length,
    interactions: byInteraction.size,
    chunks_ok: totalOk,
    chunks_failed: totalFailed,
  });
  return { ok: totalOk, failed: totalFailed };
}

async function main(): Promise<void> {
  console.log(`Synapsis worker (Z2) — POLL=${POLL_INTERVAL_MS}ms, BATCH=${BATCH_SIZE}`);
  console.log(`OWNER=${process.env.MNEMON_OWNER ?? "(unset)"}, AI_PERSONAS=${process.env.MNEMON_AI_PERSONAS ?? "(unset)"}`);
  console.log("Polling chunks WHERE extraction_status='pending'. Ctrl+C to stop.\n");

  // Graceful shutdown — close the DB pool on SIGINT/SIGTERM so postgres.js drains cleanly.
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${sig} — closing DB and exiting…`);
      try { await db.close(); } catch {}
      process.exit(0);
    });
  }

  while (!stopping) {
    try {
      const batch = await claimBatch();
      if (batch.length > 0) {
        const t0 = Date.now();
        const { ok, failed } = await processBatch(batch);
        const elapsed = Date.now() - t0;
        console.log(`✓ ${batch.length} chunks in ${elapsed}ms — ok=${ok} failed=${failed}`);
      }
    } catch (e: any) {
      console.error(`⚠ batch error: ${e?.message ?? e}`);
      logEvent("z2.batch_error", { error: String(e?.message ?? e) });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

await main();
