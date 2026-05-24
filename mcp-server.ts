// mcp-server.ts — exposes Mnemon's verbs to Claude Code (or any MCP client) over stdio.
// Connect:  claude mcp add mnemon -- bun run /ABS/PATH/mcp-server.ts
// Verbs:    remember · recall · recall_as_of · history   (tool descriptions are load-bearing —
//           they're what makes plain-language intent trigger the right call).
//
// IMPORTANT: stdout is the MCP protocol channel. Nothing else may write to it — so we silence the
// pipeline's progress logging (MNEMON_QUIET); the decision log still goes to a file, warnings to stderr.
process.env.MNEMON_QUIET = "1";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { initDb } from "./db.ts";
import { ingest } from "./pipeline.ts";
import { recall, recallAsOf } from "./recall.ts";

// One persistent, file-backed store (survives restarts). Override with MNEMON_DATA.
const DATA_DIR = process.env.MNEMON_DATA ?? join(homedir(), ".mnemon", "store");
const db = await initDb(DATA_DIR);

const say = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

function format(r: any): string {
  if (r.type === "answer")
    return `${r.answer}\n— source ${String(r.source_occurred_at).slice(0, 10)}: "${r.anchor}"`;
  if (r.type === "unresolved") return `Unresolved — ${r.reason}`;
  return `No evidence on record — ${r.reason}`;
}

const server = new McpServer({ name: "mnemon", version: "0.1.0" });

server.registerTool("remember", {
  description:
    "Save a durable fact, decision, preference, or commitment THE USER asserted, to long-term memory. " +
    "Use when the user states something worth remembering or says 'remember this'. " +
    "Record what the USER asserted — not your own suggestions. Re-saving is safe (deduped).",
  inputSchema: {
    text: z.string().describe("The fact/decision/preference, in the user's words."),
    scope: z.string().optional().describe("Optional owner/account this concerns (scopes ownership)."),
  },
}, async ({ text, scope }) => {
  const n = async () => (await db.query<{ n: number }>(`select count(*)::int n from facts`)).rows[0].n;
  const before = await n();
  await ingest(db, { content: text, speaker: "user", occurred_at: new Date().toISOString() }, { account: scope ?? null });
  return say(`Remembered. (${(await n()) - before} fact(s) extracted.)`);
});

server.registerTool("recall", {
  description:
    "Recall what is known about something from memory. Call this BEFORE answering anything that could " +
    "be in memory. Returns the CURRENT answer with the exact source words, or an honest 'no evidence'.",
  inputSchema: { question: z.string().describe("The natural-language question.") },
}, async ({ question }) => say(format(await recall(db, question))));

server.registerTool("recall_as_of", {
  description:
    "Recall what was true AS OF a past date (e.g. 'what did I think about X back in March'). " +
    "Returns the state at that time, not the current state.",
  inputSchema: {
    question: z.string(),
    as_of: z.string().describe("A date, ISO preferred, e.g. 2026-03-01."),
  },
}, async ({ question, as_of }) => say(format(await recallAsOf(db, question, new Date(as_of).toISOString()))));

server.registerTool("history", {
  description: "Show how a subject's facts changed over time — current and superseded — with validity windows.",
  inputSchema: { subject: z.string().describe("A person or org name.") },
}, async ({ subject }) => {
  const rows = (await db.query<any>(
    `select f.predicate, coalesce(f.object_literal, oe.label) as object,
            to_char(f.valid_from, 'YYYY-MM-DD') as from_date,
            coalesce(to_char(f.valid_until, 'YYYY-MM-DD'), 'current') as until
     from facts f join entities s on s.id = f.subject_id
     left join entities oe on oe.id = f.object_entity_id
     where lower(s.label) = lower($1) order by f.valid_from`, [subject])).rows;
  if (!rows.length) return say(`No history on record for "${subject}".`);
  return say(rows.map((r) => `${r.from_date} → ${r.until}:  ${r.predicate} = ${r.object}`).join("\n"));
});

await server.connect(new StdioServerTransport());
