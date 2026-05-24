// browse.ts — dump the graph in a file-backed store, so you can SEE what extraction built.
//   bun run browse.ts [--data DIR]
import { initDb } from "./db.ts";

const i = process.argv.indexOf("--data");
const dataDir = i >= 0 ? process.argv[i + 1] : "./data/sample";

const db = await initDb(dataDir);

console.log("\nENTITIES:");
console.table((await db.query(`select id, label, type from entities order by id`)).rows);

console.log("FACTS (edges) — current + superseded:");
console.table((await db.query(
  `select s.label as subject, f.predicate,
          coalesce(f.object_literal, o.label) as object,
          (case when f.object_entity_id is not null then 'entity' else 'lit' end) as kind,
          f.shape,
          to_char(f.valid_from, 'YYYY-MM-DD') as from_date,
          coalesce(to_char(f.valid_until, 'YYYY-MM-DD'), '—') as until
   from facts f
   join entities s on s.id = f.subject_id
   left join entities o on o.id = f.object_entity_id
   order by f.id`)).rows);

const sup = (await db.query<{ n: number }>(`select count(*)::int n from facts where valid_until is not null`)).rows[0].n;
console.log(`Superseded facts: ${sup}`);
await db.close();
