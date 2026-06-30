// recall-fast-test.ts — the LLM-free fast recall path for automatic per-turn injection.
// keyword arbiter gates honest-empty (no match → nothing to inject); a match returns grounded
// candidates. Deterministic: embed is mocked, chunks inserted directly (no extraction LLM).
//
// Run: bun run recall-fast-test.ts
import { mock } from "bun:test";
delete process.env.MNEMON_PG_URL;

mock.module("./embed.ts", () => ({
  embed: async () => new Array(384).fill(0),
  toVector: (a: number[]) => "[" + a.join(",") + "]",
}));

const { initDb } = await import("./db.ts");
const { recallFast } = await import("./recall-class2.ts");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

const db = await initDb();
const iid = (await db.query<{ id: number }>(
  `insert into interactions (content, speaker, occurred_at)
   values ('We promised Acme we will ship the SSO fix by Q3.', 'user', '2026-06-01T10:00:00Z') returning id`)).rows[0].id;
await db.query(`insert into chunks (interaction_id, ord, content) values ($1, 0, 'We promised Acme we will ship the SSO fix by Q3.')`, [iid]);

const known = await recallFast(db, "What did we promise Acme about the SSO fix?", null, null);
check("known query → answer (keyword evidence exists)", known.type === "answer", `type=${known.type}`);
check("known query returns grounded chunk candidates", known.chunks.length >= 1, `chunks=${known.chunks.length}`);

const unknown = await recallFast(db, "What is the budget for project Zephyr?", null, null);
check("unknown query → honest_empty (no keyword evidence)", unknown.type === "honest_empty", `type=${unknown.type}`);
check("honest_empty injects nothing (no facts, no chunks)", unknown.facts.length === 0 && unknown.chunks.length === 0);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
