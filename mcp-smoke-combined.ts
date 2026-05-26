// mcp-smoke-combined.ts — end-to-end smoke for mcp-server-combined.ts.
// The CRITICAL test: Class-1 writes (remember → server-side extract) are visible to
// Class-2 reads (recall_candidates) on the SAME store. Proves the single-attacher
// design works and the verb surfaces share data, not just a process.
//
//   ANTHROPIC_API_KEY=... bun run mcp-smoke-combined.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { rmSync } from "node:fs";

const SMOKE_DIR = join(import.meta.dir, "data", "_smoke_combined");
try { rmSync(SMOKE_DIR, { recursive: true, force: true }); } catch {}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", join(import.meta.dir, "mcp-server-combined.ts")],
  cwd: import.meta.dir,
  env: { ...process.env, MNEMON_DATA: SMOKE_DIR } as Record<string, string>,
});
const client = new Client({ name: "smoke-combined", version: "0" });
await client.connect(transport);

const parse = (r: any) => JSON.parse((r.content as any)[0].text);
const text  = (r: any) => (r.content as any)[0].text as string;
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };

// 1. All 13 verbs registered
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const expected = [
  "archive", "assert_fact", "find_entity", "history", "history_raw",
  "keyword_evidence", "mark_superseded", "read_diary", "recall",
  "recall_as_of", "recall_candidates", "remember", "resolve_or_create_entity",
].sort();
ok(`all 13 verbs registered (${tools.length})`, JSON.stringify(tools) === JSON.stringify(expected), tools.join(","));

// 2. Class-1 path: remember → server-side extract + QA
const rem = text(await client.callTool({ name: "remember", arguments: { text: "Acme's contract renewal is in November." } }));
ok("Class-1 remember works (server-side LLM)", /Remembered\.\s*\(\d+ fact\(s\) extracted\.\)/.test(rem), rem.slice(0, 80));

// 3. Class-1 recall returns the answer
const rec = text(await client.callTool({ name: "recall", arguments: { question: "When is Acme's contract renewal?" } }));
ok("Class-1 recall returns 'november'", /november/i.test(rec), rec.split("\n")[0]);

// 4. THE LOAD-BEARING TEST: Class-2 reads see Class-1 writes (shared store, single attacher)
const cand = parse(await client.callTool({
  name: "recall_candidates",
  arguments: { question: "When is Acme's contract renewal?", subject: "Acme" },
}));
ok("Class-2 recall_candidates sees Class-1's writes", cand.facts.length > 0, `facts=${cand.facts.length}, chunks=${cand.chunks.length}`);

// 5. Class-2 write path on the SAME store: archive + assert_fact
const arch = parse(await client.callTool({
  name: "archive",
  arguments: { content: "Bob's quarterly review is in December.", speaker: "user", occurred_at: "2026-05-26T10:00:00Z" },
}));
ok("Class-2 archive returns chunk_ids", arch.chunk_ids?.length > 0);

const bob = parse(await client.callTool({
  name: "resolve_or_create_entity",
  arguments: { label: "Bob", type: "person", owner_decision: { kind: "create" } },
}));
ok("Class-2 entity creation works on shared store", bob.created === true);

const fact = parse(await client.callTool({
  name: "assert_fact",
  arguments: {
    subject_id: bob.entity_id, predicate: "quarterly review", object_literal: "December", shape: "single",
    source_chunk_ids: arch.chunk_ids, source_span: "Bob's quarterly review is in December.",
    occurred_at: "2026-05-26T10:00:00Z",
  },
}));
ok("Class-2 assert_fact persists", fact.fact_id > 0);

// 6. Class-1 sees Class-2 writes (reverse direction of the shared-store invariant)
const recBob = text(await client.callTool({ name: "recall", arguments: { question: "When is Bob's quarterly review?" } }));
ok("Class-1 recall sees Class-2's writes", /december/i.test(recBob), recBob.split("\n")[0]);

// 7. Honest-empty arbiter
const ev = parse(await client.callTool({ name: "keyword_evidence", arguments: { query: "ZZZNonexistentTermXYZ" } }));
ok("keyword_evidence: absent term → has_evidence:false", ev.has_evidence === false);

// 8. History (Class-1 text version)
const hist = text(await client.callTool({ name: "history", arguments: { subject: "Acme" } }));
ok("history (Class-1 text) returns a timeline for Acme", hist.length > 0 && !/^No history/.test(hist), hist.split("\n")[0]?.slice(0, 60));

// 9. history_raw (Class-2 structured version)
const histRaw = parse(await client.callTool({ name: "history_raw", arguments: { subject: "Bob" } }));
ok("history_raw (Class-2 JSON) returns {facts, supersessions} for Bob", Array.isArray(histRaw.facts) && Array.isArray(histRaw.supersessions), `${histRaw.facts.length} facts`);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
