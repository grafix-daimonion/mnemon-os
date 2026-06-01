// extractchunk-isolation-test.ts — Risk 1 mitigation per Dev review of DECOUPLING_IMPL_SPEC_v2.
//
// Tests A5 (chunk-level error isolation): when one chunk in a multi-chunk batch throws during
// extraction, the OTHER chunks must still produce facts. Worker loop must not crash on a single
// chunk failure. Failure must surface as IngestResult.failed_chunks (bridge-fix discriminant
// already in place per W-MNEMON-26).
//
// Written BEFORE Task 5 factoring per Dev review's "write the fault-injection test before task 6"
// recommendation — establishes the regression guard so a wrong factor (try/catch in the wrong
// scope) gets caught immediately.
//
// Run: bun run extractchunk-isolation-test.ts
//
// Uses bun:test mock.module to stub extract.ts and synapsis/verify.ts — deterministic + offline
// (no LLM, no ANTHROPIC_API_KEY needed).

import { mock } from "bun:test";
import { execSync } from "node:child_process";

// ── Mocks MUST be registered BEFORE the modules-under-test are imported ──

mock.module("./extract.ts", () => ({
  // Throw on chunks that contain the marker; otherwise return one synthetic fact.
  // Unique subject per chunk avoids the contradicts LLM step downstream (different
  // (subject, predicate) slot → no open-fact overlap → no judge call).
  extractFacts: async (content: string) => {
    if (content.includes("FAIL_ME")) {
      throw new Error("test-injected extraction failure (FAIL_ME marker)");
    }
    const tag = (content.match(/Subject_(\w+)/) || ["", "X"])[1];
    return [
      {
        subject: `Test_${tag}`,
        subject_type: "Person:Human",
        predicate: "test_marker",
        object: `value_${tag}`,
        object_kind: "literal",
        shape: "single",
        source_span: content.slice(0, 32),
      },
    ];
  },
}));

mock.module("./synapsis/verify.ts", () => ({
  faithful: async () => ({ ok: true, reason: "mocked: pass-through" }),
  sourceHash: (s: string) => `mock_${(s || "").length}`,
  sameEntity: () => false,
}));

// ── Provision a clean test database (independent of any live mnemon DB) ──

const TEST_DB = "mnemon_test_extractchunk_isolation";
try { execSync(`dropdb --if-exists ${TEST_DB}`, { stdio: "pipe" }); } catch {}
execSync(`createdb ${TEST_DB}`, { stdio: "pipe" });
execSync(`psql ${TEST_DB} -c 'CREATE EXTENSION IF NOT EXISTS vector;'`, { stdio: "pipe" });
process.env.MNEMON_PG_URL = `postgres://localhost/${TEST_DB}`;

// ── Now import modules-under-test (mocks are live) ──

const { initDb } = await import("./db.ts");
const { ingest } = await import("./pipeline.ts");

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
};

const db = await initDb();

// 3-chunk save: middle chunk has FAIL_ME. Each turn ≥ 280 chars so the chunker
// trips the > 800-char total threshold and turn-splits into 3 chunks.
// Each turn ~330 chars so total > 800 (chunker.ts fast-path threshold) — forces
// the turn-aware splitter to actually fire. Boilerplate Lorem ipsum padding keeps
// the per-chunk content meaty without distracting marker words.
const PAD = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Subject_A1 mentioned the renewal. Acme has been a customer since 2024 and the renewal is up in Q1 next year, terms pending.";
const FAIL_PAD = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. FAIL_ME Subject_B2 was discussed at length but the extraction call will throw. This is the chunk that the test forces into the error-recovery path.";
const PAD3 = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Subject_C3 closed the loop on the renewal terms and signed the final amendment in good order for next quarter.";

const interaction = {
  content: `Chatzi: ${PAD}\n\nPythia: ${FAIL_PAD}\n\nChatzi: ${PAD3}`,
  speaker: "Chatzi",
  occurred_at: new Date().toISOString(),
};

// Pre-check the chunker actually produces 3 chunks (else the test is ill-formed).
{
  const { chunkText } = await import("./chunk.ts");
  const chunks = chunkText(interaction.content);
  ok("precondition: chunkText splits into 3 chunks", chunks.length === 3, `got ${chunks.length}`);
}

const result = await ingest(db, interaction, { account: "Acme" });

// ── Assertions: chunk-level isolation (A5) ──

ok(
  "IngestResult.failed_chunks reports exactly 1 failure (the FAIL_ME chunk)",
  result.failed_chunks === 1,
  `failed_chunks=${result.failed_chunks}`,
);
ok(
  "IngestResult.outer_error stays null on per-chunk failure (not an outer-loop abort)",
  result.outer_error === null,
  `outer_error=${result.outer_error}`,
);

// Facts for the SUCCEEDING chunks should land. Subject labels are Test_A1, Test_C3.
const succeedingFacts = await db.query<{ count: number }>(
  `SELECT count(*)::int AS count FROM facts f
   JOIN entities e ON e.id = f.subject_id
   WHERE e.label IN ('Test_A1', 'Test_C3')`,
);
ok(
  "succeeding chunks produced facts (Test_A1 + Test_C3) despite the middle failure",
  succeedingFacts.rows[0].count >= 2,
  `count=${succeedingFacts.rows[0].count}`,
);

// The FAIL_ME chunk's "subject" (Test_B2) must NOT have produced a fact (because the
// extractFacts call threw before returning anything).
const failedFacts = await db.query<{ count: number }>(
  `SELECT count(*)::int AS count FROM facts f
   JOIN entities e ON e.id = f.subject_id
   WHERE e.label = 'Test_B2'`,
);
ok(
  "failed chunk produced NO facts (clean isolation, no partial state)",
  failedFacts.rows[0].count === 0,
  `count=${failedFacts.rows[0].count}`,
);

// Total chunks captured = 3 (verbatim is canonical even when extraction fails).
const allChunks = await db.query<{ count: number }>(
  `SELECT count(*)::int AS count FROM chunks`,
);
ok(
  "all 3 chunks captured at L0 (verbatim never lost even on extract failure)",
  allChunks.rows[0].count === 3,
  `count=${allChunks.rows[0].count}`,
);

await db.close();

// ── Summary + exit ──

console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
