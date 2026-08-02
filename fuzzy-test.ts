// fuzzy-test.ts — targeted acceptance for identity-by-label + fuzzy entity resolution.
// Pure parts need no DB/LLM; the integration parts use an in-memory store and (for the
// typo merge) one LLM call, so run with the key in the environment (or a local .env):
//   ANTHROPIC_API_KEY=sk-... bun run fuzzy-test.ts
import { initDb } from "./db.ts";
import { resolveOrCreate, correctShape } from "./pipeline.ts";
import { osaDistance, fuzzyCap, normLabel, parseVersion, versionVerdict } from "./synapsis/fuzzy.ts";

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

// --- versions policy (pure: parseVersion + versionVerdict, no DB/LLM) ---
ok("parseVersion('Pythia v4') = {Pythia, 4}", JSON.stringify(parseVersion("Pythia v4")) === '{"base":"Pythia","version":"4"}');
ok("parseVersion('Mnemon OS v1.2') = {Mnemon OS, 1.2}", JSON.stringify(parseVersion("Mnemon OS v1.2")) === '{"base":"Mnemon OS","version":"1.2"}');
ok("parseVersion('Pythia') = null (no version)", parseVersion("Pythia") === null);
ok("parseVersion('Vortex') = null (no separator-then-v)", parseVersion("Vortex") === null);
ok("verdict: 'Pythia' ↔ 'Pythia v4' (project) → merge (umbrella)", versionVerdict("Pythia v4", "Pythia", "thing", "thing") === "merge");
ok("verdict: 'Pythia v3' ↔ 'Pythia v4' (project) → distinct", versionVerdict("Pythia v3", "Pythia v4", "thing", "thing") === "distinct");
ok("verdict: 'Acme v2' ↔ 'Acme' (org) → merge (artifact)", versionVerdict("Acme v2", "Acme", "org", "org") === "merge");
ok("verdict: different bases → undecided", versionVerdict("Pythia v4", "Daimonion v3", "thing", "thing") === "undecided");
ok("verdict: neither versioned → undecided", versionVerdict("Pythia", "Mnemon", "thing", "thing") === "undecided");

// --- versions policy (integration: resolveOrCreate on a fresh in-memory store) ---
const db2 = await initDb();
const pyBare = await resolveOrCreate(db2, "Pythia", "project", null, now, 0);
// bare exists → incoming versioned merges in (umbrella absorbs)
const pyV4 = await resolveOrCreate(db2, "Pythia v4", "project", null, now, 0);
ok("version-rule (bare-first): 'Pythia v4' → merges into 'Pythia'", pyV4 === pyBare, `#${pyV4} vs #${pyBare}`);

// fresh store, no bare; two distinct versions stay distinct
const db3 = await initDb();
const pV3 = await resolveOrCreate(db3, "Pythia v3", "project", null, now, 0);
const pV4 = await resolveOrCreate(db3, "Pythia v4", "project", null, now, 0);
ok("version-rule (no bare): 'Pythia v3' ≠ 'Pythia v4' (distinct releases)", pV3 !== pV4, `#${pV3} vs #${pV4}`);
const pV4Again = await resolveOrCreate(db3, "Pythia v4", "project", null, now, 0);
ok("version-rule: 'Pythia v4' resolves stably to itself (exact match)", pV4Again === pV4);

// person+version → artifact, merge
const db4 = await initDb();
const al = await resolveOrCreate(db4, "Alice", "person", null, now, 0);
const alV2 = await resolveOrCreate(db4, "Alice v2", "person", null, now, 0);
ok("version-rule (person): 'Alice v2' merges into 'Alice' (artifact)", alV2 === al, `#${alV2} vs #${al}`);

await db2.close(); await db3.close(); await db4.close();

// --- F-MNEMON-17: commitment fact-shape (pure correctShape) ---
ok("shape: 'commitment' forced to multi (was single)", correctShape("commitment", "single") === "multi");
ok("shape: 'commits to' forced to multi", correctShape("commits to", "single") === "multi");
ok("shape: 'todo' forced to multi", correctShape("todo", "single") === "multi");
ok("shape: 'responsible for' forced to multi", correctShape("responsible for", "single") === "multi");
ok("shape: 'status' (genuinely single) stays single", correctShape("status", "single") === "single");
ok("shape: 'wants to' (ambiguous) preserves LLM 'single'", correctShape("wants to", "single") === "single");
ok("shape: any predicate respects LLM 'multi'", correctShape("anything", "multi") === "multi");
ok("shape: case-insensitive predicate match", correctShape("  Commitment  ", "single") === "multi");

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
