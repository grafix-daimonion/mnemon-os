# Mnemon — Commitments Investigation & Build Report

## Document Control

| Field | Value |
|-------|-------|
| Title | Current-state-after-reversal bug — investigation, fix (commitments primitive), and where it's stored |
| Version | v1 |
| Date | 2026-07-01 |
| Author | Chatzi + Claude (Opus 4.8) |
| Repo | `mnemon-os` — `github.com/grafix-daimonion/mnemon-os` |
| Branch | `feat/commitments-primitive` (5 commits) → **PR #1** |
| Method | systematic-debugging (root cause before fixes) + TDD (failing test before code) |

---

## 1. Executive summary

Mnemon's headline guarantee is *"won't give you stale answers — always knows the current state."* The evaluation suite exposed a reliable violation: after a commitment was **reversed**, recall kept returning the **old** answer ("yes") instead of the new one ("no"). The engine was, in effect, **lying about the present**.

Root cause (found by evidence, not guesswork): **commitments were being shredded into generic `subject→predicate→object` triples whose subject drifted between the promise and its reversal.** The promise was filed under the *person* (an accumulator that is never superseded); the reversal landed under the *thing*. Same-subject supersession structurally could not reconnect them, so recall never saw the reversal.

Fix: a **first-class `commitments` primitive** — one row keyed on `(owner, about)` carrying a `status`; a reversal flips that row's status in place. Built test-first.

Result: the two reliably-failing eval cases went **100% FAIL → 100% PASS**, and the full suite went from a wobbly **5–6/8** to a stable **8/8** across three consecutive clean runs. 36 unit assertions added across 7 test files. Two independent robustness bugs were found and fixed along the way.

---

## 2. Starting symptom

The Phase-0 eval (`run-eval.ts`, fixtures `alice_sso` + `adversarial`) was scoring a wobbly **5–6/8**. Two cases failed:

- **`current-state`** (Alice): "Had the integration call with Alice today. She confirmed her team will hit the SSO deadline." (Mar 10) → later "she now says they can't make the SSO deadline; the integration slipped." (May 12). Query *"Did Alice agree to the SSO deadline?"* expected **"no"** (anchored to May 12); the engine answered **"yes"** (anchored to March).
- **`paraphrase-reversal-current`** (Bob): "Bob said the API migration will be done by Q2." (Mar 1) → "Bob now thinks they won't finish the API rollout in time." (Apr 20). Query *"Will Bob finish the API migration on time?"* expected **"no"**; the engine answered **"yes"**.

---

## 3. The investigation

Followed the systematic-debugging discipline: **no fixes before root cause**.

### 3.1 The eval harness was lying to us first

Before trusting any number, we checked the harness. `initDb()` uses `MNEMON_PG_URL` when set — and it was set globally (`postgres://localhost/mnemon`, the shared dev DB). So **every eval run wrote into the same persistent Postgres and never reset it.** Consequences:
- Fixture rows (e.g. Dana's) **accumulated run-over-run** → `multi-accumulates` "failed" (Dana=4, then 6) purely from leftover state.
- A **real** failure (`paraphrase-reversal-current`) was **masked** by leftover rows from prior runs that happened to help.

Running clean (`env -u MNEMON_PG_URL`, in-memory) deconfounded it: `multi-accumulates` was a harness artifact; `paraphrase-reversal-current` was a genuine, reproducible failure.

### 3.2 Model was not the lever

We ran the eval on **Haiku 4.5** and **Sonnet 4.6**. Both failed the two reversal cases **identically**, across three runs each. This proved the failure was **structural** (in the code), not a model-quality/nondeterminism problem — so throwing a bigger model at it was ruled out.

### 3.3 Root cause — evidence from clean-store fact dumps

We dumped the actual facts produced (clean store, Sonnet). The decisive evidence:

**Alice:**
```
#1 [confirmed][OPEN]  Alice --committed to--> SSO deadline          (the March promise)
#5 [confirmed][OPEN]  SSO deadline --completion status--> cannot be met  (the May reversal)
```
The promise was filed under subject **"Alice"**; the reversal under subject **"SSO deadline"**. The contradiction/supersession query is scoped `WHERE subject_id = <incoming>`, so the reversal (subject "SSO deadline") only scanned SSO-deadline facts, found none to supersede, and **left #1 open**. Recall keyed on "Alice" → hit the still-open #1 → "yes".

**Bob** (a second, distinct cause):
```
#1  [QUARANTINED]  Bob --committed to--> API migration
#9  [QUARANTINED]  API migration --completion status--> won't finish in time
```
Every Bob fact was **quarantined by the faithfulness QA gate**. Reason: the check had a rule for first-person ("I" = speaker) but **none for reported speech** — when the user says *"Bob said X,"* the judge reasoned *"the user didn't say it, Bob did"* and rejected it. With the reversal quarantined, it could never supersede anything.

### 3.4 The irreducible root

Both cases share one structural fact: **a commitment and its later reversal are stored as separate facts under different subjects/predicates, and same-subject supersession cannot bridge them.** The generic triple model is caught between two of its own rules:
- Commitments **must accumulate** (a new promise must not erase an old one — `ACCUMULATOR_PREDS`), yet
- a commitment's **reversal must close it**.

The generic triple has no way to tell "new commitment (accumulate)" from "cancellation of an existing commitment (supersede)," and the reversal lands elsewhere anyway. This cannot be patched cleanly in the triple model — it needs `(owner, about, status)` structure. That is the case for a first-class primitive.

---

## 4. What we built (test-first)

Every item below was built with a failing test first, then minimal code to pass.

| # | Change | File(s) | What it does |
|---|--------|---------|--------------|
| 1 | **Reported-speech faithfulness** | `synapsis/verify.ts` | The QA gate now accepts third-party reported facts ("Bob said X" → `{Bob, …}` is supported). Stops the over-quarantine that killed Bob's facts. |
| 2 | **No-crash JSON** | `llm.ts` | `llmJSON` returns `null` instead of throwing on unparseable/truncated model output — one bad reply no longer aborts a whole ingest/recall (real MCP-server robustness fix). |
| 3 | **Eval-store isolation** | `db.ts`, `eval-core.ts` | `initDb(dataDir?, {ephemeral:true})` forces a fresh in-memory store, ignoring `MNEMON_PG_URL` — the eval never touches the user's real store and never accumulates across runs. |
| 4 | **`commitments` table** | `schema.sql` | 6th core table: `owner_id`, `recipient_id`, `about_id`, `action`, `due_at`, `modality`, `status`, bi-temporal `valid_from/until` + `superseded_by`, provenance + `status_*` provenance columns, QA status. Plus hot-path indexes. |
| 5 | **Commitment primitive** | `commitments.ts` | `createCommitment`, `currentCommitmentFor`, `applyReversal` (flips status on the same row + re-anchors provenance to the reversal), `commitmentVerdict` (status → yes/no; **bi-temporal — reconstructs past state from `status_at`**), `commitmentsTo` (open promises to a recipient, overdue-first). |
| 6 | **Pipeline routing** | `pipeline.ts` | `extractChunk` routes extracted commitments/reversals to the table via the **same entity resolver as facts** (so "API rollout" ≈ "API migration" collapses and a reversal finds its commitment), behind a **faithfulness QA gate** (hallucinated commitment → quarantined; unsupported reversal → no flip). |
| 7 | **Extractor channels** | `extract.ts` | Emits `commitments` / `reversals` arrays alongside `facts`; handles third-party "Bob said…" → owner Bob. |
| 8 | **Recall integration** | `recall.ts` | A commitment's status is authoritative for commitment questions — **current AND as-of** — shadowing any stale "X committed to Y" fact. |
| 9 | **Design record** | `docs/COMMITMENTS_DESIGN_v1.md` | The full design, rationale (universal primitive, not a CS bolt-on), rejected alternatives, and the placement decision. |

### The fix, in one line
Instead of *"Alice — committed to — SSO deadline"* (a person-keyed accumulator) plus a disconnected *"SSO deadline — completion status — cannot be met,"* a commitment is now **one row** `{owner: Alice, about: SSO deadline, status: open}` and the reversal sets `status = broken` on that same row. Recall reads the status directly. The recipient (the "to whom") is a first-class FK — the original dropped-recipient bug is closed end-to-end (verified: *"We promised Acme we'd ship the SSO fix"* → `recipient = Acme`).

---

## 5. Results (measured)

| Eval case | Before (3 clean runs) | After (3 clean runs) |
|---|---|---|
| **`current-state`** (Alice reversal) | FAIL · FAIL · FAIL | **PASS · PASS · PASS** |
| **`paraphrase-reversal-current`** (Bob reversal) | FAIL · FAIL · FAIL | **PASS · PASS · PASS** |
| `paraphrase-reversal-asof` | PASS · FAIL · PASS | **PASS · PASS · PASS** (fixed by the as-of verdict) |
| other 5 cases | PASS | PASS |
| **Total** | 5–6/8 (wobbly) | **8/8 stable** (3 consecutive) |

- **36 unit assertions** across 7 new/updated test files, all green.
- Model is not the lever (Sonnet == Haiku pre-fix, confirmed 3×).
- Recall latency for commitment questions unchanged; correctness now deterministic.

---

## 6. Where the changes are stored

**Repository:** `mnemon-os` — `https://github.com/grafix-daimonion/mnemon-os`
**Branch:** `feat/commitments-primitive` (branched off baseline `982be3a`; PR base ref `base/commitments-pr-baseline`)
**Pull Request:** **#1** — `https://github.com/grafix-daimonion/mnemon-os/pull/1` (isolated to exactly these 5 commits; status: pushed, open for review)

### 6.1 Commits (oldest → newest)

| Commit | Message |
|--------|---------|
| `c1b1397` | feat(commitments): first-class commitments primitive — fixes current-state-after-reversal |
| `671657c` | fix(eval): isolate the eval store — ephemeral per-run, never the user's MNEMON_PG_URL |
| `6eafaa7` | feat(commitments): faithfulness QA-gate for commitments and reversals |
| `02db626` | feat(commitments): recipient query — "what did we promise <recipient>?" |
| `9d35d7a` | feat(commitments): bi-temporal as-of verdicts — recall_as_of works on commitments |

### 6.2 Files changed (17 files, +990 / −15)

**Engine / production code**
- `schema.sql` — the `commitments` table + indexes + status-provenance columns
- `commitments.ts` — the primitive (create / current / reverse / verdict / recipient query)
- `pipeline.ts` — routing + QA gate for commitments/reversals
- `extract.ts` — commitment/reversal extraction channels
- `recall.ts` — commitment-aware recall (current + as-of)
- `synapsis/verify.ts` — reported-speech faithfulness fix
- `llm.ts` — no-crash JSON parsing
- `db.ts` — `initDb` ephemeral option
- `eval-core.ts` — eval uses the ephemeral store
- `inspect-facts.ts` — read-only fact inspector (debugging tool)

**Tests (TDD)**
- `commitments-test.ts` — core lifecycle (create → reverse → status flips on same row)
- `commitments-routing-test.ts` — pipeline routes extracted commitments/reversals
- `commitment-recall-test.ts` — verdict reader, provenance anchoring, **as-of reconstruction**
- `commitment-qa-test.ts` — hallucinated commitment quarantined; unsupported reversal doesn't flip
- `commitment-recipient-test.ts` — "open promises to a recipient" query
- `eval-isolation-test.ts` — ephemeral store ignores `MNEMON_PG_URL`, is isolated

**Docs**
- `docs/COMMITMENTS_DESIGN_v1.md` — the design decision record
- `docs/COMMITMENTS_INVESTIGATION_REPORT_v1.md` — this report

### 6.3 Verification
- Working tree: **clean**. Branch **pushed** to `origin/feat/commitments-primitive`.
- PR #1 shows exactly the 5 commits (isolated from unrelated prior work via the `base/commitments-pr-baseline` base ref).

---

## 7. Related work from the same effort (separate branch — for completeness)

These were built after the commitments work and live on `feat/persona-extraction-flag` (PR #2), **not** in PR #1:

- **Persona GDPR off-switch** (`persona.ts`, `extract.ts`, `pipeline.ts`) — four-lens persona extraction ships dormant, gated on `MNEMON_PERSONA_EXTRACTION` (default OFF). Commits on `feat/persona-extraction-flag`.
- **`/recall_fast`** (`recall-class2.ts`, `api-server.ts`) + **`recall_fast` MCP verb** (`mcp-server-class2.ts`) — deterministic no-LLM recall for fast automatic injection. Commits `064ef83`, `5aac4c1`.
- **Mnemon ↔ Hermes wiring** (in the `ctesibius-betty` workspace, not this repo) — the Hermes memory-provider plugin proxying to Mnemon's HTTP API. See `~/CtesibiusAI/betty/MNEMON-HERMES-WIRING-v1.md`.

---

## 8. Open items

- **PR #1 review** (this work) and **PR #2 review**; neither branch is merged to `main` yet.
- Two residual eval flakes were fully attributed to **extraction nondeterminism** (not the commitments logic): `multi-accumulates` (an occasional extra Dana edge) and — before the as-of fix — `paraphrase-reversal-asof`.
- `commitmentsTo` (the recipient query) exists but has **no user-facing path** yet (recall route / MCP verb).
