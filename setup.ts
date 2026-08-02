// setup.ts — interactive Mnemon installer. Asks which install path to enable,
// writes .env, points at the right CLAUDE.memory template, and prints the next commands.
// Runs in seconds; no API calls; idempotent (re-run any time).
//
//   bun run setup.ts                                # interactive
//   bun run setup.ts --classes=1,3 --yes            # non-interactive (CI / scripted)
//   bun run setup.ts --classes=combined --yes       # combined-server install (Class 1 write + Class 2 read)
//
// Combined install (per ENGINE_SPEC_v6 §4.2a / CLASS2_DESIGN_v6 §3.4e):
// the single-class-at-write contract requires picking ONE primary write path. This
// chooser is the *UX gate* that enforces the contract — operators can't reach a
// dual-primary configuration via setup. Default write path is Class-1 `remember`.
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`)); if (i < 0) return undefined; const a = args[i]; return a.includes("=") ? a.split("=").slice(1).join("=") : (args[i + 1] ?? ""); };
const has = (k: string) => args.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const auto = has("yes");
const presetClasses = flag("classes");
const presetWritePath = flag("write-path");           // "class1" | "class2" — combined-only
const presetModel = flag("llm-model");                // pass-through to MNEMON_LLM_MODEL

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def = ""): Promise<string> => {
  if (auto) return def;
  const a = (await rl.question(q)).trim();
  return a || def;
};

console.log(`
🧠  Mnemon setup
────────────────

Four install paths — pick one (or any combination of 1/2/3):

  [1] Class 1 — Anthropic API key, MCP into Claude Code
                Server does the LLM work; you call remember/recall.
                Cost ~$5–25/mo Haiku (default) or ~$15–75/mo Sonnet. Self-contained.

  [2] Class 2 — Claude Code subscription, MCP (NO API key)
                Server is dumb storage; YOU (Claude Code) do the LLM work
                using your subscription. Primitive verbs; no extra billing.

  [3] Class 3 — Anthropic API key, HTTP API (any language; no Claude Code)
                Standalone HTTP service. Python / Ruby / Go / curl can call it.

  [c] COMBINED — Class 1 + Class 2 in ONE process, ONE store
                Single MCP server exposes ALL 14 verbs. Per-install contract:
                pick ONE primary write path (Class-1 'remember' default or
                Class-2 'assert_fact'); the other surface is read-mostly.
                Needs an API key. Recommended when you want both read surfaces.

See BACKENDS.md for the full trade-off table.
`);

const rawChoice = presetClasses ?? await ask("Choose [1 / 2 / 3 / c (combined) / all, or e.g. '1,3']: ", "all");
const choice = rawChoice.trim().toLowerCase();
const wanted = new Set<number>();
const COMBINED = 4;   // internal token; UI shows 'c' / 'combined'

if (choice === "all") [1, 2, 3].forEach((n) => wanted.add(n));
else if (choice === "c" || choice === "combined") wanted.add(COMBINED);
else choice.split(/[\s,]+/).forEach((c) => {
  const t = c.trim();
  if (t === "c" || t === "combined") wanted.add(COMBINED);
  else { const n = parseInt(t, 10); if ([1, 2, 3].includes(n)) wanted.add(n); }
});
if (!wanted.size) { console.error("No valid class chosen. Exiting."); rl.close(); process.exit(1); }

// Existing .env detection (re-runs shouldn't overwrite silently)
const envPath = join(HERE, ".env");
const existing: Record<string, string> = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  if (Object.keys(existing).length) console.log(`\n.env exists — will reuse values where you press Enter. Current: ${Object.keys(existing).join(", ")}\n`);
}

const env: Record<string, string> = { ...existing };

// Anthropic key (Class 1 / 3 / combined)
const needsKey = wanted.has(1) || wanted.has(3) || wanted.has(COMBINED);
if (needsKey) {
  const cur = existing.ANTHROPIC_API_KEY ?? "";
  const masked = cur ? `${cur.slice(0, 7)}…${cur.slice(-4)}` : "";
  const a = await ask(`ANTHROPIC_API_KEY${cur ? ` [keep ${masked}]` : " (paste, or Enter to set later)"}: `, cur);
  env.ANTHROPIC_API_KEY = a;
  if (!a) console.log("  ⚠ ANTHROPIC_API_KEY empty — Class 1 / 3 / combined will fail until set.");
}

// Optional LLM model override (Class 1 / 3 / combined) — Haiku default, Sonnet opt-in
if (needsKey) {
  const cur = existing.MNEMON_LLM_MODEL ?? "";
  const a = presetModel ?? await ask(`MNEMON_LLM_MODEL${cur ? ` [keep ${cur}]` : " [Enter = claude-haiku-4-5-20251001 default; type 'sonnet' for claude-sonnet-4-6]"}: `, cur);
  const resolved = a.trim().toLowerCase() === "sonnet" ? "claude-sonnet-4-6" : a;
  if (resolved) env.MNEMON_LLM_MODEL = resolved;
}

// HTTP API (Class 3 only)
if (wanted.has(3)) {
  const curT = existing.MNEMON_API_TOKEN ?? "";
  const defT = curT || ("mnemon-" + Math.random().toString(36).slice(2, 12));
  env.MNEMON_API_TOKEN = await ask(`MNEMON_API_TOKEN (bearer) [Enter for ${curT ? "keep" : "random " + defT.slice(0, 14) + "…"}]: `, defT);
  env.MNEMON_HTTP_PORT = await ask(`MNEMON_HTTP_PORT [${existing.MNEMON_HTTP_PORT ?? "7777"}]: `, existing.MNEMON_HTTP_PORT ?? "7777");
}

// Store location (all classes)
const defaultStore = existing.MNEMON_DATA ?? "";
const ds = await ask(`MNEMON_DATA (store dir) [${defaultStore || "~/.mnemon/store (default)"}]: `, defaultStore);
if (ds) env.MNEMON_DATA = ds;

// ─── Combined-server write-path picker (the UX gate for §4.2a / §3.4e) ─────────────────
// IMPORTANT: this is the *enforcement point* of the single-class-at-write contract.
// Operators don't get to pick "both" here — combined installs are single-write by
// construction. The chosen template is the only one referenced in the next-steps print.
let combinedWritePath: "class1" | "class2" = "class1";
if (wanted.has(COMBINED)) {
  const raw = (presetWritePath ?? await ask(
    `\nCombined-server write path:\n  [1] Class-1 'remember' (default — server-side QA + bi-temporal; recommended)\n  [2] Class-2 'assert_fact' (host-as-brain — only if your Claude Code session is meaningfully stronger than your MNEMON_LLM_MODEL)\nChoose [1 / 2]: `,
    "1",
  )).trim().toLowerCase();
  combinedWritePath = (raw === "2" || raw === "class2") ? "class2" : "class1";
  console.log(`  → primary write path: ${combinedWritePath === "class1" ? "Class-1 remember" : "Class-2 assert_fact"}`);
}

// Write .env
const out = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
writeFileSync(envPath, out);
const mode = (statSync(envPath).mode & 0o777).toString(8);
console.log(`\n✓ Wrote ${envPath}  (mode ${mode}) — chmod 600 for safety if it contains your API key.`);
if (mode !== "600") console.log(`  Recommend:  chmod 600 ${envPath}`);
console.log();

// ─── Next steps ───────────────────────────────────────────────────────────────────────
console.log("=== Next steps ===\n");
if (wanted.has(1)) {
  console.log("[Class 1] Register with Claude Code:");
  console.log(`  claude mcp add mnemon-cloud --scope user \\`);
  console.log(`    --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \\`);
  console.log(`    -- bun run ${join(HERE, "mcp-server.ts")}`);
  console.log(`  Then paste templates/CLAUDE.memory.class1.md into your agent's CLAUDE.md.`);
  console.log(`  Verify: bun run mcp-smoke.ts\n`);
}
if (wanted.has(2)) {
  console.log("[Class 2] Register with Claude Code (no API key needed for writes):");
  console.log(`  claude mcp add mnemon-local --scope user -- bun run ${join(HERE, "mcp-server-class2.ts")}`);
  console.log(`  Then paste templates/CLAUDE.memory.class2.md into your agent's CLAUDE.md.`);
  console.log(`  Verify: bun run mcp-smoke-class2.ts\n`);
}
if (wanted.has(3)) {
  console.log("[Class 3] Start the HTTP API server (any language can call it):");
  console.log(`  bun run ${join(HERE, "api-server.ts")}     # foreground; or launchctl/systemd for a service`);
  console.log(`  Verify:  curl -H "Authorization: Bearer $MNEMON_API_TOKEN" http://127.0.0.1:${env.MNEMON_HTTP_PORT ?? 7777}/health`);
  console.log(`  Then call: POST /remember + POST /recall  (see api-server.ts for the full surface).\n`);
}
if (wanted.has(COMBINED)) {
  const template = combinedWritePath === "class1" ? "CLAUDE.memory.combined.md" : "CLAUDE.memory.class2.md";
  console.log("[Combined] Register the combined MCP server with Claude Code:");
  console.log(`  claude mcp add mnemon --scope user \\`);
  console.log(`    --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \\`);
  console.log(`    -- bun run ${join(HERE, "mcp-server-combined.ts")}`);
  console.log(`  Then paste templates/${template} into your agent's CLAUDE.md.`);
  console.log(`    (This is your install's primary write path: ${combinedWritePath === "class1" ? "Class-1 'remember'" : "Class-2 'assert_fact'"}.`);
  console.log(`     Per §4.2a single-class-at-write contract — do NOT use the other write path on this install.)`);
  console.log(`  Verify: bun run mcp-smoke-combined.ts\n`);
}

console.log("Done. Re-run this script any time to change selection or update values.");
rl.close();
