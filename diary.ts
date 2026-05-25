// diary.ts — L5: the recent-tier digest. DETERMINISTIC + LOSSLESS (no LLM summary — the AAAK lesson):
// it lists CONFIRMED current-state with inline facts + pointers (heavy-refs), regenerable from facts.
import type { PGlite } from "@electric-sql/pglite";

const dateOf = (iso: string) => iso.slice(0, 10);

// Rebuild the day's entry from CONFIRMED facts only (idempotent: delete+insert for the date).
export async function buildDiary(db: PGlite, occurredAt: string): Promise<void> {
  const date = dateOf(occurredAt);
  const added = (await db.query<any>(
    `select s.label as subject, f.predicate, coalesce(f.object_literal, oe.label) as object,
            f.id, f.source_interaction_id
     from facts f join entities s on s.id = f.subject_id
     left join entities oe on oe.id = f.object_entity_id
     where f.status = 'confirmed' and f.valid_until is null
       and to_char(f.valid_from, 'YYYY-MM-DD') = $1
     order by f.id`, [date])).rows;
  const changed = (await db.query<any>(
    `select s.label as subject, f.predicate, coalesce(f.object_literal, oe.label) as object, f.id
     from facts f join entities s on s.id = f.subject_id
     left join entities oe on oe.id = f.object_entity_id
     where f.status = 'confirmed' and to_char(f.valid_until, 'YYYY-MM-DD') = $1
     order by f.id`, [date])).rows;

  const lines = [
    ...added.map((r) => `• ${r.subject} · ${r.predicate} → ${r.object}  [#${r.id}←i${r.source_interaction_id}]`),
    ...changed.map((r) => `• (was) ${r.subject} · ${r.predicate} → ${r.object}  [#${r.id} superseded]`),
  ];
  const content = lines.length ? lines.join("\n") : "(no confirmed facts)";
  await db.query(`delete from diary where entry_date = $1`, [date]);
  await db.query(`insert into diary (entry_date, content) values ($1, $2)`, [date, content]);
}

// The read-small tier: the last `days` digests, read whole (token-budget dial = days).
export async function readDiary(db: PGlite, days = 3): Promise<string> {
  const rows = (await db.query<{ d: string; content: string }>(
    `select to_char(entry_date, 'YYYY-MM-DD') as d, content from diary order by entry_date desc limit $1`,
    [days])).rows;
  return rows.map((r) => `## ${r.d}\n${r.content}`).join("\n\n");
}
