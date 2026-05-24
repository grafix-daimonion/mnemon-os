// eval-core.ts — the shared fixture runner + scorer, so run-eval (one pretty run)
// and qa (many runs, aggregated) share one source of truth. Each fixture's DB is
// closed after use, so repeated runs don't pile up live PGLite instances.
import { readFileSync } from "node:fs";
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { recall, recallAsOf } from "./recall.ts";
import { openFactCount, supersededCount } from "./inspect.ts";

export const FIXTURES = ["./eval/alice_sso.fixture.json", "./eval/adversarial.fixture.json"];

export interface CaseOutcome {
  fixture: string;
  id: string;
  ok: boolean;
  detail: string;
}

function scoreAnswer(c: any, res: any): boolean {
  const e = c.expect;
  if (e.answer === "honest-empty") return res.type === "honest_empty";
  if (res.type !== "answer") return false;
  if (String(res.answer).toLowerCase() !== String(e.answer).toLowerCase()) return false;
  if (e.cite_interaction_occurred_at &&
      new Date(res.source_occurred_at).getTime() !== new Date(e.cite_interaction_occurred_at).getTime())
    return false;
  if (e.quote_contains &&
      !(res.anchor ?? "").toLowerCase().includes(String(e.quote_contains).toLowerCase()))
    return false;
  return true;
}

async function runCase(db: any, c: any): Promise<{ ok: boolean; detail: string }> {
  if (c.check === "open_fact_count" || c.check === "superseded_count") {
    const actual = c.check === "open_fact_count"
      ? await openFactCount(db, c.subject)
      : await supersededCount(db, c.subject);
    return { ok: actual === c.expect, detail: `${c.check}(${c.subject}) = ${actual} (expected ${c.expect})` };
  }
  const res = c.verb === "recall_as_of"
    ? await recallAsOf(db, c.query, c.as_of)
    : await recall(db, c.query);
  return { ok: scoreAnswer(c, res), detail: JSON.stringify(res) };
}

export async function runAllFixtures(): Promise<CaseOutcome[]> {
  const out: CaseOutcome[] = [];
  for (const f of FIXTURES) {
    const fx = JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
    const db = await initDb();
    try {
      for (const it of fx.seed)
        await ingest(db, { content: it.content, speaker: it.speaker ?? null, occurred_at: it.occurred_at });
      for (const c of fx.cases) {
        const { ok, detail } = await runCase(db, c);
        out.push({ fixture: fx.name, id: c.id, ok, detail });
      }
    } finally {
      await db.close();
    }
  }
  return out;
}
