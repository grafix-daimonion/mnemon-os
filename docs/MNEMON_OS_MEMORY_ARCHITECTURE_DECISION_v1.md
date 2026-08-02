# Mnemon_OS — Memory Architecture Decision: Verbatim/Extraction Decoupling

## Document Control

| Field | Value |
|-------|-------|
| Title | Memory Architecture Decision — verbatim/extraction decoupling + storage substrate |
| Status | **Draft v1 — for team review.** Decisions D1–D2 recommended; open questions Q1–Q4 pending. |
| Date | 2026-06-01 |
| Author | Chatzi (drafted during the Mnemon_OS v8 evaluation + wiring session) |
| Scope | How Mnemon stores/extracts memory and wires to Claude Code. NOT persona content. |
| Engine baseline | Mnemon_OS **v8** (single-Owner, MCP, Bun/PGLite) — the built engine, as cloned from `grafix-daimonion/mnemon-os`. |

---

## 1. Context

We are wiring Mnemon as the live memory for an AI Executive Assistant (Pythia/Betty) that
learns Chatzi's persona from ongoing conversations. Two architecture questions surfaced and
need a team decision before we build further:

1. **Storage substrate / writer model** — how memory is written, given PGLite is single-writer.
2. **How the verbatim and the extraction relate** — currently coupled; proposed decoupled.

This note records the idea, the recommended decisions, current state, and next steps.

---

## 2. The idea — verbatim and extraction as independent processes

**Today:** a `/save` (or `remember`) stores the verbatim AND runs extraction **inline**, in one
synchronous pipeline. Improving the extractor therefore forces a **full re-ingest** (re-chunk,
re-embed, re-extract).

**Proposed:** split the write path into two **independent** processes over the same verbatim:

- **Verbatim capture** — instant, lossless, canonical. Store interaction → chunks → embeddings.
  This is the floor; it must never be lost or blocked.
- **Extraction** — a separate, re-runnable process that reads the stored verbatim and produces
  facts (world-facts + four-lens persona/feedback). Can run later, be retried, or be re-run with
  a better prompt **without re-capturing the verbatim.**

**At recall, both layers surface independently** (the engine's 5-verdict surface):
`fact` (from extraction) · `verbatim` (raw chunk) · `verbatim_pending` (captured, extraction not
yet done) · `verbatim_quarantined` (captured, extraction failed QA) · `honest_empty` (nothing in
the source). Same verbatim, independent retrieval channels.

**Why it's the right shape:**
- It is the engine's **own intended design** — "Four Zones," verbatim-is-canonical, facts as a
  rebuildable projection. The **recall side is already built** (`recall.ts` falls back from the
  fact layer to the verbatim floor; `keyword_evidence` is a verbatim-only channel). The missing
  work is the **write-side decoupling** (designed-not-built: `archive_turn`, `chunks.extraction_status`,
  separate extraction trigger).
- **Cheaper iteration:** re-extract over stored verbatim instead of re-ingesting. (We re-ran the
  four-lens prompt ~4× this session — each was a full re-ingest. Decoupling makes that a cheap
  re-extract.)
- **Honest-empty robustness:** the verbatim still answers even when extraction missed or failed.
- **Capture now, extract better later.**

---

## 3. Decisions

### D1 — Writer model: **Option A now → Option B on trigger** (recommended)

PGLite is **single-writer**. The combined MCP server (spawned by Claude Code) is that one writer.

- **Option A — single server, MCP-client for everything** (current substrate). One process opens
  the store; all writes — live + batch — go through its verbs. No collision; works now; no new
  infra. **Cost:** batch ingestion must route through MCP or run only when sessions are closed
  (it cannot direct-attach), and two sessions can't write at once.
- **Option B — Postgres backend** (multi-writer). The interactive session and a background
  extraction worker run concurrently with no lock contention. The correct end-state for an
  always-on learning EA — and the substrate SOUL.md / the v9–v12 track already assume.

**Why not just "A is enough":** the persona-learning loop is inherently a **heavy, concurrent,
background** job (the four-lens pass takes minutes + real tokens). Single-writer A cannot host a
background extractor running *alongside* an always-on session — the lock collides, and the
MCP-client workaround serializes the heavy pass through the live server, lagging interactive
recall. So A is the best **start**, not the best **end-state**.

**The decoupling in §2 is itself the trigger:** two genuinely independent processes (verbatim +
extraction) is a multi-writer workload. Building it nudges us to B sooner.

> **Decision:** Run A now to validate the loop. Treat B (Postgres) as a **scheduled** migration,
> not hypothetical. Do not architect around single-writer as if it were permanent.
> **Migration trigger:** the first time we want background extraction concurrent with live sessions.

### D2 — Session-start load: **SessionStart hook** (recommended)

How the agent loads working memory at the start of each session (per SOUL.md: date-check → read
recent diary → wait). Options: (A) `@`-import in CLAUDE.md, (B) plain instruction, (C) SessionStart
hook. **Recommend C** — deterministic, model-version-proof. The CLAUDE.md instruction we installed
is the soft fallback (B); it relies on the agent choosing to recall-first.

### D3 — Integration surface (settled)

**MCP** is the Claude Code integration surface (not HTTP). HTTP REST is the v12/cloud track.

---

## 4. Current state

**Wired (this session):**
- Combined MCP server registered (`--scope user`, `~/.claude.json`), **connected**, env-anchored:
  `MNEMON_OWNER=Chatzi`, `MNEMON_AI_PERSONAS=Pythia,Dev,Dimi,Betty`. Store: `~/.mnemon/store`.
- `CLAUDE.md` memory rules installed (generic v8 combined template — recall-first / honest-empty).

**On branch `feat/lock4-lock2-persona-sub-kinds` (committed, not merged):**
- **Lock 4** — `Person:Human` / `Persona:AI` sub-kinds; identity types sticky in `promoteType`.
- **Lock 2 (slice)** — deterministic Owner/AI anchoring (Owner → Person:Human, not hardcoded `org`).
- **Four-lens persona/feedback extraction** — preferences/values (supersede-on-change),
  marker-gated directives (default-to-preference), and accumulating feedback (corrected/erred/praised).
  Validated on a 2K-token slice: clean typing, ~0 noise, genuine Chatzi trait capture.

**Designed-not-built (relevant):** the verbatim/extraction async split (`archive_turn`,
`chunks.extraction_status`, separate extraction trigger); Postgres backend; the v12 surfaces
SOUL.md assumes (HTTP, 5-verdict pending/quarantined, promotion state machine, plugins).

---

## 5. Postgres path (Option B substrate)

**Requirements (light):** PostgreSQL **16** · **pgvector ≥ 0.5** (for `vector(384)` + HNSW) · FTS
is built-in (no extension). No `pg_search` needed.

**Install (macOS/Homebrew):**
```bash
brew install postgresql@16 pgvector
brew services start postgresql@16
createdb mnemon && psql mnemon -c 'CREATE EXTENSION vector;'
```

**Code change (contained):** `db.ts` is PGLite-only and every module is typed to `PGlite`. To run
on a server we need: (1) a Postgres connection path in `db.ts` (env e.g. `MNEMON_PG_URL`);
(2) a thin query-API adapter (`db.query` maps cleanly; `db.exec` is PGLite-specific);
(3) run `schema.sql`. **Bonus:** the HNSW indexes PGLite silently skips will build → faster recall.
The author already flagged this intent (`mcp-server-combined.ts:8`).

---

## 6. Next steps (ordered)

1. **Finish wiring A** — add a SessionStart hook (D2) to load the diary/working memory; ensure any
   batch ingestion routes through MCP (no direct-attach against the live store).
2. **Validate the persona loop on A** — transcript ingestion via the MCP-client path (or sessions
   closed); confirm four-lens persona facts land and recall surfaces fact + verbatim independently.
3. **Install Postgres + pgvector** locally (§5) — no-op until wired; de-risks the migration.
4. **`db.ts` Postgres backend** — connection env + query adapter + run schema. Unlocks Option B.
5. **Build the verbatim/extraction decoupling** (§2) on Postgres — `archive_turn`,
   `extraction_status`, separate extraction trigger (the Four-Zones async split).
6. **Resolve the open questions below**, then merge the persona branch.

---

## 7. Open questions (team decision)

- **Q1 — Persona schema.** Betty redesign models persona as entity *types* (`Trait`/`Like`/`Dislike`/
  `Error`/`Improvement`); this session's work models it as *predicates* (`design: prefers`,
  `corrected`, …). Pick one. (Predicates fit Mnemon's S-P-O grain and sidestep the type-namespace
  collision the Betty review flagged in §2.2.)
- **Q2 — Single-class-at-write contract.** Install is Class-1 primary (`remember`). Async extraction
  writing via Class-2 makes it *mixed-write*, which `CLASS2_DESIGN_v6 §3.4d` rejects. Switch to
  Class-2-primary, or document a Synapsis exemption?
- **Q3 — Persona/engine version gap.** SOUL.md is written for **v12** (HTTP, 5-verdict, promotion
  state machine, plugins); the running engine is **v8** (MCP, 3-state). Down-port the soul's
  operational half to v8, or upgrade the engine?
- **Q4 — Predicate naming.** The new `corrected` feedback predicate sits next to the planned Lock 6
  `corrects` relation — disambiguate before they collide (cf. the Betty review's `contradicts` flag).

---

*Recommendation: adopt D1 (A now → B on trigger) and D2 (SessionStart hook); proceed with steps
1–3 immediately; bring Q1–Q4 to the design-lock pass before merging the persona branch.*
