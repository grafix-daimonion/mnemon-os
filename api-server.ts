// api-server.ts — Mnemon HTTP API (Class 3 transport): same engine, different door.
// For agents / scripts / web apps that DON'T use Claude Code, but have an Anthropic
// API key and want Mnemon as a memory service over HTTP/JSON. Wraps the Class-1 verbs
// (`remember`, `recall`, `recall_as_of`, `history`) — extraction + QA happen server-side.
//
// Run:    ANTHROPIC_API_KEY=... bun run api-server.ts
// Env:    MNEMON_DATA       store dir (default ~/.mnemon/store)
//         MNEMON_HTTP_PORT  port (default 7777)
//         MNEMON_API_TOKEN  bearer token; if set, required. If unset, localhost-only is recommended.
//         MNEMON_HTTP_HOST  bind host (default 127.0.0.1 — localhost only)
process.env.MNEMON_QUIET = "1";

import { homedir } from "node:os";
import { join } from "node:path";
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { recall, recallAsOf } from "./recall.ts";

const DATA_DIR = process.env.MNEMON_DATA ?? join(homedir(), ".mnemon", "store");
const PORT = parseInt(process.env.MNEMON_HTTP_PORT ?? "7777", 10);
const HOST = process.env.MNEMON_HTTP_HOST ?? "127.0.0.1";
const TOKEN = process.env.MNEMON_API_TOKEN ?? "";

const db = await initDb(DATA_DIR);
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function authFail(req: Request): Response | null {
  if (!TOKEN) return null;
  const a = req.headers.get("authorization") ?? "";
  if (!a.startsWith("Bearer ") || a.slice(7) !== TOKEN)
    return json({ error: "unauthorized" }, 401);
  return null;
}

async function readJson<T>(req: Request): Promise<T> {
  try { return await req.json() as T; }
  catch { throw new Error("invalid JSON body"); }
}

console.error(`Mnemon HTTP API: http://${HOST}:${PORT}  data=${DATA_DIR}  auth=${TOKEN ? "bearer" : "none (localhost-only)"}`);

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const unauth = authFail(req);
    if (unauth) return unauth;
    const url = new URL(req.url);
    try {
      // GET / — service info
      if (req.method === "GET" && url.pathname === "/") {
        return json({
          engine: "mnemon",
          class: 1,
          verbs: [
            { method: "POST", path: "/remember", body: "{text, speaker?, occurred_at?, account?}" },
            { method: "POST", path: "/recall", body: "{question, as_of?}" },
            { method: "GET",  path: "/history?subject=…" },
            { method: "GET",  path: "/health" },
          ],
        });
      }
      if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });

      // POST /remember — full ingest (extract + QA + persist + Diary)
      if (req.method === "POST" && url.pathname === "/remember") {
        const body = await readJson<{ text: string; speaker?: string | null; occurred_at?: string; account?: string | null }>(req);
        if (!body.text) return json({ error: "text required" }, 400);
        await ingest(db, {
          content: body.text,
          speaker: body.speaker ?? null,
          occurred_at: body.occurred_at ?? new Date().toISOString(),
        }, { account: body.account ?? null });
        return json({ ok: true });
      }

      // POST /recall — current (omit as_of) or as-of (with as_of)
      if (req.method === "POST" && url.pathname === "/recall") {
        const body = await readJson<{ question: string; as_of?: string }>(req);
        if (!body.question) return json({ error: "question required" }, 400);
        const r = body.as_of ? await recallAsOf(db, body.question, body.as_of) : await recall(db, body.question);
        return json(r);
      }

      // GET /history?subject=… — stream of facts (current + superseded) for a subject
      if (req.method === "GET" && url.pathname === "/history") {
        const subject = url.searchParams.get("subject");
        if (!subject) return json({ error: "subject query param required" }, 400);
        const ent = await db.query<{ id: number }>(`select id from entities where lower(label) = lower($1) limit 1`, [subject]);
        if (!ent.rows.length) return json({ facts: [] });
        const facts = (await db.query<any>(
          `select f.id, f.predicate, coalesce(f.object_literal, oe.label) as object,
                  f.shape, f.status, f.valid_from, f.valid_until, f.superseded_by,
                  i.occurred_at as source_occurred_at
           from facts f
           join interactions i on i.id = f.source_interaction_id
           left join entities oe on oe.id = f.object_entity_id
           where f.subject_id = $1 order by f.valid_from asc`, [ent.rows[0].id])).rows;
        return json({ facts });
      }

      return json({ error: "not found", path: url.pathname }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});
