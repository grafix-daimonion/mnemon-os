// persona-flag-test.ts — the four-lens persona/feedback extraction is GDPR-sensitive (it profiles
// individuals), so it ships in the repo but DORMANT: gated behind MNEMON_PERSONA_EXTRACTION, default
// OFF. With the flag off, no persona/feedback fact is ever captured — world-facts and commitments are
// untouched. Pure classification + default-off are unit-tested here; the pipeline drop is below.
//
// Run: bun run persona-flag-test.ts
import { mock } from "bun:test";
delete process.env.MNEMON_PERSONA_EXTRACTION; // ensure default (unset)
delete process.env.MNEMON_PG_URL;

mock.module("./synapsis/verify.ts", () => ({
  faithful: async () => ({ ok: true, reason: "mock" }),
  sameEntity: async () => ({ ok: false, reason: "mock" }),
  sourceHash: (_s: string) => "mockhash",
}));
mock.module("./extract.ts", () => ({
  // emit one persona fact + one world fact on every chunk; the pipeline must drop the persona one
  // when the flag is off.
  extractFacts: async () => ({
    facts: [
      { subject: "Chatzi", subject_type: "Person:Human", predicate: "design: prefers", object: "terse docs", object_kind: "literal", shape: "single", source_span: "I like terse docs" },
      { subject: "Chatzi", subject_type: "Person:Human", predicate: "uses", object: "Postgres", object_kind: "literal", shape: "single", source_span: "we use Postgres" },
    ],
    commitments: [], reversals: [],
  }),
}));

const { isPersonaPredicate, personaExtractionEnabled } = await import("./persona.ts");
const { initDb } = await import("./db.ts");
const { ingest } = await import("./pipeline.ts");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
}

// --- pure classification ---
for (const p of ["design: prefers", "behavior: values", "relationship: dislikes", "philosophy: holds standard",
                 "directive: always", "directive: never", "received_correction", "erred", "hallucinated", "praised"])
  check(`persona predicate: "${p}"`, isPersonaPredicate(p) === true);
for (const w of ["commits to", "has", "owns", "target date", "completion status", "attended", "uses", "reported"])
  check(`world predicate not flagged: "${w}"`, isPersonaPredicate(w) === false);

// --- default OFF ---
check("persona extraction is OFF by default", personaExtractionEnabled() === false);

// --- pipeline drops persona facts when OFF ---
const db = await initDb();
await ingest(db, { content: "anything", speaker: "user", occurred_at: "2026-06-01T10:00:00Z" });
const persona = (await db.query<{ n: number }>(`select count(*)::int n from facts where predicate = 'design: prefers'`)).rows[0].n;
const world = (await db.query<{ n: number }>(`select count(*)::int n from facts where predicate = 'uses'`)).rows[0].n;
check("OFF: no persona fact persisted", persona === 0, `persona=${persona}`);
check("OFF: world fact still persisted", world === 1, `world=${world}`);
await db.close();

// --- ON (explicit opt-in) keeps persona facts: proves it's a real toggle ---
process.env.MNEMON_PERSONA_EXTRACTION = "true";
check("ON: flag reads enabled", personaExtractionEnabled() === true);
const db2 = await initDb();
await ingest(db2, { content: "anything", speaker: "user", occurred_at: "2026-06-01T10:00:00Z" });
const personaOn = (await db2.query<{ n: number }>(`select count(*)::int n from facts where predicate = 'design: prefers'`)).rows[0].n;
check("ON: persona fact IS persisted when explicitly enabled", personaOn === 1, `persona=${personaOn}`);
await db2.close();
delete process.env.MNEMON_PERSONA_EXTRACTION;

console.log(`\n${pass} pass | ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
