// setup.ts — interactive Mnemon installer. Asks which install path(s) to enable,
// writes .env, points at the right CLAUDE.memory template, and prints the next commands.
// Runs in seconds; no API calls; idempotent (re-run any time).
//
//   bun run setup.ts                          # interactive
//   bun run setup.ts --classes=1,3 --yes      # non-interactive (CI / scripted)
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`)); if (i < 0) return undefined; const a = args[i]; return a.includes("=") ? a.split("=").slice(1).join("=") : (args[i + 1] ?? ""); };
const has = (k: string) => args.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const auto = has("yes");
const presetClasses = flag("classes");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def = ""): Promise<string> => {
  if (auto) return def;
  const a = (await rl.question(q)).trim();
  return a || def;
};

console.log(`
🧠  Mnemon setup
────────────────

Three install paths — pick one, or any combination:

  [1] Class 1 — Anthropic API key, MCP into Claude Code
                The server does the LLM work; you call remember/recall.
                Cost ~$5–25/month. Self-contained. Measured quality.

  [2] Class 2 — Claude Code subscription, MCP (NO API key)
                The server is dumb storage; YOU (Claude Code) do the LLM work
                using your subscription. Multi-step verbs; no extra billing.

  [3] Class 3 — Anthropic API key, HTTP API (any language; no Claude Code)
                Standalone HTTP service. Python / Ruby / Go / curl can call it.
                Same server-side engine as Class 1, different transport.

See BACKENDS.md for the full trade-off table.
`);

const choice = presetClasses ?? await ask("Choose [1 / 2 / 3 / all, or e.g. '1,3']: ", "all");
const wanted = new Set<number>();
if (choice.trim().toLowerCase() === "all") [1, 2, 3].forEach((n) => wanted.add(n));
else choice.split(/[\s,]+/).forEach((c) => { const n = parseInt(c, 10); if ([1, 2, 3].includes(n)) wanted.add(n); });
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

// Anthropic key (Class 1 / 3)
if (wanted.has(1) || wanted.has(3)) {
  const cur = existing.ANTHROPIC_API_KEY ?? "";
  const masked = cur ? `${cur.slice(0, 7)}…${cur.slice(-4)}` : "";
  const a = await ask(`ANTHROPIC_API_KEY${cur ? ` [keep ${masked}]` : " (paste, or Enter to set later)"}: `, cur);
  env.ANTHROPIC_API_KEY = a;
  if (!a) console.log("  ⚠ ANTHROPIC_API_KEY empty — Class 1 / 3 will fail until set.");
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

// Write .env
const out = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
writeFileSync(envPath, out);
const mode = (statSync(envPath).mode & 0o777).toString(8);
console.log(`\n✓ Wrote ${envPath}  (mode ${mode}) — chmod 600 for safety if it contains your API key.\n`);

// Next steps
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
  console.log("[Class 2] Register with Claude Code (no API key needed):");
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

console.log("Done. Re-run this script any time to change class selection or update values.");
rl.close();
