// compare-stores.ts — side-by-side fragmentation/quality metrics for file-backed stores,
// so a before/after is one command:  bun run compare-stores.ts DIR [DIR ...]
// (turn-count-independent signals — duplicate labels, self-edges — show the fix regardless
// of how many turns each store has.)
import { initDb } from "./db.ts";

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!dirs.length) { console.error("usage: bun run compare-stores.ts DIR [DIR ...]"); process.exit(1); }

for (const dir of dirs) {
  const db = await initDb(dir);
  const one = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;
  const entities = await one(`select count(*)::int n from entities`);
  const facts = await one(`select count(*)::int n from facts`);
  const sup = await one(`select count(*)::int n from facts where valid_until is not null`);
  const self = await one(`select count(*)::int n from facts where object_entity_id = subject_id`);
  let aliases = 0; try { aliases = await one(`select count(*)::int n from entity_aliases`); } catch {}
  const dups = (await db.query<{ label: string; c: number }>(
    `select lower(label) as label, count(*)::int c from entities group by lower(label) having count(*) > 1 order by 2 desc, 1`)).rows;
  console.log(`\n=== ${dir} ===`);
  console.log(`entities=${entities}  facts=${facts}  superseded=${sup}  self-edges=${self}  aliases=${aliases}`);
  console.log(`duplicate labels (${dups.length}): ${dups.map((d) => `${d.label}×${d.c}`).join(", ") || "(none)"}`);
  await db.close();
}
