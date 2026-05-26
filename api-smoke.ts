// api-smoke.ts — end-to-end smoke for the Class-3 HTTP API.
// Spawns api-server.ts on a random local port, hits remember + recall + history + health.
// Uses an isolated _smoke_api store and a random bearer token (verifies auth works too).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const SMOKE_DIR = join(import.meta.dir, "data", "_smoke_api");
try { rmSync(SMOKE_DIR, { recursive: true, force: true }); } catch {}

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const TOKEN = "test-" + Math.random().toString(36).slice(2, 10);
const BASE = `http://127.0.0.1:${PORT}`;

const proc = spawn("bun", ["run", "api-server.ts"], {
  cwd: import.meta.dir,
  env: { ...process.env, MNEMON_DATA: SMOKE_DIR, MNEMON_HTTP_PORT: PORT, MNEMON_API_TOKEN: TOKEN } as Record<string, string>,
  stdio: ["ignore", "pipe", "pipe"],
});
// Surface server errors but ignore stdout/stderr noise
proc.stderr?.on("data", () => {});
proc.stdout?.on("data", () => {});

// Wait for the server to become reachable
const start = Date.now();
let up = false;
while (Date.now() - start < 10000) {
  try {
    const r = await fetch(`${BASE}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.ok) { up = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.error("server did not start within 10s"); proc.kill(); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${extra ? "  — " + extra : ""}`); };
const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

// 1. service info
const info = await (await get("/")).json() as any;
ok("GET / returns service info", info.engine === "mnemon" && Array.isArray(info.verbs), JSON.stringify(info.verbs?.length));

// 2. auth: no token → 401
const noAuth = await fetch(`${BASE}/health`);
ok("auth: missing bearer → 401", noAuth.status === 401);
const badAuth = await fetch(`${BASE}/health`, { headers: { authorization: "Bearer wrong" } });
ok("auth: bad bearer → 401", badAuth.status === 401);

// 3. POST /remember (full ingest via Class-1 engine)
// Bridge fix per ASYNC_EXTRACTION_PLAN_v2 §10: response now surfaces chunk-level state.
const rem = await (await post("/remember", { text: "Acme's contract renewal is in November.", occurred_at: "2026-05-26T10:00:00Z" })).json() as any;
ok("POST /remember → {ok:true, persisted, total_chunks, failed_chunks, outer_error}",
   rem.ok === true && typeof rem.persisted === "number" && typeof rem.total_chunks === "number"
   && typeof rem.failed_chunks === "number" && (rem.outer_error === null || typeof rem.outer_error === "string"),
   JSON.stringify(rem));

// 4. POST /recall (current)
const rec = await (await post("/recall", { question: "When is Acme's contract renewal?" })).json() as any;
ok("POST /recall returns an answer", rec.type === "answer" && typeof rec.answer === "string", `${rec.type}/${rec.via} → "${rec.answer}"`);

// 5. Honest-empty for a never-mentioned term
const empty = await (await post("/recall", { question: "What did Zorgon decide?" })).json() as any;
ok("POST /recall on absent name → honest_empty", empty.type === "honest_empty", empty.type);

// 6. GET /history (we may not have an Acme entity yet — depends on extraction; just check the endpoint shape)
const hist = await (await get("/history?subject=Acme")).json() as any;
ok("GET /history returns {facts: []}", Array.isArray(hist.facts), `${hist.facts?.length ?? 0} facts`);

// 7. 404
const nf = await get("/nonsense");
ok("unknown path → 404", nf.status === 404);

proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
