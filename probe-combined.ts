// probe-combined.ts — the accumulation test on the combined Daimonion store:
//   (1) cross-conversation identity: did key names collapse to one node across the two transcripts?
//   (2) bi-temporal: does `recall` (now) differ from `recall_as_of "2026-05-10"` (then) on durable topics?
import { initDb } from "./db.ts";
import { recall, recallAsOf } from "./recall.ts";

const dir = process.argv[2] ?? "./data/daimonion-all";
const db = await initDb(dir);

console.log("\n=== 1. cross-conversation identity (one node per name?) ===");
for (const l of ["Daimonion", "Mnemon", "Pythia", "CT", "Synapsis"]) {
  const r = (await db.query<{ c: number; ids: string }>(
    `select count(*)::int c, string_agg(id::text, ',' order by id) as ids
     from entities where lower(label) = lower($1)`, [l])).rows[0];
  console.log(`  '${l}' → ${r.c} node(s)${r.ids ? "  (id="+r.ids+")" : ""}`);
}

console.log("\n=== 2. bi-temporal recall (now vs as-of 2026-05-10) ===");
const queries = [
  "What is the status of Mnemon?",
  "What is the status of Daimonion?",
  "What is Pythia?",
];
const ASOF = "2026-05-10T00:00:00Z";
for (const q of queries) {
  console.log(`\nQ: ${q}`);
  const now = await recall(db, q);
  console.log(`  now       : ${now.type}/${now.via ?? "-"}  -> ${(now.answer ?? now.reason ?? "").slice(0,180)}`);
  if (now.source_occurred_at) console.log(`              src: ${now.source_occurred_at}`);
  if (now.anchor) console.log(`              anchor: ${now.anchor.slice(0,180).replace(/\s+/g," ")}`);
  const asof = await recallAsOf(db, q, ASOF);
  console.log(`  asof 5-10 : ${asof.type}/${asof.via ?? "-"}  -> ${(asof.answer ?? asof.reason ?? "").slice(0,180)}`);
  if (asof.source_occurred_at) console.log(`              src: ${asof.source_occurred_at}`);
  if (asof.anchor) console.log(`              anchor: ${asof.anchor.slice(0,180).replace(/\s+/g," ")}`);
}

console.log("\n=== 3. honest-empty sanity (a name not in the data) ===");
const he = await recall(db, "What did Carol approve?");
console.log(`  '${"Carol"}' → ${he.type} (${he.reason ?? he.answer ?? ""})`);

await db.close();
