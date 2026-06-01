// mcp-server-combined.ts — single MCP server exposing BOTH Class-1 and Class-2 verb
// surfaces against ONE shared store. Resolves the PGLite single-writer constraint
// (one process per data dir → one postmaster.pid lock holder) that made running
// separate Class-1 and Class-2 servers on the same store impossible.
//
// Why this exists: CLASS2_DESIGN_v3 §3.4 ("any combination") drew a picture of two
// MCP servers sharing a store, which PGLite physically prevents. Two paths to honour
// the intent: (a) move to real Postgres so both servers can attach (deployment
// change); (b) consolidate both verb surfaces into one process (this file).
// Recorded as F-MNEMON-20.
//
// Verbs exposed (13):
//   Class 1 (server-side LLM; needs ANTHROPIC_API_KEY):
//     remember · recall · recall_as_of · history       (history = human-readable text)
//   Class 2 (no LLM in server):
//     archive · assert_fact · mark_superseded · recall_candidates · keyword_evidence ·
//     read_diary · find_entity · resolve_or_create_entity · history_raw  (richer JSON)
//
// IMPORTANT: stdout is the MCP protocol channel — nothing else writes to it.
process.env.MNEMON_QUIET = "1";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { initDb } from "./db.ts";

// Class 1 (server-side LLM) — pulls in llm.ts → ANTHROPIC_API_KEY required at module load.
import { ingest } from "./pipeline.ts";
import { recall, recallAsOf } from "./recall.ts";

// Class 2 (no LLM in server) — independent of llm.ts.
import { archive, assertFact, markSuperseded, unmarkSuperseded } from "./pipeline-class2.ts";
import { recallCandidates, keywordEvidence, history as historyClass2, readDiaryClass2 } from "./recall-class2.ts";
import { findEntity, resolveOrCreateEntity } from "./entity-class2.ts";

// Decoupling v2 — Z1 (verbatim capture) + re_extract (Z2 reprocess trigger).
import { archiveTurn } from "./archive.ts";

const DATA_DIR = process.env.MNEMON_DATA ?? join(homedir(), ".mnemon", "store");
const db = await initDb(DATA_DIR);   // SINGLE attacher — one initDb call, one lock holder.

const say = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });

function fmtRecall(r: any): string {
  if (r.type === "answer")
    return `${r.answer}\n— source ${String(r.source_occurred_at).slice(0, 10)}: "${r.anchor}"`;
  if (r.type === "unresolved") return `Unresolved — ${r.reason}`;
  return `No evidence on record — ${r.reason}`;
}

const server = new McpServer({ name: "mnemon-combined", version: "1.0.0" });

/* ─── Class-1 high-level verbs (server-side LLM via Anthropic SDK) ─────────────────── */

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
  const result = await ingest(db, { content: text, speaker: "user", occurred_at: new Date().toISOString() }, { account: scope ?? null });
  const persisted = (await n()) - before;
  // Bridge fix per ASYNC_EXTRACTION_PLAN_v2 §10 — surface per-chunk + outer-loop failures.
  // Visibility close for W-MNEMON-26 (was: silent count masked failures).
  let msg = `Remembered. (${persisted} fact(s) from ${result.total_chunks} chunk(s)`;
  if (result.failed_chunks > 0)
    msg += `; ${result.failed_chunks} chunk(s) failed extraction — verbatim safe, retry possible`;
  if (result.outer_error)
    msg += `; pipeline error: ${result.outer_error.slice(0, 200)}`;
  msg += ".)";
  return say(msg);
});

server.registerTool("recall", {
  description:
    "Recall what is known about something from memory. Call this BEFORE answering anything that could " +
    "be in memory. Returns the CURRENT answer with the exact source words, or an honest 'no evidence'.",
  inputSchema: { question: z.string().describe("The natural-language question.") },
}, async ({ question }) => say(fmtRecall(await recall(db, question))));

server.registerTool("recall_as_of", {
  description:
    "Recall what was true AS OF a past date (e.g. 'what did I think about X back in March'). " +
    "Returns the state at that time, not the current state.",
  inputSchema: {
    question: z.string(),
    as_of: z.string().describe("A date, ISO preferred, e.g. 2026-03-01."),
  },
}, async ({ question, as_of }) => say(fmtRecall(await recallAsOf(db, question, new Date(as_of).toISOString()))));

server.registerTool("history", {
  description:
    "Human-readable timeline projection: returns a FORMATTED STRING ('YYYY-MM-DD → YYYY-MM-DD: predicate = object', one fact per line). " +
    "If you need structured data to process programmatically, use `history_raw` instead (returns {facts, supersessions} JSON). " +
    "Same underlying data — different projections, different contracts; pick by what the caller will do with it.",
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

/* ─── Class-2 primitive verbs (NO LLM in server) ─────────────────────────────────────── */

server.registerTool("archive", {
  description: "L0 floor — store a verbatim turn (interaction + chunks + embeddings). No LLM. Returns interaction_id + chunk_ids the host can then attach to assert_fact calls.",
  inputSchema: { content: z.string(), speaker: z.string().nullable().optional(), occurred_at: z.string() },
}, async ({ content, speaker, occurred_at }) => json(await archive(db, content, speaker ?? null, occurred_at)));

server.registerTool("assert_fact", {
  description: "Persist a host-extracted + host-QA'd fact. Host has already verified faithfulness against the source. Status auto-'confirmed'. Returns fact_id.",
  inputSchema: {
    subject_id: z.number(),
    predicate: z.string(),
    object_entity_id: z.number().nullable().optional(),
    object_literal: z.string().nullable().optional(),
    shape: z.enum(["single", "multi"]).optional(),
    source_chunk_ids: z.array(z.number()),
    source_span: z.string().nullable().optional(),
    occurred_at: z.string(),
    confidence: z.number().optional(),
  },
}, async (args) => json(await assertFact(db, args as any)));

server.registerTool("mark_superseded", {
  description: "Apply the bi-temporal close — host has judged new_fact_id is a real reversal of old_fact_id (same topic, real change). Sets valid_until + superseded_by + rebuilds Diary.",
  inputSchema: { old_fact_id: z.number(), new_fact_id: z.number(), occurred_at: z.string() },
}, async ({ old_fact_id, new_fact_id, occurred_at }) => json(await markSuperseded(db, old_fact_id, new_fact_id, occurred_at)));

server.registerTool("unmark_superseded", {
  description: "UNDO a supersession — reopen a fact closed by a prior mark_superseded call (clears valid_until + superseded_by). Use when the host's earlier supersession judgment was wrong. Idempotent: {ok:false} if not actually superseded. Logged as `class2.unmark_superseded` for audit. (F-MNEMON-22.)",
  inputSchema: { fact_id: z.number() },
}, async ({ fact_id }) => json(await unmarkSuperseded(db, fact_id)));

server.registerTool("recall_candidates", {
  description: "Deterministic candidates for a question: bi-temporal facts in the subject's scope + hybrid keyword+vector chunk matches. NO LLM reasoning here — host picks the answer.",
  inputSchema: {
    question: z.string(),
    subject: z.string().nullable().optional(),
    as_of: z.string().nullable().optional(),
    limit: z.number().optional(),
  },
}, async ({ question, subject, as_of, limit }) => json(await recallCandidates(db, question, subject ?? null, as_of ?? null, limit ?? 10)));

server.registerTool("keyword_evidence", {
  description: "HONEST-EMPTY arbiter — deterministic FTS over the verbatim. has_evidence=true → query term appears (mentioned but maybe unresolved); false → no evidence (host says 'no record').",
  inputSchema: { query: z.string(), as_of: z.string().nullable().optional() },
}, async ({ query, as_of }) => json(await keywordEvidence(db, query, as_of ?? null)));

server.registerTool("history_raw", {
  description:
    "Structured JSON projection: returns {facts:[…], supersessions:[…]} — the host formats / summarizes. " +
    "Counterpart to `history` (which returns formatted text). Same underlying data; pick `history_raw` when the caller needs " +
    "to process or re-shape the data, `history` when the caller just wants to read a timeline. Not a superset — a different contract.",
  inputSchema: { subject: z.string() },
}, async ({ subject }) => json(await historyClass2(db, subject)));

server.registerTool("read_diary", {
  description: "The heavy-refs Diary — lossless, deterministic digest of CONFIRMED current-state for the most recent N days (default 3). Read-whole; no retrieval needed.",
  inputSchema: { days: z.number().optional() },
}, async ({ days }) => json(await readDiaryClass2(db, days ?? 3)));

server.registerTool("find_entity", {
  description: "Look up an entity by label. Returns exact_id (identity-by-label hit), OR alias_id (remembered variant), OR near_matches (fuzzy candidates with OSA distance + version_verdict — ADVISORY signals; host owns the same-or-not call). Never creates anything.",
  inputSchema: { label: z.string(), type: z.string().optional(), scope: z.string().optional() },
}, async ({ label, type }) => json(await findEntity(db, label, type)));

server.registerTool("resolve_or_create_entity", {
  description: "Apply the host's identity decision. owner_decision = {kind:'reuse', entity_id} | {kind:'merge_alias', entity_id} (record this label as a variant of existing) | {kind:'create'} (mint new). Does NOT auto-create owner edges — host explicitly asserts ownership via assert_fact.",
  inputSchema: {
    label: z.string(),
    type: z.string(),
    owner_id: z.number().nullable().optional(),
    owner_decision: z.union([
      z.object({ kind: z.literal("reuse"), entity_id: z.number() }),
      z.object({ kind: z.literal("merge_alias"), entity_id: z.number() }),
      z.object({ kind: z.literal("create") }),
    ]).optional(),
  },
}, async (args) => json(await resolveOrCreateEntity(db, args as any)));

/* ─── Decoupling v2 verbs (Z1 capture + Z2 reprocess trigger) ─────────────────────────
 * Per DECOUPLING_IMPL_SPEC_v2 §5.1 + §5.2. No LLM in either verb; both are fast.
 * archive_turn: Z1 verbatim capture (chunks land at extraction_status='pending').
 * re_extract:   reset chunks to 'pending' so synapsis-worker.ts (Z2) reprocesses them.
 */

server.registerTool("archive_turn", {
  description:
    "Z1 verbatim capture (decoupling v2): persist a turn + chunks + embeddings. NO LLM CALL. Returns immediately; " +
    "chunks land at extraction_status='pending' for synapsis-worker.ts (Z2) to process asynchronously. " +
    "Use this as the host-driven Z1 ingest path; legacy /save → ingest() retains the inline-extract behaviour.",
  inputSchema: {
    text: z.string().describe("The turn content."),
    speaker: z.string().nullable().optional().describe("Speaker name (Owner / AI persona / arbitrary). NULL allowed."),
    occurred_at: z.string().optional().describe("ISO8601 timestamp; defaults to server now()."),
  },
}, async ({ text, speaker, occurred_at }) =>
  json(await archiveTurn(db, text, speaker ?? null, occurred_at ?? new Date().toISOString())));

server.registerTool("re_extract", {
  description:
    "Reset chunks to extraction_status='pending' so synapsis-worker.ts (Z2) reprocesses them with the current " +
    "extractor. Cheap iteration verb — re-extract over stored verbatim without re-capture. " +
    "Scope: {interaction_id} (one interaction), {since: ISO8601} (chunks newer than), or {} (ALL chunks).",
  inputSchema: {
    interaction_id: z.number().optional(),
    since: z.string().optional().describe("ISO8601 cutoff; reset chunks whose interaction.occurred_at >= since."),
  },
}, async ({ interaction_id, since }) => {
  let r: { rows: { id: number }[] };
  if (interaction_id != null) {
    r = await db.query<{ id: number }>(
      `update chunks set extraction_status = 'pending'
        where interaction_id = $1 and extraction_status <> 'pending'
        returning id`,
      [interaction_id]);
  } else if (since) {
    r = await db.query<{ id: number }>(
      `update chunks c set extraction_status = 'pending'
         from interactions i
        where c.interaction_id = i.id
          and i.occurred_at >= $1
          and c.extraction_status <> 'pending'
        returning c.id`,
      [since]);
  } else {
    r = await db.query<{ id: number }>(
      `update chunks set extraction_status = 'pending' where extraction_status <> 'pending' returning id`);
  }
  return json({ chunks_reset: r.rows.length });
});

await server.connect(new StdioServerTransport());
