# MNEMON_OS — Verbatim/Extraction Decoupling + Postgres Backend — Implementation Spec v1

## Document Control

| Field | Value |
|-------|-------|
| Title | Decoupling + Postgres backend — Dev implementation spec |
| Version | **v1 (build-ready draft)** |
| Status | **🟡 READY FOR DEV REVIEW.** Implements decisions D1/D2 and resolutions Q1/Q2/Q4 from `MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md`. Self-contained: all DDL, verb shapes, file changes, and gates are inline (no "inherits"). |
| Date | 2026-06-01 |
| Author | Chatzi (architect) · drafted with Claude Code against the live v8 working tree |
| Implements | `MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md` (D1, D2, Q1, Q2, Q4) |
| Engine baseline | Mnemon_OS **v8** — `grafix-daimonion/mnemon-os`, branch `feat/lock4-lock2-persona-sub-kinds`. Bun + PGLite (→ Postgres), MCP combined server. |
| Lane | Dev implements after lock. Betty/Pythia evaluate after build. |

### Status legend
🟢 SHIPPED (in working tree) · 🟡 PARTIAL (exists, needs extension) · 🔴 NEW (build from scratch) · 📌 LOCKED (architecturally committed) · ❓ OPEN

---

## 1. Summary, scope, and goals

### 1.1 What this builds
Decouple Mnemon's write path into two independent processes over the same verbatim — **(Z1) verbatim
capture** (instant, lossless) and **(Z2) extraction** (separate, re-runnable) — and move the store
from embedded PGLite to a **local Postgres** so the two can run concurrently. Recall surfaces the two
layers independently via a **5-verdict** result.

### 1.2 Why (strategic rationale)
- **Iteration cost:** today, improving the extractor forces a full re-ingest (re-chunk + re-embed +
  re-extract). Decoupling makes prompt iteration a **cheap re-extract over stored verbatim**. (We
  re-ran the four-lens prompt 4× in one session — each a full re-ingest.)
- **Robustness:** the verbatim floor still answers recall even when extraction missed or failed
  (honest-empty is preserved).
- **Concurrency:** an always-on EA needs background extraction running *alongside* live sessions;
  single-writer PGLite serializes the heavy pass through the live server. Postgres removes that.

### 1.3 In scope
WS-1 Postgres backend · WS-2 verbatim/extraction decoupling · WS-3 5-verdict recall · WS-4 persona
schema finalization (Q1) + `corrected→received_correction` rename (Q4) · WS-5 SessionStart hook (D2)
· WS-6 Synapsis-exemption contract note (Q2).

### 1.4 Non-goals (explicitly out)
v12 surfaces (HTTP REST, promotion state machine, plugin tables, 202 flow); multi-tenant; cloud
deployment; SOUL.md down-port (persona pass). These are the v9/v12 track, not this spec.

---

## 2. Architecture

### 2.1 The write path, before and after

```
BEFORE (v8, inline — pipeline.ts ingest()):
  /save(text) ──► [store verbatim → chunk → embed] ──► [extract → QA → resolve → contradiction → diary]
                  └──────────── one synchronous call; one writer; re-run = re-capture ─────────────┘

AFTER (decoupled):
  Z1  archive_turn(text,speaker,occurred_at) ──► store interaction → chunks(embed) → extraction_status='pending'
                                                  returns {interaction_id, chunk_ids, run_id}   [FAST, lossless]
  Z2  extraction worker (separate process) ────► reads chunks WHERE extraction_status='pending'
                                                  → four-lens extract → QA → resolve → contradiction → diary
                                                  → extraction_status='extracted' | 'quarantined'  [HEAVY, re-runnable]
  re_extract(scope) ───────────────────────────► reset matching chunks to 'pending' → Z2 reprocesses (no re-capture)
```

### 2.2 Writer model (D1)
- **Now (Option A):** the combined MCP server is the single writer; Z2 runs **inside** the server
  process on a timer/queue (no second PGLite attach). Acceptable while sessions are intermittent.
- **Target (Option B):** Postgres backend → Z2 runs as a **separate worker process** concurrent with
  the live server. WS-1 delivers the substrate; the worker split lands once on Postgres.
- **Single-logical-writer (Q2):** Z1 and Z2 are two physical entry points of **one logical writer
  (Synapsis)** over the same verbatim — not "mixed-write." See §13.

### 2.3 Recall (already built; extended in WS-3)
`recall.ts` already does fact→verbatim fallback (`recall.ts:159-197`) and a keyword-only honest-empty
arbiter (`recall.ts:136-143`). WS-3 extends the verbatim channel to distinguish **pending** and
**quarantined** chunks → the 5-verdict surface.

---

## 3. Component inventory (files)

| File | Action | What changes |
|------|--------|--------------|
| `db.ts` | 🔴 MODIFY | Add Postgres connection path (env `MNEMON_PG_URL`); query-API adapter; run `schema.sql`. (WS-1) |
| `schema.sql` | 🔴 MODIFY | Add `chunks.extraction_status` column + index + forward-compat `ALTER`. (WS-2) |
| `archive.ts` | 🔴 NEW | Z1 verbatim-capture (wraps existing `pipeline-class2.ts:archive`, sets `extraction_status='pending'`, returns `run_id`). (WS-2) |
| `synapsis-worker.ts` | 🔴 NEW | Z2 extraction loop: claim pending chunks → extract → QA → resolve → contradiction → diary → set status. (WS-2) |
| `pipeline.ts` | 🟡 MODIFY | Factor the per-chunk extraction body out of `ingest()` so Z2 reuses it; `ingest()` becomes "Z1 + enqueue", not inline-extract. (WS-2) |
| `extract.ts` | 🟡 MODIFY | Q4 rename `corrected → received_correction`; confirm Q1 predicate scheme. (WS-4) |
| `recall.ts` | 🟡 MODIFY | Extend `RecallResult.via` to 4 values; read `chunks.extraction_status`. (WS-3) |
| `mcp-server-combined.ts` | 🟡 MODIFY | Register `archive_turn`, `re_extract`; have `remember` route Z1+enqueue; thread `speaker`/owner/personas. (WS-2/WS-4) |
| `.claude/hooks/session-start.sh` | 🔴 NEW | SessionStart hook: load `read_diary` recent into context. (WS-5) |
| `migrations/001_extraction_status.sql` | 🔴 NEW | The numbered migration (see §9). |

---

## 4. Data model (inline DDL)

### 4.1 `chunks.extraction_status` (WS-2) 🔴 NEW
Current `chunks` (`schema.sql:23-30`): `id, interaction_id, ord, content, embedding, created_at`. Add:

```sql
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending'
  CHECK (extraction_status IN ('pending','extracted','quarantined'));

CREATE INDEX IF NOT EXISTS chunks_pending
  ON chunks (interaction_id) WHERE extraction_status = 'pending';   -- Z2 claim scan
```

**State machine:** `pending` (Z1 wrote verbatim, Z2 not done) → `extracted` (Z2 produced ≥0 facts,
QA passed) | `quarantined` (Z2 ran, all facts failed faithfulness QA). `re_extract` resets to `pending`.

### 4.2 `synapsis_runs` (optional, recommended) 🔴 NEW
Tracks each Z1/Z2 unit for observability + the `run_id` returned by `archive_turn`:

```sql
CREATE TABLE IF NOT EXISTS synapsis_runs (
  id            bigserial primary key,
  interaction_id bigint references interactions(id),
  stage         text NOT NULL CHECK (stage IN ('capture','extract')),
  status        text NOT NULL CHECK (status IN ('running','completed','failed')),
  chunks_total  int  NOT NULL DEFAULT 0,
  chunks_ok     int  NOT NULL DEFAULT 0,
  chunks_failed int  NOT NULL DEFAULT 0,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
```

### 4.3 No other schema change
`facts`/`entities` already carry the persona predicates (Q1 is predicate-based, not a new type/column).
The Lock 4 sub-kinds (`Person:Human`/`Persona:AI`) and feedback predicates already ship on the branch.

---

## 5. Verb / API surface (MCP, inline shapes)

### 5.1 `archive_turn` 🔴 NEW (Z1 — verbatim capture)
```jsonc
// request
{ "text": "...", "speaker": "Chatzi", "occurred_at": "2026-06-01T10:00:00Z" }
// response (fast; no LLM)
{ "interaction_id": 42, "chunk_ids": [101,102], "run_id": 7, "pending_extraction": 2 }
```
Behavior: store interaction → chunk (`chunk.ts`) → embed (`embed.ts`) → insert chunks with
`extraction_status='pending'` → write `synapsis_runs(stage='capture',status='completed')`. **No
extraction.** Idempotent by content hash (re-archiving identical content is a no-op).

### 5.2 `re_extract` 🔴 NEW (re-run extraction over stored verbatim)
```jsonc
// request — scope is optional; default = all interactions
{ "interaction_id": 42 }            // or { "since": "2026-05-01" } or {} for all
// response
{ "chunks_reset": 2 }               // set matching chunks → 'pending'; Z2 picks them up
```
This is the cheap-iteration verb: change the extractor prompt, `re_extract`, no re-capture.

### 5.3 `remember` 🟡 MODIFY
`remember(text)` becomes `archive_turn` + immediate enqueue (Z1 then trigger Z2), preserving today's
"save and extract" UX but on the decoupled path. **Thread the speaker** (today hardcoded `"user"` at
`mcp-server-combined.ts:67`) and pass `owner`/`aiPersonas` from env so persona attribution works.

### 5.4 `recall` 🟡 MODIFY — 5-verdict (WS-3)
`RecallResult.via` (`recall.ts:29`) extends `"fact" | "verbatim"` → **`"fact" | "verbatim" |
"verbatim_pending" | "verbatim_quarantined"`**; `honest_empty` stays a separate `type`. Read
`chunks.extraction_status` when a chunk matches: `extracted`→`verbatim`/`fact`, `pending`→
`verbatim_pending`, `quarantined`→`verbatim_quarantined`.

---

## 6. The extraction worker (Z2) — behavior

`synapsis-worker.ts` 🔴 NEW. Reuses the per-chunk body factored out of `pipeline.ts:259-345`.

1. **Claim:** `SELECT … FROM chunks WHERE extraction_status='pending' ORDER BY id LIMIT N` (uses
   `chunks_pending` index). On Postgres, claim with `FOR UPDATE SKIP LOCKED` so multiple workers / a
   worker-and-server don't double-process.
2. **Extract:** run the four-lens `extractFacts` (`extract.ts`) per chunk — world-facts + persona +
   feedback (Q1 predicates).
3. **QA:** faithfulness (`synapsis/verify.ts`); failed facts → quarantined.
4. **Resolve + contradiction + diary:** unchanged logic (`pipeline.ts`).
5. **Set status:** `extracted` if any fact passed QA (or chunk legitimately yielded none);
   `quarantined` if all facts failed. Per-chunk isolation — one failure never blocks others.
6. **Record:** `synapsis_runs(stage='extract', …)` with ok/failed counts.

**Idempotency:** re-running Z2 over an already-`extracted` chunk is skipped (status filter). `re_extract`
is the only way to re-process — it resets to `pending` first.

**Trigger (D1):** Option A → in-process timer/queue in the combined server. Option B → standalone
`bun run synapsis-worker.ts` process (Postgres only).

---

## 7. Postgres backend (WS-1) — `db.ts`

**Today** (`db.ts`): PGLite only — `initDb(dataDir)` returns a `PGlite`, applies `schema.sql`
statement-by-statement, **skips HNSW indexes** (PGLite can't build them).

**Change:** branch on `MNEMON_PG_URL`:
```
if (process.env.MNEMON_PG_URL) → connect via `postgres`/`pg` to the server; run schema (HNSW builds)
else                          → PGLite (current behavior, the local degrade)
```
**Query-API adapter:** the code calls `db.query(sql, params)` (maps cleanly to both) and `db.exec(sql)`
(PGLite-specific — for Postgres, wrap as `db.query(sql)`). Provide a thin `Db` interface with
`query()` so the other modules (typed to `PGlite` today) accept either backend. **Verify:** the
`vector(384)` param binding (`$N::vector`) and `to_tsvector`/`plainto_tsquery` FTS work identically on
server Postgres (they do — `schema.sql` was authored for Postgres; PGLite is the subset).

**Requirements:** Postgres 16 · pgvector ≥ 0.5 (HNSW) · FTS built-in. Install:
```bash
brew install postgresql@16 pgvector && brew services start postgresql@16
createdb mnemon && psql mnemon -c 'CREATE EXTENSION vector;'
export MNEMON_PG_URL=postgres://localhost/mnemon
```

---

## 8. SessionStart hook (WS-5, D2)

`.claude/hooks/session-start.sh` 🔴 NEW — deterministically loads working memory before the first turn
(replaces reliance on the agent choosing to recall-first). Behavior: print date/tz, then the recent
diary (the `read_diary` window) as context. Wired via `settings.json` `hooks.SessionStart`. The
installed `CLAUDE.md` rule remains the soft fallback.

---

## 9. Migrations

| # | File | Up | Idempotent |
|---|------|-----|-----------|
| 001 | `migrations/001_extraction_status.sql` | `chunks.extraction_status` column + `chunks_pending` index (§4.1) | ✅ `IF NOT EXISTS` |
| 002 | `migrations/002_synapsis_runs.sql` | `synapsis_runs` table (§4.2) | ✅ `IF NOT EXISTS` |

Forward-compat: existing PGLite stores get the `ALTER` on next `initDb` (matches the existing
forward-compat ALTER pattern at `schema.sql:120-124`). Backfill: existing chunks default to
`'pending'` → Z2 will (re)extract them; set them to `'extracted'` in the migration if you want to
preserve current facts without re-running. **Decision:** backfill existing chunks → `'extracted'`
(don't re-run history on migrate); `re_extract` is the opt-in to reprocess.

---

## 10. Build sequence (ordered; dependencies)

| # | Task | WS | Depends on | Est. |
|---|------|----|-----------|------|
| 1 | `corrected → received_correction` rename (Q4) | WS-4 | — | 0.25d |
| 2 | `chunks.extraction_status` column + migration 001 | WS-2 | — | 0.25d |
| 3 | Factor per-chunk extraction out of `pipeline.ts ingest()` | WS-2 | 2 | 0.5d |
| 4 | `archive.ts` (Z1) + `archive_turn` verb | WS-2 | 2,3 | 0.5d |
| 5 | `synapsis-worker.ts` (Z2) + in-process trigger (Option A) | WS-2 | 3,4 | 1d |
| 6 | `re_extract` verb | WS-2 | 5 | 0.25d |
| 7 | 5-verdict recall (`RecallResult.via` + status read) | WS-3 | 2 | 0.5d |
| 8 | SessionStart hook | WS-5 | — | 0.25d |
| 9 | Postgres backend in `db.ts` (Option B substrate) | WS-1 | — | 1d |
| 10 | Move Z2 to standalone worker process (Postgres) | WS-2 | 5,9 | 0.5d |
| 11 | Synapsis-exemption note in `CLASS2_DESIGN` (Q2) | WS-6 | — | doc |

**Phase A (Option A, works now):** tasks 1–8 — decoupled on PGLite, Z2 in-process.
**Phase B (Option B):** tasks 9–10 — Postgres + standalone worker (the concurrency win).

---

## 11. QA gates (with thresholds)

| Gate | Criterion |
|------|-----------|
| G1 — Verbatim never lost | After `archive_turn`, interaction + all chunks exist with `extraction_status='pending'`, even if Z2 never runs. 100% on 20 fixtures. |
| G2 — Extraction isolation | A chunk whose `extractFacts` throws → that chunk `quarantined`, others `extracted`. No cross-chunk loss. |
| G3 — Re-extract is non-destructive | `re_extract` resets to `pending`, Z2 reproduces facts; verbatim + interaction rows unchanged; no duplicate chunks. |
| G4 — 5-verdict correctness | recall returns `verbatim_pending` for a matched `pending` chunk, `verbatim_quarantined` for a `quarantined` one, `fact`/`verbatim` for `extracted`, `honest_empty` only when FTS finds nothing. 5+ fixtures each. |
| G5 — Idempotent capture | `archive_turn` on identical content = no-op (no duplicate interaction/chunks). |
| G6 — Postgres parity | `bun run run-eval.ts` (alice_sso + adversarial) passes **8/8** on `MNEMON_PG_URL` exactly as on PGLite. HNSW index present (`\d chunks` shows hnsw). |
| G7 — No double-process | Two Z2 workers (or worker + server) over the same `pending` set process each chunk exactly once (`FOR UPDATE SKIP LOCKED`). Postgres only. |
| G8 — Persona predicates intact | After decoupling, the 2K-slice persona facts (`design: prefers`, `received_correction`, …) land identically to the inline path. Diff = 0. |

Existing gates that must still pass: `fuzzy-test.ts` 31/31; `mcp-smoke-combined.ts`; `run-eval.ts` 8/8.

---

## 12. Edge cases & failure handling

| Case | Behavior |
|------|----------|
| Z1 succeeds, Z2 never runs | Verbatim answers recall as `verbatim_pending`; no fact-level loss; honest. |
| Worker dies mid-chunk | Chunk stays `pending` (status only flips on completion); next Z2 pass re-claims it. |
| All facts in a chunk fail QA | Chunk → `quarantined`; recall surfaces `verbatim_quarantined` (not `honest_empty`). |
| Concurrent Z2 + live server (Postgres) | `FOR UPDATE SKIP LOCKED` claim → no double-process (G7). |
| Concurrent writers (PGLite, Option A) | Single writer by construction; Z2 is in-process. No second attach. |
| Re-extract during live session | On PGLite: serialized (one writer). On Postgres: concurrent, safe. |
| Migration on existing store | `pending` backfilled → `extracted` (§9) so history isn't re-run; `re_extract` is opt-in. |

---

## 13. Decisions locked / open

📌 **LOCKED:** D1 (A→B on trigger), D2 (SessionStart hook), Q1 (predicate persona schema),
Q2 (Synapsis single-logical-writer exemption), Q4 (`received_correction` rename).

**Q2 contract text** (to land in `CLASS2_DESIGN` revision): *Synapsis writes are one logical writer
via two physical entry points (sync capture + async extraction over the same verbatim); the
single-class-at-write rule governs concurrent writers of different orchestration intents, not
internal Synapsis substages.*

❓ **OPEN for Dev:**
- **O1 — Z2 trigger in Option A:** in-process timer (simple) vs a lightweight queue. Recommend timer
  for Phase A; queue when on Postgres.
- **O2 — Backfill default** confirmed `'extracted'` (§9) — Dev confirms no objection.
- **O3 — `db.ts` client:** `postgres` (postgres.js) vs `pg` (node-postgres). Dev's call; `postgres`
  is lighter and Bun-friendly.

---

## 14. Provenance

Drafted 2026-06-01 against the live v8 working tree (branch `feat/lock4-lock2-persona-sub-kinds`).
Implements `MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md` (Pythia-reviewed). File/line references
verified against the cloned `grafix-daimonion/mnemon-os` head. Self-contained per the Spec Grader
"no externalized core" rule — all DDL, verb shapes, migrations, and gates are inline.

*Dev: do not start before lock. The build sequence (§10) is the implementation order; Phase A ships
on PGLite, Phase B adds Postgres concurrency.*
