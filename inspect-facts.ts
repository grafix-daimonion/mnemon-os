// Read-only inspector: dump every extracted fact with its source span.
// Usage: bun run inspect-facts.ts <pglite-store-dir>
// (Server must be STOPPED — PGLite is single-writer.)
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

const dir = process.argv[2];
if (!dir) { console.error("need a store dir"); process.exit(1); }

const db = new PGlite(dir, { extensions: { vector } });
const res = await db.query<any>(`
  select f.id,
         se.label              as subject,
         f.predicate,
         coalesce(oe.label, f.object_literal) as object,
         f.shape,
         f.status,
         to_char(f.valid_from,  'YYYY-MM-DD') as valid_from,
         to_char(f.valid_until, 'YYYY-MM-DD') as valid_until,
         f.superseded_by,
         f.source_span,
         i.content             as source_text
  from facts f
  join entities se on se.id = f.subject_id
  left join entities oe on oe.id = f.object_entity_id
  join interactions i on i.id = f.source_interaction_id
  order by f.id
`);

console.log(`\n${res.rows.length} fact(s) extracted:\n`);
for (const r of res.rows) {
  const sup = r.superseded_by ? `  [SUPERSEDED→${r.superseded_by}]` : "";
  const win = `${r.valid_from}${r.valid_until ? "→" + r.valid_until : "→current"}`;
  console.log(`#${r.id} (${r.shape}/${r.status})${sup}`);
  console.log(`   ${r.subject}  --${r.predicate}-->  ${r.object}`);
  console.log(`   valid: ${win}`);
  console.log(`   from span: "${r.source_span ?? ""}"`);
  console.log(`   src text : "${r.source_text}"\n`);
}
await db.close();
