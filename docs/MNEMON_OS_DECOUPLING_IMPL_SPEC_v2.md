# MNEMON_OS — Option B: Postgres Multi-Writer + Verbatim/Extraction Decoupling — Implementation Spec v2

## Document Control

| Field | Value |
|-------|-------|
| Title | Option B — Postgres backend + verbatim/extraction decoupling (FULL implementation) |
| Version | **v2 (build-ready — send to Dev)** |
| Status | **🟢 LOCKED FOR BUILD.** Architect directive (Chatzi, 2026-06-01): *"move now — full implementation of Option B."* Supersedes the "A now → B on trigger" phasing of the decision doc; **B is built directly.** |
| Date | 2026-06-01 |
| Role model | **Design:** Chatzi + Claude (this spec). **Build:** Dev. **QA / acceptance:** Chatzi + Claude (§11). |
| Implements | `MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md` — D1 (resolved to **B-now**), D2, Q1, Q2, Q4. |
| Engine baseline | Mnemon_OS **v8** — `grafix-daimonion/mnemon-os`, branch `feat/lock4-lock2-persona-sub-kinds` (Lock 4 + Lock 2 + four-lens persona extraction committed). |
| Supersedes | `MNEMON_OS_DECOUPLING_IMPL_SPEC_v1.md` (phased A/B draft; retained). |

### Status legend
🟢 SHIPPED (in tree) · 🟡 PARTIAL (exists, extend) · 🔴 NEW (build) · 📌 LOCKED · ❓ OPEN-FOR-DEV

### Self-containment note
Per the Spec Grader rule (*"a builder handed only this file must be able to build it"*): all DDL,
verb shapes, file changes, status transitions, and acceptance gates are **inline**. No "inherits §X."

---

## 1. Summary, scope, goals

### 1.1 What Dev builds
1. **Postgres backend** — move Mnemon's store from embedded PGLite to local **PostgreSQL 16 + pgvector**,
   enabling true multi-writer concurrency and HNSW vector indexes.
2. **Verbatim/extraction decoupling** — split the write path into two independent processes over the
   same verbatim: **(Z1) verbatim capture** (fast, lossless) and **(Z2) extraction** (separate,
   re-runnable, runs as a **standalone worker process** concurrent with the live server).
3. **5-verdict recall** — surface the two layers independently.

### 1.2 Why (rationale)
- **Concurrency:** the always-on EA runs background extraction *alongside* live sessions. Single-writer
  PGLite serializes the heavy four-lens pass through the live server (lagging interactive recall);
  Postgres removes that. **This is the trigger — it has fired.**
- **Iteration cost:** re-extract over stored verbatim without re-capturing (prompt iteration becomes cheap).
- **Robustness:** the verbatim floor still answers recall even when extraction missed/failed.

### 1.3 In scope
WS-1 Postgres backend · WS-2 decoupling (Z1 capture, Z2 standalone worker, `extraction_status`,
`re_extract`) · WS-3 5-verdict recall · WS-4 persona schema (Q1) + `received_correction` rename (Q4)
· WS-5 SessionStart hook (D2) · WS-6 Synapsis-exemption contract note (Q2).

### 1.4 Non-goals (out)
v12 surfaces (HTTP REST, promotion state machine, plugin tables, 202 flow); multi-tenant; cloud
deployment; SOUL.md down-port. These are the v9/v12 track.

---

## 2. Architecture

### 2.1 Write path — before / after

```
BEFORE (v8 inline — pipeline.ts ingest()):
  /save(text) ─► [store verbatim → chunk → embed] ─► [extract → QA → resolve → contradiction → diary]
                 └──── one synchronous call · one writer · re-run = re-capture ────┘

AFTER (Option B — decoupled, multi-writer on Postgres):
  Z1  archive_turn(text,speaker,occurred_at)  ─►  interaction → chunks(embed) → extraction_status='pending'
        [combined MCP server · fast · no LLM]       returns {interaction_id, chunk_ids, run_id}
  Z2  synapsis-worker.ts  (SEPARATE PROCESS)  ─►  claim chunks WHERE status='pending' FOR UPDATE SKIP LOCKED
        [concurrent with live server]               → four-lens extract → QA → resolve → contradiction → diary
                                                     → status='extracted' | 'quarantined'
  re_extract(scope)  ─►  reset matching chunks → 'pending'  →  Z2 reprocesses (no re-capture)
```

### 2.2 Writer model — Option B (📌 LOCKED)
- **Postgres is the store.** Multiple processes attach: the **combined MCP server** (Z1 capture +
  reads, spawned by Claude Code) and the **standalone `synapsis-worker.ts`** (Z2 extraction) run
  **concurrently**, coordinated by row-level locks — not a single-writer constraint.
- **Single-logical-writer (Q2):** Z1 + Z2 are two physical entry points of **one logical writer
  (Synapsis)** over the same verbatim — not "mixed-write" (see §12). pgvector HNSW indexes (skipped
  under PGLite) now build → faster vector recall.

### 2.3 Recall (extended in WS-3)
`recall.ts` already does fact→verbatim fallback (`recall.ts:159-197`) + keyword-only honest-empty
arbiter (`recall.ts:136-143`). WS-3 reads `chunks.extraction_status` to distinguish pending/quarantined.

---

## 3. Component inventory (files)

| File | Action | Change |
|------|--------|--------|
| `db.ts` | 🔴 MODIFY | Postgres connection (env `MNEMON_PG_URL`); `Db` interface + adapter so all modules accept Postgres or PGLite; run `schema.sql`. (WS-1) |
| `schema.sql` | 🔴 MODIFY | `chunks.extraction_status` column + partial index + forward-compat `ALTER`. (WS-2) |
| `archive.ts` | 🔴 NEW | Z1 verbatim capture (wraps `pipeline-class2.ts:archive`; sets `extraction_status='pending'`; returns `run_id`). (WS-2) |
| `synapsis-worker.ts` | 🔴 NEW | Z2 standalone worker: claim pending chunks → extract → QA → resolve → contradiction → diary → set status. (WS-2) |
| `pipeline.ts` | 🟡 MODIFY | Factor per-chunk extraction body (`pipeline.ts:259-345`) into a reusable `extractChunk()` Z2 calls; `ingest()` retained for eval/back-compat. (WS-2) |
| `extract.ts` | 🟡 MODIFY | Q4: `corrected → received_correction`; Q1 predicate scheme (already on branch). (WS-4) |
| `recall.ts` | 🟡 MODIFY | `RecallResult.via` → 4 values; read `extraction_status`. (WS-3) |
| `mcp-server-combined.ts` | 🟡 MODIFY | Register `archive_turn`, `re_extract`; `remember` → Z1 + enqueue; thread `speaker`/owner/personas (today `speaker:"user"` hardcoded at `:67`). (WS-2/WS-4) |
| `.claude/hooks/session-start.sh` | 🔴 NEW | SessionStart hook: load `read_diary` recent. (WS-5) |
| `migrations/001…003` | 🔴 NEW | §9. |

---

## 4. Data model (inline DDL)

### 4.1 `chunks.extraction_status` 🔴 NEW
Current `chunks` (`schema.sql:23-30`): `id, interaction_id, ord, content, embedding, created_at`. Add:
```sql
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending'
  CHECK (extraction_status IN ('pending','extracted','quarantined'));

CREATE INDEX IF NOT EXISTS chunks_pending
  ON chunks (id) WHERE extraction_status = 'pending';        -- Z2 claim scan
```
**State machine:** `pending` (Z1 captured, Z2 not done) → `extracted` (Z2 ran, ≥0 facts, QA passed) |
`quarantined` (Z2 ran, all facts failed faithfulness QA). `re_extract` resets to `pending`.

### 4.2 `synapsis_runs` 🔴 NEW (observability + the `run_id` from `archive_turn`)
```sql
CREATE TABLE IF NOT EXISTS synapsis_runs (
  id             bigserial primary key,
  interaction_id bigint references interactions(id),
  stage          text NOT NULL CHECK (stage IN ('capture','extract')),
  status         text NOT NULL CHECK (status IN ('running','completed','failed')),
  chunks_total   int  NOT NULL DEFAULT 0,
  chunks_ok      int  NOT NULL DEFAULT 0,
  chunks_failed  int  NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
```

### 4.3 HNSW indexes (Postgres) 🟢 already in `schema.sql`
`schema.sql:111-124` defines HNSW indexes on `chunks.embedding` / `facts.embedding` — **skipped under
PGLite, built on Postgres.** No change needed; they activate on the new backend (a free recall speedup).

### 4.4 No persona schema change
Q1 is **predicate-based** (`(Chatzi, design: prefers, "X")`) — composes with the existing
`facts` bi-temporal columns. No new types/columns. Lock 4 sub-kinds + feedback predicates already ship.

---

## 5. Verb / API surface (MCP, inline shapes)

### 5.1 `archive_turn` 🔴 NEW (Z1 — fast verbatim capture, no LLM)
```jsonc
// request
{ "text": "...", "speaker": "Chatzi", "occurred_at": "2026-06-01T10:00:00Z" }
// response
{ "interaction_id": 42, "chunk_ids": [101,102], "run_id": 7, "pending_extraction": 2 }
```
Store interaction → chunk → embed → insert chunks `extraction_status='pending'` →
`synapsis_runs(stage='capture',status='completed')`. **No extraction.** Idempotent by content hash.

### 5.2 `re_extract` 🔴 NEW (re-run extraction over stored verbatim — the cheap-iteration verb)
```jsonc
{ "interaction_id": 42 }     // or { "since": "2026-05-01" } or {} for all
// → { "chunks_reset": 2 }   // set matching chunks → 'pending'; Z2 reprocesses
```

### 5.3 `remember` 🟡 MODIFY
`remember(text)` = `archive_turn` + enqueue (preserves today's save-and-extract UX on the decoupled
path). **Thread the speaker** (today hardcoded `"user"`, `mcp-server-combined.ts:67`) and pass
`owner`/`aiPersonas` from env so persona attribution works.

### 5.4 `recall` 🟡 MODIFY — 5-verdict (WS-3)
`RecallResult.via` (`recall.ts:29`) `"fact" | "verbatim"` → **`"fact" | "verbatim" |
"verbatim_pending" | "verbatim_quarantined"`**; `honest_empty` stays a separate `type`. On chunk match,
read `extraction_status`: `extracted`→`fact`/`verbatim`, `pending`→`verbatim_pending`,
`quarantined`→`verbatim_quarantined`.

---

## 6. The Z2 worker (`synapsis-worker.ts`) — standalone process

Reuses the per-chunk body factored from `pipeline.ts:259-345`.
1. **Claim:** `SELECT … FROM chunks WHERE extraction_status='pending' ORDER BY id LIMIT N FOR UPDATE
   SKIP LOCKED` (uses `chunks_pending`; safe under concurrency — server + worker never double-process).
2. **Extract:** four-lens `extractFacts` (`extract.ts`) — world-facts + persona + feedback (Q1).
3. **QA:** faithfulness (`synapsis/verify.ts`); failed facts → quarantined.
4. **Resolve + contradiction + diary:** unchanged (`pipeline.ts`).
5. **Status:** `extracted` if any fact passed (or chunk yielded none); `quarantined` if all failed.
   Per-chunk isolation — one failure never blocks others.
6. **Record:** `synapsis_runs(stage='extract', …)` ok/failed counts.
**Run:** `bun run synapsis-worker.ts` (loop, polls every N s) — a long-running process beside the
server. Idempotent: `extracted` chunks are skipped; `re_extract` is the only re-process path.

---

## 7. Postgres backend (`db.ts`, WS-1)

**Today:** PGLite only — `initDb(dataDir)` → `PGlite`, applies `schema.sql`, **skips HNSW**.
**Build:** branch on `MNEMON_PG_URL`:
```
MNEMON_PG_URL set  → connect via `postgres` (postgres.js, Bun-friendly) to the server; run schema (HNSW builds)
unset              → PGLite (retained as local degrade / eval)
```
Introduce a thin `Db` interface (`query(sql, params)` + `close()`); adapt `db.exec` (PGLite-only) →
`db.query`. All modules typed `PGlite` accept the interface. **Verify parity:** `$N::vector` binding
and `to_tsvector`/`plainto_tsquery` behave identically (they do — `schema.sql` is Postgres-authored).

**Provisioning (QA env — Dev documents for their own):**
```bash
brew install postgresql@16 pgvector && brew services start postgresql@16
createdb mnemon && psql mnemon -c 'CREATE EXTENSION vector;'
export MNEMON_PG_URL=postgres://localhost/mnemon
```

---

## 8. SessionStart hook (WS-5, D2)
`.claude/hooks/session-start.sh` 🔴 NEW — deterministically loads working memory before turn 1
(date/tz + `read_diary` recent window). Wired via `settings.json` `hooks.SessionStart`. The installed
`CLAUDE.md` rule remains the soft fallback.

---

## 9. Migrations

| # | File | Up | Idempotent |
|---|------|-----|-----------|
| 001 | `migrations/001_extraction_status.sql` | `chunks.extraction_status` + `chunks_pending` index (§4.1) | ✅ `IF NOT EXISTS` |
| 002 | `migrations/002_synapsis_runs.sql` | `synapsis_runs` (§4.2) | ✅ `IF NOT EXISTS` |
| 003 | `migrations/003_backfill_extracted.sql` | set existing chunks `extraction_status='extracted'` (don't re-run history; `re_extract` is opt-in) | ✅ |

---

## 10. Build sequence (Dev; Postgres-first)

| # | Task | WS | Depends | Est. |
|---|------|----|---------|------|
| 1 | `corrected → received_correction` rename (Q4) | WS-4 | — | 0.25d |
| 2 | **Postgres backend in `db.ts`** (connection + `Db` adapter + run schema) | WS-1 | — | 1.5d |
| 3 | **Parity gate G6** — `run-eval.ts` 8/8 on Postgres; HNSW present | WS-1 | 2 | 0.25d |
| 4 | `chunks.extraction_status` + migrations 001–003 | WS-2 | 2 | 0.5d |
| 5 | Factor `extractChunk()` out of `pipeline.ts ingest()` | WS-2 | 4 | 0.5d |
| 6 | `archive.ts` (Z1) + `archive_turn` verb | WS-2 | 4,5 | 0.5d |
| 7 | `synapsis-worker.ts` (Z2 standalone) + `FOR UPDATE SKIP LOCKED` | WS-2 | 5,6 | 1.5d |
| 8 | `re_extract` verb | WS-2 | 7 | 0.25d |
| 9 | 5-verdict recall (`via` + status read) | WS-3 | 4 | 0.5d |
| 10 | `remember` → Z1+enqueue; thread speaker/owner/personas | WS-2/4 | 6,7 | 0.5d |
| 11 | SessionStart hook | WS-5 | — | 0.25d |
| 12 | Synapsis-exemption note in `CLASS2_DESIGN` (Q2) | WS-6 | — | doc |

**Critical path:** 2 → 3 (parity must pass before anything downstream) → 4 → 5 → 6 → 7. Est. total ~8 dev-days.

---

## 11. Acceptance criteria (QA — run by Chatzi + Claude on Dev's build)

These are the gates **we** run to accept the build. Each must pass.

| Gate | Criterion | How we verify |
|------|-----------|---------------|
| **A1 — Postgres parity** | `run-eval.ts` returns **8/8** with `MNEMON_PG_URL` set, identical to PGLite. | run eval on PG |
| **A2 — HNSW built** | `\d chunks` and `\d facts` show `hnsw` indexes present on Postgres. | `psql` inspect |
| **A3 — Verbatim never lost** | After `archive_turn`, interaction + all chunks exist `status='pending'`, even if Z2 never runs. | archive, query, no worker |
| **A4 — Concurrency, no double-process** | Server (Z1) + worker (Z2) running together: every chunk extracted **exactly once** (`FOR UPDATE SKIP LOCKED`). | concurrent run, count facts |
| **A5 — Extraction isolation** | A chunk whose extract throws → that chunk `quarantined`, others `extracted`; no cross-chunk loss. | fault-inject one chunk |
| **A6 — Re-extract non-destructive** | `re_extract` resets→`pending`, Z2 reproduces facts; **no duplicate** interactions/chunks; verbatim unchanged. | re_extract, diff rows |
| **A7 — 5-verdict correctness** | recall returns `verbatim_pending` (pending chunk), `verbatim_quarantined` (quarantined), `fact`/`verbatim` (extracted), `honest_empty` only when FTS empty. | 5 fixtures each |
| **A8 — Persona parity** | 2K-slice persona facts (`design: prefers`, `received_correction`, …) land **identically** to the inline path (diff = 0). | re-run 2K slice on PG |
| **A9 — Concurrency UX** | A heavy Z2 pass running does **not** block/lag an interactive `recall` (the whole point of B). | recall latency under load |
| **A10 — Regression** | `fuzzy-test.ts` 31/31; `mcp-smoke-combined.ts` green; honest-empty intact. | run suites |

---

## 12. Edge cases & failure handling

| Case | Behavior |
|------|----------|
| Z1 ok, Z2 never runs | Verbatim answers recall as `verbatim_pending`; no fact-level loss. |
| Worker dies mid-chunk | Chunk stays `pending` (status flips only on completion); next pass re-claims (lock released on disconnect). |
| All facts in a chunk fail QA | Chunk → `quarantined`; recall surfaces `verbatim_quarantined`, **not** `honest_empty`. |
| Server + worker concurrent | `FOR UPDATE SKIP LOCKED` → exactly-once (A4). |
| `re_extract` during live session | Postgres multi-writer → concurrent, safe (no lock collision). |
| Migration on existing store | Backfill existing chunks → `extracted` (003) so history isn't re-run; `re_extract` opt-in. |
| pgvector missing on PG | `db.ts` fails fast at startup with a clear `CREATE EXTENSION vector` instruction. |

---

## 13. Decisions locked / open

📌 **LOCKED:** Option B (Postgres + standalone worker, now) · D2 (SessionStart hook) · Q1 (predicate
persona schema) · Q2 (Synapsis single-logical-writer exemption) · Q4 (`received_correction`).

**Q2 contract text** (→ `CLASS2_DESIGN` revision): *Synapsis writes are one logical writer via two
physical entry points (sync capture + async extraction over the same verbatim); the single-class rule
governs concurrent writers of different orchestration intents, not internal Synapsis substages.*

❓ **OPEN-FOR-DEV:**
- **O1 — PG client:** `postgres` (postgres.js, recommended — light, Bun-friendly) vs `pg`.
- **O2 — Worker poll interval / batch size N** — Dev proposes; QA validates A9.
- **O3 — `Db` interface shape** — minimal `query()/close()` vs fuller abstraction. Dev's call;
  keep it thin.

---

## 14. Provenance
Designed 2026-06-01 (Chatzi + Claude) against the live v8 tree (branch
`feat/lock4-lock2-persona-sub-kinds`); file/line refs verified against the cloned repo head.
Implements `MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md` with D1 resolved to **B-now** per architect
directive. Self-contained per the Spec Grader no-externalized-core rule.

**Process:** Dev builds per §10 (do not start before lock-ack); Chatzi + Claude QA per §11.
Dev review of this spec requested before build start.
