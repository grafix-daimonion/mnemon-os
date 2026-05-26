// mcp-server-class2.ts — Mnemon's CLASS-2 MCP server: 9 LLM-free primitive verbs.
// The host (Claude Code) does extraction / faithfulness QA / contradiction judgment /
// recall reasoning using its OWN session credentials — no separate API key required.
//
// Connect:  claude mcp add mnemon-local -- bun run /ABS/PATH/mcp-server-class2.ts
// STDOUT is the MCP protocol channel — nothing else writes to it (MNEMON_QUIET=1).
process.env.MNEMON_QUIET = "1";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { initDb } from "./db.ts";
import { archive, assertFact, markSuperseded } from "./pipeline-class2.ts";
import { recallCandidates, keywordEvidence, history, readDiaryClass2 } from "./recall-class2.ts";
import { findEntity, resolveOrCreateEntity } from "./entity-class2.ts";

const DATA_DIR = process.env.MNEMON_DATA ?? join(homedir(), ".mnemon", "store");
const db = await initDb(DATA_DIR);

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });

const server = new McpServer({ name: "mnemon-class2", version: "1.0.0" });

server.registerTool("archive", {
  description: "L0 floor — store a verbatim turn (interaction + chunks + embeddings). No LLM. Returns interaction_id + chunk_ids the host then attaches to assert_fact calls.",
  inputSchema: { content: z.string(), speaker: z.string().nullable().optional(), occurred_at: z.string() },
}, async ({ content, speaker, occurred_at }) => text(await archive(db, content, speaker ?? null, occurred_at)));

server.registerTool("assert_fact", {
  description: "Persist a host-extracted + host-QA'd fact. Host has already verified the fact is supported by the source verbatim. Returns the new fact_id. Shape is auto-corrected to 'multi' for accumulator predicates (commitment/task/todo/responsible for/ownerships).",
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
}, async (args) => text(await assertFact(db, args as any)));

server.registerTool("mark_superseded", {
  description: "Apply the bi-temporal close — host has judged new_fact_id is a real reversal of old_fact_id (same topic, real change). Sets old_fact.valid_until = occurred_at, old_fact.superseded_by = new_fact_id, and rebuilds the day's Diary.",
  inputSchema: { old_fact_id: z.number(), new_fact_id: z.number(), occurred_at: z.string() },
}, async ({ old_fact_id, new_fact_id, occurred_at }) => text(await markSuperseded(db, old_fact_id, new_fact_id, occurred_at)));

server.registerTool("recall_candidates", {
  description: "Deterministic candidates for a question: bi-temporal facts in the subject's scope (recursive ownership traversal, status='confirmed', time-filtered) + hybrid keyword+vector chunk matches. The HOST picks the best one and reads its stance — server does no LLM reasoning.",
  inputSchema: {
    question: z.string(),
    subject: z.string().nullable().optional(),
    as_of: z.string().nullable().optional(),
    limit: z.number().optional(),
  },
}, async ({ question, subject, as_of, limit }) => text(await recallCandidates(db, question, subject ?? null, as_of ?? null, limit ?? 10)));

server.registerTool("keyword_evidence", {
  description: "HONEST-EMPTY arbiter — deterministic FTS over the verbatim. has_evidence=true means the query term appears somewhere (host should answer 'unresolved' if no fact resolved); false means genuinely no evidence (host says 'no record').",
  inputSchema: { query: z.string(), as_of: z.string().nullable().optional() },
}, async ({ query, as_of }) => text(await keywordEvidence(db, query, as_of ?? null)));

server.registerTool("history", {
  description: "Full timeline for a subject: every fact ever asserted, ordered by valid_from, plus the supersession map (which fact closed which). Deterministic — host reads + summarizes.",
  inputSchema: { subject: z.string() },
}, async ({ subject }) => text(await history(db, subject)));

server.registerTool("read_diary", {
  description: "The heavy-refs Diary — lossless, deterministic digest of CONFIRMED current-state for the most recent N days (default 3). Read-whole; no retrieval. Inline facts + pointers to source interactions.",
  inputSchema: { days: z.number().optional() },
}, async ({ days }) => text(await readDiaryClass2(db, days ?? 3)));

server.registerTool("find_entity", {
  description: "Look up an entity by label. Returns: exact_id (identity-by-label hit), OR alias_id (remembered variant), OR near_matches (fuzzy candidates with OSA distance + version_verdict — ADVISORY signals; the host owns the same-or-not call). Never creates anything.",
  inputSchema: { label: z.string(), type: z.string().optional(), scope: z.string().optional() },
}, async ({ label, type }) => text(await findEntity(db, label, type)));

server.registerTool("resolve_or_create_entity", {
  description: "Apply the host's identity decision. owner_decision = {kind:'reuse', entity_id} (use existing) | {kind:'merge_alias', entity_id} (record this label as a variant of existing entity; promotes type if more specific) | {kind:'create'} (mint new). NOTE: does NOT auto-create owner edges — the host must explicitly call assert_fact() for any ownership relation.",
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
}, async (args) => text(await resolveOrCreateEntity(db, args as any)));

const transport = new StdioServerTransport();
await server.connect(transport);
