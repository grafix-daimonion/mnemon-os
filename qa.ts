// qa.ts — the extraction-accuracy / stability harness.
// Three separate measurements (kept apart so each says what failed):
//   bun run qa.ts            -> stability (N eval runs) + extraction drift (K runs/note)
//   bun run qa.ts review     -> manual QA: dump "note -> facts" from the decision log
// Args: bun run qa.ts [N] [K]   (defaults N=3 runs, K=3 extractions/note)
process.env.MNEMON_QUIET = "1"; // silence per-fact pipeline chatter; we want the report

import { readFileSync } from "node:fs";
import { runAllFixtures } from "./eval-core.ts";
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { logPath } from "./logger.ts";

const mode = process.argv[2];

if (mode === "review") {
  // Manual QA surface: every extraction, as note -> facts, for the human to judge.
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  for (const l of lines) {
    const e = JSON.parse(l);
    if (e.type !== "extract") continue;
    console.log(`\nNOTE: ${e.content}`);
    for (const f of e.facts ?? [])
      console.log(`   • ${f.subject} —[${f.predicate}]→ ${f.object}  (${f.object_kind}/${f.shape})`);
  }
  process.exit(0);
}

const RUNS = Number(process.argv[2] ?? 3);
const K = Number(process.argv[3] ?? 3);

// 1) STABILITY — run the whole eval N times; report per-case pass-rate.
const tally = new Map<string, { pass: number; total: number }>();
for (let i = 0; i < RUNS; i++) {
  const results = await runAllFixtures();
  for (const r of results) {
    const k = `${r.fixture}/${r.id}`;
    const t = tally.get(k) ?? { pass: 0, total: 0 };
    t.pass += r.ok ? 1 : 0; t.total++;
    tally.set(k, t);
  }
}
console.log(`\n=== STABILITY  (${RUNS} runs) ===`);
let stable = 0;
for (const [k, t] of tally) {
  const ok = t.pass === t.total;
  if (ok) stable++;
  console.log(`  [${ok ? "stable" : "FLAKY "}] ${t.pass}/${t.total}  ${k}`);
}
console.log(`  -> ${stable}/${tally.size} cases stable across ${RUNS} runs`);

// 2) EXTRACTION DRIFT — extract the same note K times; count distinct wordings.
const probes = [
  "Bob said the API migration will be done by Q2.",
  "Alice manages Bob, and they both work at Acme on the SSO project.",
];
console.log(`\n=== EXTRACTION DRIFT  (${K} runs/note) ===`);
for (const note of probes) {
  const sets = new Set<string>();
  const counts: number[] = [];
  for (let i = 0; i < K; i++) {
    const db = await initDb();
    try {
      await ingest(db, { content: note, speaker: "user", occurred_at: "2026-05-01T10:00:00Z" });
      const preds = (await db.query<{ predicate: string }>(`select predicate from facts order by predicate`))
        .rows.map((r) => r.predicate);
      sets.add(JSON.stringify(preds));
      counts.push(preds.length);
    } finally {
      await db.close();
    }
  }
  console.log(`\n  NOTE: ${note}`);
  console.log(`     facts/run: ${counts.join(", ")}   distinct wordings: ${sets.size} ${sets.size === 1 ? "(stable)" : "(DRIFT)"}`);
  for (const s of sets) console.log(`       - [${JSON.parse(s).join(" | ")}]`);
}
process.exit(0);
