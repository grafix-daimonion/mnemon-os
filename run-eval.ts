// run-eval.ts — one pretty run of all fixtures (the Phase-0 gate).
import { runAllFixtures } from "./eval-core.ts";

const results = await runAllFixtures();
let pass = 0, lastFixture = "";
for (const r of results) {
  if (r.fixture !== lastFixture) { console.log(`\n=== ${r.fixture} ===`); lastFixture = r.fixture; }
  if (r.ok) pass++;
  console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.id}`);
  console.log(`        ${r.detail}`);
}
console.log(`\n=== ${pass}/${results.length} passed ===\n`);
process.exit(pass === results.length ? 0 : 1);
