// recall-traversal-test.ts — the FALLBACK facts path (selectFacts) must reach a referent's facts
// through a COMMITMENT edge, not just ownership edges. Otherwise a question about a person whose
// answer lives on the thing they committed to (Bob --committed to--> API migration --target date--> Q2)
// goes blind when extraction labels the edge "committed to" instead of "responsible for" — the
// paraphrase-reversal-asof flake. Deterministic: facts inserted directly, no LLM.
//
// Run: bun run recall-traversal-test.ts
delete process.env.MNEMON_PG_URL;
import { initDb } from "./db.ts";
import { selectFacts } from "./recall.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

const db = await initDb();
const bob = (await db.query<{ id: number }>(`insert into entities (type,label) values ('person','Bob') returning id`)).rows[0].id;
const mig = (await db.query<{ id: number }>(`insert into entities (type,label) values ('project','API migration') returning id`)).rows[0].id;
const i = (await db.query<{ id: number }>(`insert into interactions (content,speaker,occurred_at) values ('Bob said the API migration will be done by Q2.','user','2026-03-01T10:00:00Z') returning id`)).rows[0].id;
// Bob --committed to--> API migration  (the person→referent edge, NOT an ownership pred)
await db.query(`insert into facts (subject_id,predicate,object_entity_id,shape,valid_from,status,source_interaction_id)
                values ($1,'committed to',$2,'multi','2026-03-01T10:00:00Z','confirmed',$3)`, [bob, mig, i]);
// API migration --target date--> Q2  (the answer lives HERE, on the referent)
await db.query(`insert into facts (subject_id,predicate,object_literal,shape,valid_from,status,source_interaction_id)
                values ($1,'target date','Q2','single','2026-03-01T10:00:00Z','confirmed',$2)`, [mig, i]);

const rows = await selectFacts(db, "Bob", null);
const reachesReferent = rows.some((r: any) => r.predicate === "target date" && (r.object_display === "Q2" || r.object_literal === "Q2"));
const hasOwnCommitment = rows.some((r: any) => r.predicate === "committed to");

check("selectFacts reaches the referent's fact via the commitment edge", reachesReferent, `rows=${rows.map((r:any)=>r.predicate).join(",")}`);
check("Bob's own commitment fact is still present", hasOwnCommitment);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
