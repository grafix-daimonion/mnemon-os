// inspect.ts — let the eval assert on internal state, not just answers.
// Over-erasing (a fact wrongly superseded) hides behind a correct-looking recall,
// so the only honest check is to count what's open vs. what got closed.
import type { PGlite } from "@electric-sql/pglite";

async function countFor(db: PGlite, subject: string, whereClause: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from facts f
       join entities e on e.id = f.subject_id
      where lower(e.label) = lower($1) and ${whereClause}`,
    [subject]);
  return r.rows[0].n;
}

export const openFactCount = (db: PGlite, subject: string) =>
  countFor(db, subject, "f.valid_until is null");

export const supersededCount = (db: PGlite, subject: string) =>
  countFor(db, subject, "f.valid_until is not null");
