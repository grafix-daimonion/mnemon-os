// fuzzy-test.ts — targeted acceptance for identity-by-label + fuzzy entity resolution.
// Pure parts need no DB/LLM; the integration parts use an in-memory store and (for the
// typo merge) one LLM call, so run with the key in the environment (or a local .env):
//   ANTHROPIC_API_KEY=sk-... bun run fuzzy-test.ts
import { initDb } from "./db.ts";
import { resolveOrCreate } from "./pipeline.ts";
import { osaDistance, fuzzyCap, normLabel } from "./synapsis/fuzzy.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`);
};

// --- pure: distance + cap + normalization (no DB, no LLM) ---
const dDaim = osaDistance("daimonion", "daiamnion");
ok("osa(daimonion,daiamnion) is a small typo distance", dDaim <= 2, `d=${dDaim}`);
ok("…within the fuzzy cap → a candidate", dDaim <= fuzzyCap("daimonion", "daiamnion"), `cap=${fuzzyCap("daimonion", "daiamnion")}`);
const dPy = osaDistance("pythia", "python");
ok("osa(pythia,python) = 2", dPy === 2, `d=${dPy}`);
ok("…outside the cap → NOT a candidate", dPy > fuzzyCap("pythia", "python"), `cap=${fuzzyCap("pythia", "python")}`);
ok("normLabel folds case/space/punct", normLabel("  Daimonion. ") === "daimonion");

// --- integration: resolveOrCreate against a live in-memory store ---
const db = await initDb(); // in-memory
const now = new Date().toISOString();

const daim = await resolveOrCreate(db, "Daimonion", "org", null, now, 0);
// same name, different (volatile) type → MUST be one node (identity = label, not type)
const daimThing = await resolveOrCreate(db, "Daimonion", "thing", null, now, 0);
ok("identity-by-label: Daimonion(org) ≡ Daimonion(thing)", daim === daimThing, `#${daim} vs #${daimThing}`);

// typo → fuzzy candidate → QA confirms → merge (one LLM call)
const typo = await resolveOrCreate(db, "Daiamnion", "thing", null, now, 0, "Daimonion");
ok("fuzzy+QA: Daiamnion merges into Daimonion", typo === daim, `#${typo} vs #${daim}`);

// the variant is now a remembered alias → resolves by cheap lookup, no re-litigation
const typo2 = await resolveOrCreate(db, "Daiamnion", "thing", null, now, 0, "Daimonion");
ok("alias remembered: Daiamnion → Daimonion again", typo2 === daim);

// the false-positive guardrail: look-alikes must stay separate (no LLM even consulted)
const pythia = await resolveOrCreate(db, "Pythia", "person", null, now, 0);
const python = await resolveOrCreate(db, "Python", "thing", null, now, 0, "Daimonion");
ok("guardrail: Pythia ≠ Python (stay separate)", pythia !== python, `#${pythia} vs #${python}`);

const ents = (await db.query<{ id: number; label: string; type: string }>(`select id, label, type from entities order by id`)).rows;
ok("type promotion: Daimonion kept 'org' (never demoted to 'thing')", ents.find((e) => e.id === daim)?.type === "org");

console.log("\nentities:", ents.map((e) => `#${e.id} ${e.label}(${e.type})`).join(", "));
const aliases = (await db.query<{ alias: string; entity_id: number }>(`select alias, entity_id from entity_aliases`)).rows;
console.log("aliases:", aliases.map((a) => `${a.alias}→#${a.entity_id}`).join(", ") || "(none)");

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
