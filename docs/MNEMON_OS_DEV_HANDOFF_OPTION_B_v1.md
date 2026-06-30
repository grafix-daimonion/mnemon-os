# MNEMON_OS — Dev Handoff: Option B (Postgres + Verbatim/Extraction Decoupling)

## Document Control

| Field | Value |
|-------|-------|
| Title | Dev handoff — how to pick up and build Option B |
| Version | v1 |
| Status | **🟢 Ready for Dev.** Design locked; awaiting Dev spec-review + lock-ack before build start. |
| Date | 2026-06-01 |
| Audience | Dev team |
| Role model | **Design:** Chatzi + Claude. **Build:** Dev (you). **QA / acceptance:** Chatzi + Claude. |
| Builds | `docs/MNEMON_OS_DECOUPLING_IMPL_SPEC_v2.md` (the WHAT). This doc is the HOW-to-start. |

---

## 1. TL;DR — start here

1. **Get it:** `git fetch origin && git checkout feat/lock4-lock2-persona-sub-kinds`
2. **Read it:** `docs/MNEMON_OS_DECOUPLING_IMPL_SPEC_v2.md` (build spec) + `docs/MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md` (the why).
3. **Review, then ack:** reply with a spec review (concerns / O1–O3 calls). **Do not start coding until design is lock-acked** — per our process (design → build → QA).
4. **Build** per spec **§10** (build sequence). **We QA** per spec **§11** (acceptance gates).

---

## 2. What you're building (one paragraph)

Move Mnemon's store from embedded PGLite to **local Postgres 16 + pgvector** (multi-writer), and
**decouple the write path** into two independent processes over the same verbatim: **Z1 verbatim
capture** (fast, lossless, in the combined MCP server) and **Z2 extraction** (a standalone
`synapsis-worker.ts` process running concurrently). Recall surfaces both layers via a **5-verdict**
result. Full detail, DDL, and verb shapes are inline in the build spec — it is self-contained.

---

## 3. The branch you're on (baseline)

`feat/lock4-lock2-persona-sub-kinds` already contains the **four-lens persona extraction** you build
the decoupling around:
- `extract.ts` — the `SPEAKER MIND-FACTS` four-lens section (behavior/relationship/design/philosophy;
  preferences/values, marker-gated directives, accumulating feedback).
- `pipeline.ts` — Lock 4 sub-kinds (`Person:Human`/`Persona:AI`, sticky in `promoteType`), Lock 2
  Owner/AI anchoring, feedback predicates in `ACCUMULATOR_PREDS`.
- `db.ts`, `recall.ts`, `mcp-server-combined.ts`, `schema.sql` — the files you'll modify (see spec §3).

**Note:** the code still uses `corrected` — the rename to `received_correction` (Q4) is **your build
step 1** (spec §10), not yet done.

---

## 4. Rules of engagement

- **Branch:** cut your build branch off `feat/lock4-lock2-persona-sub-kinds` (build branches are yours
  to create). Suggested: `feat/option-b-postgres-decoupling`.
- **Do not merge to `main`** — open a PR back to `feat/lock4-lock2-persona-sub-kinds`; QA runs before
  any merge to main.
- **Lock-first:** the spec says *"do not start before lock-ack."* Send your review first; build after.
- **Self-contained spec:** everything you need (DDL, verb shapes, migrations, gates) is inline in the
  build spec — flag any gap rather than guessing.
- **Scope guard — do NOT build** (non-goals, spec §1.4): v12 surfaces (HTTP REST, promotion state
  machine, plugin tables, 202 flow), multi-tenant, cloud deployment, SOUL.md down-port.

---

## 5. Build sequence (summary — full table in spec §10)

Postgres-first. **Critical path:** task 2 (Postgres backend in `db.ts`) → task 3 (**parity gate must
pass: `run-eval.ts` 8/8 on Postgres**) → then the decoupling (4→5→6→7). Estimated ~8 dev-days.

| Order | Task |
|------|------|
| 1 | `corrected → received_correction` rename (Q4) |
| 2–3 | Postgres backend in `db.ts` + **parity gate** (8/8 on PG; HNSW builds) |
| 4–8 | `extraction_status` + migrations → `archive.ts` (Z1) → `synapsis-worker.ts` (Z2, `FOR UPDATE SKIP LOCKED`) → `re_extract` |
| 9–10 | 5-verdict recall; `remember` → Z1+enqueue, thread speaker/owner/personas |
| 11 | SessionStart hook |
| 12 | Synapsis-exemption note in `CLASS2_DESIGN` (Q2) |

---

## 6. Your dev/test environment (Postgres)

```bash
brew install postgresql@16 pgvector && brew services start postgresql@16
createdb mnemon && psql mnemon -c 'CREATE EXTENSION vector;'
export MNEMON_PG_URL=postgres://localhost/mnemon
```
Requirements: Postgres **16**, pgvector **≥ 0.5** (HNSW), FTS built-in. The existing PGLite path stays
as the local degrade (no `MNEMON_PG_URL` → PGLite).

---

## 7. Open items needing your call (spec §13)

- **O1 — PG client lib:** `postgres` (postgres.js, recommended — light, Bun-friendly) vs `pg`.
- **O2 — worker poll interval / batch size N** (validated by acceptance gate A9).
- **O3 — `Db` interface shape** — keep it thin (`query()` / `close()`).

Decide these in your spec review.

---

## 8. How we accept your build (spec §11 — we run these)

You're done when all 10 acceptance gates pass. The load-bearing ones:
- **A1** — `run-eval.ts` 8/8 on Postgres (parity).
- **A4** — server (Z1) + worker (Z2) concurrent: each chunk extracted **exactly once**.
- **A6** — `re_extract` is non-destructive (no duplicate interactions/chunks; verbatim unchanged).
- **A8** — persona facts land **identically** to the inline path (diff = 0).
- **A9** — a heavy Z2 pass does **not** lag interactive `recall` (the whole point of B).
- **A10** — regression: `fuzzy-test.ts` 31/31, `mcp-smoke-combined.ts` green, honest-empty intact.

Run them yourself before requesting QA; we re-run them on acceptance.

---

## 9. Process / contacts

- **Design lock + QA:** Chatzi (architect) + Claude.
- **Questions / spec gaps:** raise in the spec review; the spec is self-contained, so a gap is a spec
  bug to fix, not a thing to guess around.
- **Deliverable:** PR → `feat/lock4-lock2-persona-sub-kinds`, all §11 gates green, your `db.ts` client
  + worker-interval choices documented.

---

*Build spec: `docs/MNEMON_OS_DECOUPLING_IMPL_SPEC_v2.md`. Decision rationale:
`docs/MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v2.md`. Do not start before lock-ack.*
