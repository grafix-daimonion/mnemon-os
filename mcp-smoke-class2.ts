// mcp-smoke-class2.ts — end-to-end smoke for the Class-2 server.
// Spawns the server the way Claude Code would (stdio), exercises the host-driven flow:
//   archive → resolve_or_create_entity → assert_fact → recall_candidates →
//   keyword_evidence (yes + no) → find_entity (hit + miss) → mark_superseded → history.
// NO API KEY needed — Class 2 has no LLM in the server.
//   bun run mcp-smoke-class2.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { rmSync } from "node:fs";

// fresh smoke store so results are deterministic
const SMOKE_DIR = join(import.meta.dir, "data", "_smoke_class2");
try { rmSync(SMOKE_DIR, { recursive: true, force: true }); } catch {}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", join(import.meta.dir, "mcp-server-class2.ts")],
  cwd: import.meta.dir,
  env: { ...process.env, MNEMON_DATA: SMOKE_DIR } as Record<string, string>,
});
const client = new Client({ name: "smoke-class2", version: "0" });
await client.connect(transport);

const parse = (r: any) => JSON.parse((r.content as any)[0].text);
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };

// 1. list tools — all 10 must be present (9 original + unmark_superseded from F-MNEMON-22)
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const expected = ["archive", "assert_fact", "find_entity", "history", "keyword_evidence", "mark_superseded", "read_diary", "recall_candidates", "resolve_or_create_entity", "unmark_superseded"].sort();
ok(`tools listed (${tools.length})`, JSON.stringify(tools) === JSON.stringify(expected), tools.join(","));

// 2. archive a turn
const arch = parse(await client.callTool({
  name: "archive",
  arguments: { content: "Acme's contract renewal is in November.", speaker: "user", occurred_at: "2026-05-26T10:00:00Z" },
}));
ok("archive returns interaction_id + chunk_ids", arch.interaction_id > 0 && arch.chunk_ids.length > 0, JSON.stringify(arch));

// 3. resolve_or_create_entity (host says: create new)
const acme = parse(await client.callTool({
  name: "resolve_or_create_entity",
  arguments: { label: "Acme", type: "org", owner_decision: { kind: "create" } },
}));
ok("resolve_or_create_entity creates Acme", acme.created === true && acme.entity_id > 0, `#${acme.entity_id}`);

// 4. host asserts a fact (no LLM in server)
const fact = parse(await client.callTool({
  name: "assert_fact",
  arguments: {
    subject_id: acme.entity_id, predicate: "contract renewal", object_literal: "November",
    shape: "single", source_chunk_ids: arch.chunk_ids,
    source_span: "Acme's contract renewal is in November.", occurred_at: "2026-05-26T10:00:00Z",
  },
}));
ok("assert_fact returns fact_id", fact.fact_id > 0, `#${fact.fact_id}`);

// 5. recall_candidates returns the fact + relevant chunks
const cand = parse(await client.callTool({
  name: "recall_candidates",
  arguments: { question: "When is Acme's contract renewal?", subject: "Acme" },
}));
ok("recall_candidates returns the fact", cand.facts.length >= 1 && cand.facts[0].object_display === "November", `${cand.facts.length} facts / ${cand.chunks.length} chunks`);

// 6. keyword_evidence — yes case + honest-empty case
const ev_y = parse(await client.callTool({ name: "keyword_evidence", arguments: { query: "Acme" } }));
const ev_n = parse(await client.callTool({ name: "keyword_evidence", arguments: { query: "ZZZNonexistentTermXYZ" } }));
ok("keyword_evidence: 'Acme' → has_evidence:true", ev_y.has_evidence === true);
ok("keyword_evidence: nonexistent → has_evidence:false (honest-empty floor)", ev_n.has_evidence === false);

// 7. find_entity — exact hit + miss (with no near matches)
const fe_hit = parse(await client.callTool({ name: "find_entity", arguments: { label: "Acme" } }));
const fe_miss = parse(await client.callTool({ name: "find_entity", arguments: { label: "TotallyDifferentEntityXYZ" } }));
ok("find_entity: exact hit on Acme", fe_hit.exact_id === acme.entity_id);
ok("find_entity: miss returns no exact/alias and (possibly) no near matches", !fe_miss.exact_id && !fe_miss.alias_id, JSON.stringify(fe_miss));

// 8. mark_superseded — assert a second fact then close the first
const arch2 = parse(await client.callTool({
  name: "archive",
  arguments: { content: "Acme's contract renewal moved to December.", speaker: "user", occurred_at: "2026-05-27T10:00:00Z" },
}));
const fact2 = parse(await client.callTool({
  name: "assert_fact",
  arguments: {
    subject_id: acme.entity_id, predicate: "contract renewal", object_literal: "December",
    shape: "single", source_chunk_ids: arch2.chunk_ids,
    source_span: "Acme's contract renewal moved to December.", occurred_at: "2026-05-27T10:00:00Z",
  },
}));
const sup = parse(await client.callTool({
  name: "mark_superseded",
  arguments: { old_fact_id: fact.fact_id, new_fact_id: fact2.fact_id, occurred_at: "2026-05-27T10:00:00Z" },
}));
ok("mark_superseded: closed the November fact", sup.ok === true);

// 9. recall_candidates now → only the December fact is current
const cand_now = parse(await client.callTool({
  name: "recall_candidates",
  arguments: { question: "When is Acme's contract renewal?", subject: "Acme" },
}));
ok("recall_candidates (now): only December is current", cand_now.facts.length === 1 && cand_now.facts[0].object_display === "December", `${cand_now.facts.length} facts`);

// 10. recall_candidates as_of 2026-05-26 → November was current
const cand_then = parse(await client.callTool({
  name: "recall_candidates",
  arguments: { question: "When is Acme's contract renewal?", subject: "Acme", as_of: "2026-05-26T12:00:00Z" },
}));
ok("recall_candidates (as_of May 26): November was current then", cand_then.facts.length === 1 && cand_then.facts[0].object_display === "November", `${cand_then.facts.length} facts`);

// 11. history — both facts + the supersession
const hist = parse(await client.callTool({ name: "history", arguments: { subject: "Acme" } }));
ok("history: returns both facts", hist.facts.length === 2);
ok("history: records the supersession", hist.supersessions.length === 1 && hist.supersessions[0].superseded_fact_id === fact.fact_id);

// 12. F-MNEMON-22 — unmark_superseded: reopen the November fact
const undo = parse(await client.callTool({ name: "unmark_superseded", arguments: { fact_id: fact.fact_id } }));
ok("unmark_superseded: reopens the closed fact", undo.ok === true && undo.previously_superseded_by === fact2.fact_id);

// 12b. After undo, BOTH November and December should be current → recall_candidates sees 2
const cand_after_undo = parse(await client.callTool({
  name: "recall_candidates",
  arguments: { question: "When is Acme's contract renewal?", subject: "Acme" },
}));
ok("after unmark_superseded: both facts open as current", cand_after_undo.facts.length === 2, `${cand_after_undo.facts.length} facts`);

// 12c. Idempotent: unmark_superseded on an already-open fact returns ok:false
const noop = parse(await client.callTool({ name: "unmark_superseded", arguments: { fact_id: fact.fact_id } }));
ok("unmark_superseded is idempotent (no-op on already-open)", noop.ok === false);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
