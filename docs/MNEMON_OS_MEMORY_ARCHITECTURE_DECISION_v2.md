# Mnemon_OS — Memory Architecture Decision: Verbatim/Extraction Decoupling

## Document Control

| Field | Value |
|-------|-------|
| Title | Memory Architecture Decision — verbatim/extraction decoupling + storage substrate |
| Version | **v2 (post-team-review)** |
| Status | **Decisions LOCKED — D1/D2/D3 ratified (Pythia review 2026-06-01); Q1/Q2/Q4 resolved; Q3 deferred (persona-adjacent). Dev review: PENDING (returned-unchanged; re-request).** |
| Date | 2026-06-01 |
| Author | Chatzi (drafted during the Mnemon_OS v8 evaluation + wiring session) |
| Reviewers | Pythia (✅ round-1, 2026-06-01) · Dev (⏳ pending — v1 returned byte-identical; re-request) |
| Supersedes | `MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v1.md` (retained) |
| Implements via | `MNEMON_OS_DECOUPLING_IMPL_SPEC_v1.md` (the Dev build spec) |
| Scope | How Mnemon stores/extracts memory and wires to Claude Code. NOT persona content. |
| Engine baseline | Mnemon_OS **v8** (single-Owner, MCP, Bun/PGLite) — as cloned from `grafix-daimonion/mnemon-os`. |

### Changelog (v1 → v2)
- D1/D2/D3 marked **ratified** per Pythia review.
- D1 gains a **migration anchor** (date + volume threshold) to close the "scheduled → never" drift the review flagged.
- Q1/Q2/Q4 moved from open → **resolved** with the review's recommendations; Q2 gains the **single-logical-writer codification**.
- Q3 reclassified **deferred (persona-adjacent)** per architect scope ("SOUL.md shared for wiring, not persona").
- Added pointer to the Dev implementation spec.

---

## 1. Context

We are wiring Mnemon as the live memory for an AI Executive Assistant (Pythia/Betty) that
learns Chatzi's persona from ongoing conversations. Two architecture questions needed a team
decision: (1) the storage substrate / writer model, given PGLite is single-writer; (2) how the
verbatim and the extraction relate. This note records the idea, the locked decisions, and the
resolved open questions. Implementation detail lives in the companion Dev spec.

---

## 2. The idea — verbatim and extraction as independent processes

**Today:** `/save` stores verbatim AND runs extraction **inline**, in one synchronous pipeline.
Improving the extractor forces a **full re-ingest** (re-chunk, re-embed, re-extract).

**Decided:** split the write path into two **independent** processes over the same verbatim:
- **Verbatim capture** — instant, lossless, canonical (interaction → chunks → embeddings). The floor.
- **Extraction** — a separate, re-runnable process that reads stored verbatim → facts (world-facts +
  four-lens persona/feedback). Runs later, retries, or re-runs with a better prompt **without
  re-capturing verbatim.**

**At recall, both layers surface independently** (5-verdict): `fact` · `verbatim` ·
`verbatim_pending` · `verbatim_quarantined` · `honest_empty`.

**Why right:** it is the engine's own intended design (Four-Zones; verbatim-canonical; facts as a
rebuildable projection). The **recall side is already built** (`recall.ts` falls back fact→verbatim;
`keyword_evidence` is verbatim-only). The work is the **write-side decoupling**. Benefits: cheap
re-extraction; honest-empty robustness; capture-now-extract-later.

---

## 3. Decisions (LOCKED)

### D1 — Writer model: **Option A now → Option B on trigger** ✅ ratified
- **A (now):** the combined MCP server is the single writer; all writes route through it (MCP-client
  for batch). No collision; no new infra. Cost: batch can't direct-attach; one writer at a time.
- **B (destination):** Postgres backend → true multi-writer (live session + background extraction
  concurrent). The substrate SOUL.md / the v9–v12 track already assume.
- **Why A isn't the end-state:** the persona-learning loop is a heavy, concurrent, background job;
  single-writer A serializes it through the live server, lagging interactive recall.

> **🔒 LOCKED.** Run A now. B is a **scheduled** migration with a hard anchor (below), not "eventually."

**Migration anchor (new in v2, per Pythia's drift concern).** "Scheduled" on operator-intent alone
drifts to "never." B is anchored on **calendar AND volume**:

> **B is built and operational by `2026-09-30` regardless** *(placeholder — Chatzi to confirm/tighten)*,
> **OR earlier if** four-lens extraction sustains **> 30 runs/week** OR a re-extraction backlog
> exceeds **~2,000 pending chunks** *(thresholds to be tightened after one week of real volume)*.

The §2 decoupling is itself the engineering trigger; the date+volume anchor is the schedule backstop.

### D2 — Session-start load: **SessionStart hook** ✅ ratified
Deterministic, model-version-proof load of working memory (date-check → `read_diary` recent → wait).
The installed CLAUDE.md instruction is the **soft fallback** (relies on the agent choosing recall-first).

### D3 — Integration surface: **MCP for Claude Code; HTTP for v12** ✅ ratified
v8 = MCP (native to Claude Code). HTTP REST is the v12/cloud track.

---

## 4. Open questions — RESOLVED

### Q1 — Persona schema: **predicates, not entity-types** ✅
Mind-facts are **S-P-O predicate triples** (`(Chatzi, design: prefers, "X")`), not new entity types
(`Trait`/`Like`/…). Predicates compose with the existing bi-temporal stamps and **sidestep the
type-namespace collision** with the Lock 4 sub-kinds (`Person:Human`/`Persona:AI`) that the Betty
redesign §2.2 flagged. *(Already implemented on the branch.)*

### Q2 — Single-class-at-write contract: **Synapsis exemption** ✅
Codification to land in the next `CLASS2_DESIGN` revision:
> *Synapsis writes are not "mixed-write." Synapsis is **one logical writer expressed through two
> physical entry points** — synchronous verbatim capture + asynchronous extraction over the same
> verbatim. The single-class-at-write rule governs **concurrent writers from different orchestration
> intents**, not internal Synapsis substages.*

This **unblocks the §2 decoupling** — the verbatim/extraction split is no longer a contract violation.

### Q4 — Predicate naming: **rename `corrected` → `received_correction`** ✅
Lock 6's same-turn-relation primitive keeps the shorter `corrects` (it's structurally older and a
`TRAVERSAL_PRED`); the newer/narrower feedback predicate gets the specific name. **Must land before
the persona branch merges** — otherwise recall-time predicate resolution must disambiguate on
context, violating deterministic-guards-first.

### Q3 — Persona/engine version gap: **DEFERRED (persona-adjacent)** ⏸
SOUL.md is v12-shaped (HTTP, 5-verdict, promotion machine, plugins); the engine is v8. Pythia
recommends **down-port SOUL.md to v8 now** (option a; not the shim, which doubles work across the
planned upgrade). Reclassified **deferred** per architect scope — this is persona-file work and does
**not** block D1/D2 or the branch merge. Tracked for the persona pass.

---

## 5. Current state

**Wired:** combined MCP server registered (`--scope user`), **connected**, env-anchored
(`MNEMON_OWNER=Chatzi`, `MNEMON_AI_PERSONAS=Pythia,Dev,Dimi,Betty`); store `~/.mnemon/store`;
generic v8 `CLAUDE.md` memory rules installed.

**Branch `feat/lock4-lock2-persona-sub-kinds` (committed, not merged):** Lock 4 sub-kinds, Lock 2
Owner anchoring, four-lens persona/feedback extraction. Validated on a 2K-token slice (clean typing,
~0 noise, genuine trait capture).

**Designed-not-built:** the §2 write-side decoupling; Postgres backend; v12 surfaces SOUL.md assumes.

---

## 6. Next actions (ranked, per Pythia review)

0. **Re-request Dev review** — v1 returned byte-identical; confirm "no notes" vs. misfire.
1. **Q4** — rename `corrected → received_correction` (cheapest; unblocks merge).
2. **Q1** — lock the predicate route in the persona schema (document the choice).
3. **Q2** — codify the Synapsis exemption in the next `CLASS2_DESIGN` revision.
4. **D1 anchor** — Chatzi confirms the date + volume numbers in §3.
5. **D1/D2 wiring** — per the Dev spec: finish A, SessionStart hook, install Postgres, `db.ts`
   adapter, build the §2 decoupling on PG.
6. **Q3** — down-port SOUL.md (deferred; persona pass).

Implementation detail for items 5 (and the build sequence) is specified in
**`MNEMON_OS_DECOUPLING_IMPL_SPEC_v1.md`**.

---

*v2 incorporates Pythia's round-1 review (2026-06-01). Dev review pending. Architect's call on lock.*
