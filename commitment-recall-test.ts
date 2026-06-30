// commitment-recall-test.ts — recall must read a commitment's CURRENT status and anchor the answer
// to the source of that status. A reversal carries its OWN provenance: after "can't make it", the
// verdict must be "no" anchored to the REVERSAL's interaction (May), not the creation (March).
// Deterministic, no LLM.
//
// Run: bun run commitment-recall-test.ts
delete process.env.MNEMON_PG_URL;
import { initDb } from "./db.ts";
import { createCommitment, applyReversal, commitmentVerdict } from "./commitments.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

const db = await initDb();
const alice = (await db.query<{ id: number }>(`insert into entities (type,label) values ('person','Alice') returning id`)).rows[0].id;
const sso = (await db.query<{ id: number }>(`insert into entities (type,label) values ('thing','SSO deadline') returning id`)).rows[0].id;
const iMar = (await db.query<{ id: number }>(`insert into interactions (content,speaker,occurred_at) values ('Had the integration call with Alice today. She confirmed her team will hit the SSO deadline.','user','2026-03-10T15:00:00Z') returning id`)).rows[0].id;
const iMay = (await db.query<{ id: number }>(`insert into interactions (content,speaker,occurred_at) values ('Caught up with Alice - she now says they cannot make the SSO deadline; the integration slipped.','user','2026-05-12T09:30:00Z') returning id`)).rows[0].id;

await createCommitment(db, { ownerId: alice, aboutId: sso, action: "hit the SSO deadline",
  validFrom: "2026-03-10T15:00:00Z", sourceInteractionId: iMar, sourceSpan: "will hit the SSO deadline" });

// Before reversal: open → "yes", anchored to the March commitment.
const v1 = await commitmentVerdict(db, alice, sso);
check("open commitment answers yes", v1?.answer === "yes", `answer=${v1?.answer}`);
check("open verdict anchored to March source", (v1?.anchor ?? "").includes("hit the SSO deadline"), `anchor=${v1?.anchor?.slice(0,40)}`);

await applyReversal(db, { ownerId: alice, aboutId: sso, status: "broken", at: "2026-05-12T09:30:00Z",
  sourceInteractionId: iMay, sourceSpan: "they cannot make the SSO deadline" });

// After reversal: broken → "no", anchored to the MAY reversal (its own provenance).
const v2 = await commitmentVerdict(db, alice, sso);
check("broken commitment answers no", v2?.answer === "no", `answer=${v2?.answer}`);
check("verdict re-anchored to the MAY reversal source", (v2?.anchor ?? "").includes("cannot make the SSO deadline"), `anchor=${v2?.anchor?.slice(0,50)}`);
check("verdict occurred_at is the reversal date (May), not creation (March)",
  (v2?.source_occurred_at ?? "").startsWith("2026-05-12"), `occurred=${v2?.source_occurred_at}`);

// AS-OF: before the reversal the commitment was still open. recall_as_of must reconstruct that.
const vAsOf = await commitmentVerdict(db, alice, sso, "2026-04-01T00:00:00Z");
check("as-of BEFORE the reversal answers yes (open back then)", vAsOf?.answer === "yes", `answer=${vAsOf?.answer}`);
check("as-of verdict anchored to the March creation, not the May reversal",
  (vAsOf?.source_occurred_at ?? "").startsWith("2026-03-10"), `occurred=${vAsOf?.source_occurred_at}`);
// AS-OF before the commitment even existed → no verdict (honest).
const vBefore = await commitmentVerdict(db, alice, sso, "2026-01-01T00:00:00Z");
check("as-of BEFORE the commitment existed returns null", vBefore === null, `got=${JSON.stringify(vBefore)}`);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
