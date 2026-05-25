// degrade-test.ts — E1 acceptance: GRACEFUL DEGRADATION.
// With the fact layer disabled (MNEMON_NO_FACTS), recall must STILL answer from the L0 verbatim floor.
// Proves L0 stands on its own — the property the whole stack rests on.
//   ANTHROPIC_API_KEY=... bun run degrade-test.ts
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { recall } from "./recall.ts";

const db = await initDb(); // in-memory
await ingest(db, {
  content: "Acme's contract renewal is in November.",
  speaker: "user",
  occurred_at: new Date().toISOString(),
});

process.env.MNEMON_NO_FACTS = "1"; // turn the fact layer OFF → recall must fall to the L0 floor
const r = await recall(db, "When is Acme's renewal?");

const text = `${r.answer ?? ""} ${r.anchor ?? ""}`;
const ok = r.type === "answer" && r.via === "verbatim" && /november/i.test(text);
console.log(`[${ok ? "PASS" : "FAIL"}] graceful degradation: facts OFF → L0 floor answers`);
console.log(`        ${JSON.stringify(r)}`);
await db.close();
process.exit(ok ? 0 : 1);
