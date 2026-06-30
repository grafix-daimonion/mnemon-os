// commitment-recipient-test.ts — the recipient slot pays off in the CS query that started this whole
// thread: "what are our open commitments TO Acme?" Recipient is a FK to an entity, so this is a real
// join, not a substring. Returns only open + confirmed commitments to that recipient, soonest-due
// first; excludes other recipients, fulfilled/broken, and quarantined. Deterministic, no LLM.
//
// Run: bun run commitment-recipient-test.ts
delete process.env.MNEMON_PG_URL;
import { initDb } from "./db.ts";
import { createCommitment, applyReversal, commitmentsTo } from "./commitments.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}
const db = await initDb();
const ent = async (type: string, label: string) =>
  (await db.query<{ id: number }>(`insert into entities (type,label) values ($1,$2) returning id`, [type, label])).rows[0].id;
const acme = await ent("org", "Acme");
const other = await ent("org", "Globex");
const alice = await ent("person", "Alice");
const bob = await ent("person", "Bob");
const ssoFix = await ent("project", "SSO fix");
const report = await ent("project", "Q2 report");
const oldThing = await ent("project", "legacy migration");
const shady = await ent("project", "shady deliverable");
const i = (await db.query<{ id: number }>(`insert into interactions (content,speaker,occurred_at) values ('src','user','2026-06-01T10:00:00Z') returning id`)).rows[0].id;

const mk = (ownerId: number, recipientId: number, aboutId: number, action: string, dueAt: string | null) =>
  createCommitment(db, { ownerId, recipientId, aboutId, action, dueAt, validFrom: "2026-06-01T10:00:00Z", sourceInteractionId: i });

const c1 = await mk(alice, acme, ssoFix, "ship the SSO fix", "2026-07-15T00:00:00Z"); // open, to Acme, dated
const c2 = await mk(bob, acme, report, "send the Q2 report", null);                    // open, to Acme, no due
await mk(alice, other, ssoFix, "thing for Globex", "2026-07-01T00:00:00Z");            // different recipient
const c4 = await mk(bob, acme, oldThing, "finish legacy migration", null);             // to Acme, will be broken
await applyReversal(db, { ownerId: bob, aboutId: oldThing, status: "broken", at: "2026-06-10T10:00:00Z", sourceInteractionId: i });
const c5 = await mk(alice, acme, shady, "shady deliverable", null);                    // to Acme, will be quarantined
await db.query(`update commitments set qa_status='quarantined' where id=$1`, [c5]);

const open = await commitmentsTo(db, acme);
const ids = open.map((o: any) => o.id);

check("returns the open confirmed commitments to Acme", ids.includes(c1) && ids.includes(c2), `ids=${ids}`);
check("excludes commitments to a different recipient (Globex)", !open.some((o: any) => o.action.includes("Globex")));
check("excludes a broken commitment", !ids.includes(c4), `c4=${c4} in ${ids}`);
check("excludes a quarantined commitment", !ids.includes(c5), `c5=${c5} in ${ids}`);
check("exactly two open commitments to Acme", ids.length === 2, `count=${ids.length}`);
check("ordered soonest-due first (dated c1 before undated c2)", ids[0] === c1, `order=${ids}`);
check("carries owner + action for display", open[0]?.owner === "Alice" && !!open[0]?.action, `owner=${open[0]?.owner}`);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
