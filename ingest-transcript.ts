// ingest-transcript.ts — load a real transcript (JSON / JSONL / CSV) into a
// FILE-BACKED store, so you can query it afterwards. No deployment needed.
//
//   bun run ingest-transcript.ts <file> [--data DIR] [--speaker K --time K --text K]
//
// Fields are auto-detected (speaker/timestamp/text); override with the flags if your
// schema uses different names. Turns are ingested oldest->newest so supersession works.
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!file) {
  console.error("usage: bun run ingest-transcript.ts <file.json|.jsonl|.csv> [--data DIR] [--speaker K --time K --text K]");
  process.exit(1);
}
const dataDir = flag("data") ?? `./data/${basename(file).replace(/\.[^.]+$/, "")}`;
const account = flag("scope") ?? flag("account") ?? null; // scopes ownership of dependent entities
const owner = flag("owner") ?? process.env.MNEMON_OWNER ?? null;                    // Lock 2: Owner → Person:Human
const aiPersonas = (flag("personas") ?? process.env.MNEMON_AI_PERSONAS ?? "")       // Lock 4: names → Persona:AI
  .split(",").map((s) => s.trim()).filter(Boolean);

const SPEAKER = ["speaker", "role", "from", "author", "user", "name"];
const TIME = ["timestamp", "time", "ts", "date", "datetime", "created_at", "sent_at"];
const TEXT = ["text", "content", "message", "body", "utterance", "value"];
const pick = (rec: any, keys: string[], override?: string) =>
  override ? rec[override] : keys.map((k) => rec[k]).find((v) => v != null);

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else { if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; }
  }
  out.push(cur); return out.map((s) => s.trim());
}
function loadRecords(path: string): any[] {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  if (path.endsWith(".csv")) {
    const [head, ...rows] = raw.trim().split(/\r?\n/);
    const cols = splitCsvLine(head);
    return rows.map((r) => { const cells = splitCsvLine(r); const o: any = {}; cols.forEach((c, i) => (o[c] = cells[i])); return o; });
  }
  const j = JSON.parse(raw);
  return Array.isArray(j) ? j : (j.messages ?? j.turns ?? j.transcript ?? []);
}

const records = loadRecords(file);
let synthetic = 0;
const base = Date.parse("2020-01-01T00:00:00Z");
const turns = records.map((rec, idx) => {
  const speaker = pick(rec, SPEAKER, flag("speaker"));
  const text = pick(rec, TEXT, flag("text"));
  let occurred = (() => { const t = pick(rec, TIME, flag("time")); const d = t ? new Date(t) : null; return d && !isNaN(d.getTime()) ? d : null; })();
  if (!occurred) { occurred = new Date(base + idx * 60000); synthetic++; }
  return { speaker: speaker != null ? String(speaker) : null, content: String(text ?? ""), occurred_at: occurred.toISOString() };
}).filter((t) => t.content.trim());
turns.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

console.log(`Loaded ${turns.length} turns from ${file}` +
  (synthetic ? `  (⚠ ${synthetic} had no usable timestamp — sequential fallback used; as-of queries on those are unreliable)` : ""));

const db = await initDb(dataDir);
let n = 0;
if (account) console.log(`Account scope: ${account}`);
if (owner) console.log(`Owner (Person:Human): ${owner}`);
if (aiPersonas.length) console.log(`AI personas (Persona:AI): ${aiPersonas.join(", ")}`);
for (const t of turns) { await ingest(db, t, { account, owner, aiPersonas }); if (++n % 10 === 0) console.log(`  ingested ${n}/${turns.length}…`); }

const one = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;
console.log(`\nDone. ${turns.length} turns → ${await one(`select count(*)::int n from facts`)} facts ` +
  `(${await one(`select count(*)::int n from facts where valid_until is not null`)} superseded) ` +
  `across ${await one(`select count(*)::int n from entities`)} entities.\nStored in ${dataDir} — query it with:  bun run ask.ts "..." --data ${dataDir}`);
await db.close();
