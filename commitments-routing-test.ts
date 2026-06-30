// commitments-routing-test.ts — the pipeline must ROUTE extracted commitments/reversals to the
// commitments table (createCommitment / applyReversal), keyed on the (owner, about) entities the
// resolver produces. Deterministic: the extractor is mocked to emit a commitment then a reversal
// with matching labels, so no LLM runs (exact entity match → no fuzzy/sameEntity call; facts:[] →
// no faithfulness call).
//
// Run: bun run commitments-routing-test.ts
import { mock } from "bun:test";
delete process.env.MNEMON_PG_URL; // fresh in-memory PGlite

// Mock MUST be registered before pipeline imports extract.ts.
mock.module("./extract.ts", () => ({
  extractFacts: async (content: string) => {
    if (content.includes("COMMIT"))
      return { facts: [], reversals: [], commitments: [
        { owner: "Bob", owner_type: "Person:Human", about: "API migration", about_type: "project",
          action: "finish the API migration", modality: "will", source_span: "will be done by Q2" }] };
    if (content.includes("REVERSE"))
      return { facts: [], commitments: [], reversals: [
        { owner: "Bob", about: "API migration", status: "broken", source_span: "won't finish in time" }] };
    return { facts: [], commitments: [], reversals: [] };
  },
}));

// This test isolates ROUTING, not the QA gate — accept all faithfulness checks so the marker-content
// ("COMMIT"/"REVERSE") isn't rejected. Faithfulness behaviour is covered by commitment-qa-test.ts.
mock.module("./synapsis/verify.ts", () => ({
  faithful: async () => ({ ok: true, reason: "mock-accept" }),
  sameEntity: async () => ({ ok: false, reason: "mock-no-merge" }),
  sourceHash: (_s: string) => "mockhash",
}));

const { initDb } = await import("./db.ts");
const { ingest } = await import("./pipeline.ts");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

const db = await initDb();

async function bobCommitment() {
  const r = await db.query<{ id: number; status: string }>(
    `select c.id, c.status from commitments c join entities o on o.id = c.owner_id
      where lower(o.label) = 'bob' and c.valid_until is null order by c.id desc limit 1`);
  return r.rows[0] ?? null;
}
async function bobCount() {
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from commitments c join entities o on o.id = c.owner_id
      where lower(o.label) = 'bob'`);
  return r.rows[0].n;
}

await ingest(db, { content: "COMMIT", speaker: "user", occurred_at: "2026-03-01T10:00:00Z" });
const afterCommit = await bobCommitment();
check("commitment row created after the COMMIT turn", afterCommit?.status === "open", `status=${afterCommit?.status}`);

await ingest(db, { content: "REVERSE", speaker: "user", occurred_at: "2026-04-20T10:00:00Z" });
const afterReverse = await bobCommitment();
check("reversal flipped the SAME commitment to broken", afterReverse?.status === "broken", `status=${afterReverse?.status}`);
check("same row preserved (id stable)", afterCommit && afterReverse && afterCommit.id === afterReverse.id,
  `create=${afterCommit?.id} reverse=${afterReverse?.id}`);
check("exactly one Bob commitment (reversal did not fork)", (await bobCount()) === 1, `count=${await bobCount()}`);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
