// ask.ts — query a file-backed store built by ingest-transcript.ts.
//   bun run ask.ts "your question" [--as-of YYYY-MM-DD] [--data DIR]
//   bun run ask.ts            (no question) -> store stats (entities, top predicates)
import { initDb } from "./db.ts";
import { recall, recallAsOf } from "./recall.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = flag("data") ?? "./data/sample";
const asOf = flag("as-of");

const positional: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { i++; continue; } positional.push(args[i]); }
const question = positional.join(" ").trim();

const db = await initDb(dataDir);
if (!question) {
  console.log("Entities by type:", (await db.query(`select type, count(*)::int n from entities group by type order by n desc`)).rows);
  console.log("Top predicates:", (await db.query(`select predicate, count(*)::int n from facts group by predicate order by n desc limit 15`)).rows);
} else {
  const res = asOf ? await recallAsOf(db, question, new Date(asOf).toISOString()) : await recall(db, question);
  console.log(`Q: ${question}${asOf ? `  (as of ${asOf})` : ""}`);
  console.log(JSON.stringify(res, null, 2));
}
await db.close();
