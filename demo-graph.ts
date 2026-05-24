// demo-graph.ts — show entity-to-entity relationships forming from one note.
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";

const db = await initDb();
await ingest(db, {
  content: "Alice manages Bob, and they both work at Acme on the SSO project.",
  speaker: "user",
  occurred_at: "2026-05-01T10:00:00Z",
});

console.log("\nENTITIES:");
console.table((await db.query(`select id, label, type from entities order by id`)).rows);

console.log("FACTS (edges):");
console.table((await db.query(
  `select s.label as subject, f.predicate, coalesce(f.object_literal, o.label) as object,
          (case when f.object_entity_id is not null then 'entity' else 'literal' end) as object_kind, f.shape
   from facts f join entities s on s.id = f.subject_id
   left join entities o on o.id = f.object_entity_id order by f.id`)).rows);
