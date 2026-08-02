// alice-inspect.ts — show how the alice_sso reversal actually keys, to see WHY current-state
// wobbles: for the May "can't make" fact to supersede the March "will hit" fact, both must
// land on the SAME subject. This dumps the entities + facts so we can check.
import { readFileSync } from "node:fs";
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { recall } from "./recall.ts";

const fx = JSON.parse(readFileSync(new URL("./eval/alice_sso.fixture.json", import.meta.url), "utf8"));
const db = await initDb();
for (const it of fx.seed) await ingest(db, { content: it.content, speaker: it.speaker ?? null, occurred_at: it.occurred_at });

console.log("\nENTITIES:");
console.table((await db.query(`select id, label, type from entities order by id`)).rows);
console.log("FACTS (did the May fact close the March one?):");
console.table((await db.query(
  `select f.id, s.label as subject, f.predicate, coalesce(f.object_literal, o.label) as object,
          f.status, f.shape,
          to_char(f.valid_from,'MM-DD') as from_d, coalesce(to_char(f.valid_until,'MM-DD'),'—') as until_d
   from facts f join entities s on s.id = f.subject_id left join entities o on o.id = f.object_entity_id
   order by f.id`)).rows);
const r = await recall(db, "Did Alice agree to the SSO deadline?");
console.log("\nRECALL 'Did Alice agree to the SSO deadline?' (expect: no / May / 'can't make'):");
console.log(JSON.stringify(r, null, 1));

await db.close();
