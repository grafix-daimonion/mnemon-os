// commitment-qa-test.ts — commitments/reversals must pass the SAME faithfulness gate as facts.
// "Verify, don't trust": a commitment the source doesn't support is quarantined (never drives
// recall), and an unsupported reversal must NOT flip a real commitment's status. Deterministic:
// the extractor and faithful() are mocked; faithful rejects any source carrying a marker.
//
// Run: bun run commitment-qa-test.ts
import { mock } from "bun:test";
delete process.env.MNEMON_PG_URL;

mock.module("./extract.ts", () => ({
  extractFacts: async (content: string) => {
    if (content.includes("GOODCOMMIT"))
      return { facts: [], reversals: [], commitments: [
        { owner: "Bob", owner_type: "Person:Human", about: "API migration", about_type: "project",
          action: "finish the API migration", modality: "will", source_span: "will be done by Q2" }] };
    if (content.includes("HALLUCINATED"))
      return { facts: [], reversals: [], commitments: [
        { owner: "Carol", owner_type: "Person:Human", about: "widget", about_type: "project",
          action: "ship the widget", modality: "promise", source_span: "ship the widget" }] };
    if (content.includes("BADREVERSE"))
      return { facts: [], commitments: [], reversals: [
        { owner: "Bob", about: "API migration", status: "broken", source_span: "won't finish" }] };
    if (content.includes("GOODREVERSE"))
      return { facts: [], commitments: [], reversals: [
        { owner: "Bob", about: "API migration", status: "broken", source_span: "won't finish" }] };
    return { facts: [], commitments: [], reversals: [] };
  },
}));

// faithful rejects any source text carrying a rejection marker; accepts otherwise.
mock.module("./synapsis/verify.ts", () => ({
  faithful: async (_fact: any, sourceText: string) =>
    ({ ok: !sourceText.includes("HALLUCINATED") && !sourceText.includes("UNSUPPORTED"), reason: "mock" }),
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
const qaOf = async (owner: string) => (await db.query<{ qa_status: string; status: string }>(
  `select c.qa_status, c.status from commitments c join entities o on o.id = c.owner_id
    where lower(o.label) = lower($1) order by c.id desc limit 1`, [owner])).rows[0] ?? null;

await ingest(db, { content: "GOODCOMMIT turn", speaker: "user", occurred_at: "2026-03-01T10:00:00Z" });
check("faithful commitment is CONFIRMED", (await qaOf("Bob"))?.qa_status === "confirmed", `qa=${(await qaOf("Bob"))?.qa_status}`);

await ingest(db, { content: "HALLUCINATED turn", speaker: "user", occurred_at: "2026-03-02T10:00:00Z" });
check("hallucinated commitment is QUARANTINED", (await qaOf("Carol"))?.qa_status === "quarantined", `qa=${(await qaOf("Carol"))?.qa_status}`);

await ingest(db, { content: "BADREVERSE UNSUPPORTED turn", speaker: "user", occurred_at: "2026-04-01T10:00:00Z" });
check("unsupported reversal did NOT flip the commitment", (await qaOf("Bob"))?.status === "open", `status=${(await qaOf("Bob"))?.status}`);

await ingest(db, { content: "GOODREVERSE turn", speaker: "user", occurred_at: "2026-04-20T10:00:00Z" });
check("supported reversal DID flip the commitment to broken", (await qaOf("Bob"))?.status === "broken", `status=${(await qaOf("Bob"))?.status}`);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
