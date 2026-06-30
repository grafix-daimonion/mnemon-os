// commitments-test.ts — the commitments primitive (COMMITMENTS_DESIGN_v1).
//
// Deterministic core, no LLM: a commitment is ONE row keyed on (owner, about) carrying a
// status. The bug it fixes (current-state-after-reversal): in the generic-fact model a
// commitment ("X committed to Y") accumulates and is never superseded, while its reversal
// ("Y can't be met") lands on a DIFFERENT subject — so recall keeps answering "yes". Here a
// reversal flips status on the SAME row, so the live state is always correct.
//
// Run: env -u MNEMON_PG_URL bun run commitments-test.ts
delete process.env.MNEMON_PG_URL; // force fresh in-memory PGlite — never touch a server store
import { initDb } from "./db.ts";
import { createCommitment, currentCommitmentFor, applyReversal } from "./commitments.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

const db = await initDb();

// minimal world: two entities + a source interaction (no LLM, inserted directly)
const alice = (await db.query<{ id: number }>(
  `insert into entities (type, label) values ('person', 'Alice') returning id`)).rows[0].id;
const sso = (await db.query<{ id: number }>(
  `insert into entities (type, label) values ('thing', 'SSO deadline') returning id`)).rows[0].id;
const iMar = (await db.query<{ id: number }>(
  `insert into interactions (content, speaker, occurred_at) values ('Alice confirmed her team will hit the SSO deadline.', 'user', '2026-03-10T15:00:00Z') returning id`)).rows[0].id;
const iMay = (await db.query<{ id: number }>(
  `insert into interactions (content, speaker, occurred_at) values ('Alice now says they cannot make the SSO deadline.', 'user', '2026-05-12T09:30:00Z') returning id`)).rows[0].id;

// March: Alice commits to the SSO deadline → an OPEN commitment.
const cid = await createCommitment(db, {
  ownerId: alice, aboutId: sso, action: "hit the SSO deadline",
  validFrom: "2026-03-10T15:00:00Z", sourceInteractionId: iMar,
  sourceSpan: "She confirmed her team will hit the SSO deadline",
});
const afterCreate = await currentCommitmentFor(db, alice, sso);
check("commitment is created OPEN", afterCreate?.status === "open", `status=${afterCreate?.status}`);

// May: Alice can't make it → reversal flips the SAME commitment to broken.
const flipped = await applyReversal(db, {
  ownerId: alice, aboutId: sso, status: "broken",
  at: "2026-05-12T09:30:00Z", sourceInteractionId: iMay,
  sourceSpan: "she now says they can't make the SSO deadline",
});
check("reversal matched and flipped a commitment", flipped === true);

const cur = await currentCommitmentFor(db, alice, sso);
check("current state is now BROKEN (not stale 'open')", cur?.status === "broken", `status=${cur?.status}`);
check("same commitment row — reversal did not fork a new one", cur?.id === cid, `id=${cur?.id} expected ${cid}`);

const total = (await db.query<{ n: number }>(
  `select count(*)::int as n from commitments where owner_id = $1 and about_id = $2`, [alice, sso])).rows[0].n;
check("exactly one commitment row for (Alice, SSO deadline)", total === 1, `count=${total}`);

await db.close();
console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
