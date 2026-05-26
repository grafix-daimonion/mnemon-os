// rebuild-diary.ts — manual L5 Diary rebuild from CONFIRMED facts (ENGINE_SPEC_v5 §17).
//
// When to run:
//   - After any schema migration that changes fact shape, source-chunk-id semantics,
//     or supersession bookkeeping. The Diary is a regenerable projection (deterministic,
//     lossless, heavy-refs); migrations MUST include a rebuild step before declaring
//     success. (Until v5 there was no script — `buildDiary()` was only called per-day
//     inside pipeline.ts. This fills that gap.)
//   - Ad-hoc when investigating drift or after manual SQL touches.
//
// Behaviour:
//   - Walks all distinct fact valid_from DATES (UTC); rebuilds each day's Diary entry.
//   - Or pass `--days N` to rebuild only the last N days; `--date YYYY-MM-DD` to rebuild one.
//   - No LLM in the rebuild path (Diary is deterministic).
//
// Usage:
//   bun run rebuild-diary.ts                       # all dates
//   bun run rebuild-diary.ts --days 7              # last 7 days only
//   bun run rebuild-diary.ts --date 2026-05-26     # one date
//   bun run rebuild-diary.ts --data ./data/foo     # custom store
import { initDb } from "./db.ts";
import { buildDiary } from "./diary.ts";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

const dataDir = flag("data");           // undefined → default in initDb (~/.mnemon/store)
const days = flag("days") ? parseInt(flag("days")!, 10) : undefined;
const explicit = flag("date");

const db = await initDb(dataDir);

let dates: string[];
if (explicit) {
  dates = [explicit];
} else {
  const dayClause = days ? `and valid_from >= now() - interval '${parseInt(String(days), 10)} days'` : ``;
  const rows = (await db.query<{ d: string }>(
    `select distinct to_char(valid_from, 'YYYY-MM-DD') as d
     from facts
     where (status = 'confirmed' or status is null) ${dayClause}
     order by d asc`)).rows;
  dates = rows.map((r) => r.d);
}

console.log(`Rebuilding Diary for ${dates.length} date(s)${dataDir ? ` in ${dataDir}` : ""}${days ? `  (last ${days} days)` : ""}${explicit ? `  (${explicit})` : ""}`);

let ok = 0, err = 0;
for (const d of dates) {
  try {
    // buildDiary takes an ISO occurred_at; we pass midnight UTC of the date.
    await buildDiary(db, `${d}T00:00:00.000Z`);
    ok++;
    if (ok % 10 === 0) process.stdout.write(`  rebuilt ${ok}/${dates.length}…\n`);
  } catch (e) {
    err++;
    console.error(`  ✗ ${d} — ${(e as Error)?.message ?? e}`);
  }
}

console.log(`Done. ${ok} rebuilt, ${err} failed.`);
await db.close();
process.exit(err ? 1 : 0);
