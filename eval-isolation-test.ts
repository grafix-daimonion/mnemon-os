// eval-isolation-test.ts — the eval/test store MUST be ephemeral and isolated, never the configured
// MNEMON_PG_URL (that is the user's REAL memory — running the eval there pollutes it and lets fixture
// rows accumulate across runs, which silently corrupts the numbers). Proof: point MNEMON_PG_URL at an
// unreachable server; an ephemeral store must still work (in-memory, offline) and each must be empty.
//
// Run: bun run eval-isolation-test.ts
process.env.MNEMON_PG_URL = "postgres://nobody@127.0.0.1:1/does-not-exist"; // unreachable on purpose
import { initDb } from "./db.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

// If ephemeral did NOT bypass MNEMON_PG_URL, this would try to reach 127.0.0.1:1 and throw.
let db: any = null;
try {
  db = await initDb(undefined, { ephemeral: true });
  const one = (await db.query<{ x: number }>(`select 1 as x`)).rows[0]?.x;
  check("ephemeral initDb ignores MNEMON_PG_URL (offline in-memory works)", one === 1, `select 1 -> ${one}`);
} catch (e: any) {
  check("ephemeral initDb ignores MNEMON_PG_URL (offline in-memory works)", false, String(e?.message ?? e).slice(0, 80));
}

if (db) {
  await db.query(`insert into entities (type, label) values ('person', 'Probe')`);
  const db2 = await initDb(undefined, { ephemeral: true });
  const n = (await db2.query<{ n: number }>(`select count(*)::int as n from entities`)).rows[0].n;
  check("a second ephemeral store is isolated (does not see the first's writes)", n === 0, `count=${n}`);
  await db2.close();
  await db.close();
} else {
  check("a second ephemeral store is isolated (does not see the first's writes)", false, "no db");
}

console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
