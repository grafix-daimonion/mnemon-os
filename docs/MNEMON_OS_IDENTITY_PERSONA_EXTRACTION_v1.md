# MNEMON_OS — Identity Sub-Kinds & Four-Lens Persona Extraction — Spec Sheet v1

## Document Control

| Field | Value |
|-------|-------|
| Title | Identity sub-kinds (Lock 4) + Owner anchoring (Lock 2) + four-lens persona/feedback extraction |
| Version | v1 |
| Status | **🟢 BUILT & VALIDATED** on branch `feat/lock4-lock2-persona-sub-kinds` (commit `2fe319d`); lazy-client fix on `main` (`bda136e`). Validated on a 2K-token real transcript slice. Not yet merged to `main`. |
| Date | 2026-06-02 |
| Author | Chatzi + Claude (Mnemon_OS evaluation session) |
| Engine baseline | Mnemon_OS **v8** — `grafix-daimonion/mnemon-os` (single-Owner, MCP, Bun/PGLite). |
| Documents | The improvements **already made** this session. (Forward work — verbatim/extraction decoupling + Postgres — is `MNEMON_OS_DECOUPLING_IMPL_SPEC_v2.md`.) |
| Self-containment | Per the Spec Grader rule: predicate vocabulary, markers, shapes, config, and file refs are inline. |

### Status legend
🟢 SHIPPED (in tree) · 🟡 PARTIAL · 🔴 DEFERRED · 📌 LOCKED

---

## 1. Summary — what changed

Four improvements, two commits:

| # | Improvement | Where | Status |
|---|-------------|-------|--------|
| 1 | **Lazy LLM client** + README accuracy | `llm.ts`, `README.md` (`main`, `bda136e`) | 🟢 |
| 2 | **Lock 4** — entity sub-kinds `Person:Human` / `Persona:AI` | `extract.ts`, `pipeline.ts` | 🟢 |
| 3 | **Lock 2 (slice)** — deterministic Owner/AI anchoring | `pipeline.ts`, `ingest-transcript.ts` | 🟢 |
| 4 | **Four-lens persona/feedback extraction** | `extract.ts`, `pipeline.ts` | 🟢 |

The headline is #4: the engine now models **how each participant thinks** (preferences, values,
directives) and **the feedback that calibrates an AI** (corrections, errors, praise) — attributed
per-speaker, riding the existing bi-temporal layer so stances evolve over time.

---

## 2. Improvement 1 — Lazy LLM client + README accuracy 🟢

**Problem:** `llm.ts` constructed the Anthropic client at module import — anything transitively
importing it threw without `ANTHROPIC_API_KEY`, before any logic ran (breaking the no-LLM paths).

**Fix:** lazy singleton —
```ts
let _client: Anthropic | null = null;
function getClient(): Anthropic { return (_client ??= new Anthropic({ apiKey: loadKey() })); }
```
`llmJSON` calls `getClient()`. Verified: `llm.ts` now imports with no key.

**README:** `fuzzy-test.ts` re-labelled as needing `ANTHROPIC_API_KEY` (it exercises the LLM QA gate
— an integration test, not a pure unit test); added a lineage note (this repo = the v8 single-Owner
open-source core; cloud/multi-tenant tracks are separate).

---

## 3. Improvement 2 — Lock 4: entity sub-kinds 🟢 📌

**What:** the entity type vocabulary now leads with two identity sub-kinds:
- `Person:Human` — a biological human (Owner, colleagues, customers).
- `Persona:AI` — an AI agent / assistant / named AI persona.
(plus `org`, `project`, `task`, `event`, `decision`, `note`, `question`, `thing`).

**Implementation:**
- `extract.ts` — `ExtractedFact.subject_type` vocabulary + the `ENTITY KIND` prompt section.
- `pipeline.ts` — sub-kinds added to the `INDEPENDENT` (global identity) set; new helper
  `isIdentityKind(t) = /^(Person|Persona):/.test(t)`.
- **Sticky typing:** `promoteType()` now returns early if the current type is an identity sub-kind —
  a later LLM guess can **never demote** `Person:Human`/`Persona:AI` (e.g. Pythia can't slip back to
  `thing`). This is the guard that makes deterministic anchoring authoritative.

**Why:** before this, on a real transcript the Owner typed as `org` and the AI as `thing` — the two
most important entities were both mistyped. The engine even *stored the fact* that v8 should have
these sub-kinds while not applying them to itself. Lock 4 closes that.

---

## 4. Improvement 3 — Lock 2 (slice): deterministic Owner/AI anchoring 🟢 📌

Identity is anchored from configuration, not guessed:

- **Owner is a person, not an org.** The account/scope was hardcoded to type `org` (the root cause of
  `Chatzi → org`). Now: when the account *is* the Owner, it resolves as `Person:Human`.
- **Speaker anchoring.** Before extraction, each turn's speaker is resolved with its true sub-kind:
  Owner → `Person:Human`; a configured AI persona → `Persona:AI`. The extractor then can't misattribute
  the kind.
- **Config** (opts → env fallback): `owner` / `MNEMON_OWNER`, `aiPersonas` / `MNEMON_AI_PERSONAS`.
- `extractFacts` also passes the current `speaker` explicitly to the LLM (was only prepended to the
  note text), so first-person mind-facts attribute correctly.

`pipeline.ts ingest()`: resolves `ownerName`/`aiPersonas`, computes `accountType`, pre-seeds the
speaker entity, and threads `owner`/`ai_personas` into the extraction context.

---

## 5. Improvement 4 — Four-lens persona/feedback extraction 🟢 📌

The core new capability. In **addition** to world-facts, the extractor captures **mind-facts** — what
shapes a persona — attributed to the **speaker** (any participant, human or AI). Adapted from the
Daimonion four-lens approach, but **all-speakers** (not human-only) per the EA persona-transfer goal.

### 5.1 The four lenses
Every mind-fact is tagged by lens (encoded as a predicate prefix, queryable via `predicate LIKE '<lens>:%'`):
- **behavior** — communication patterns, decision moments.
- **relationship** — boundaries, shared language, how disagreement/error is handled.
- **design** — design decisions, architecture stances, anti-patterns held/rejected.
- **philosophy** — epistemic standards, decision principles, values, worldview.

### 5.2 Three fact kinds

| Kind | When | Predicate(s) | Shape |
|------|------|-------------|-------|
| **Preferences & values** (soft, default) | speaker reveals what they like/value/judge-good | `<lens>: prefers` / `values` / `dislikes` / `holds standard` | `single` (supersede on change) |
| **Directives** (hard) | **only** with an explicit imperative marker | `directive: always` / `never` / `must` | `single` |
| **Feedback** (calibration) | **only** when explicitly marked | `corrected` · `erred` · `praised` | `multi` (accumulate) |

**Directive markers:** `always`, `never`, `must`, `from now on`, `don't ever`, `rule:`. **Default to a
preference** unless a marker is literally present — never invent a rule (fail-safe, like honest-empty).

**Feedback markers:** correction = `wrong` / `no` / `actually` / `I meant` / `correction`; praise =
`well done` / `exactly` / `perfect` / `good call` / `nice catch`. Subject = the corrector / praiser /
the one who erred.

### 5.3 Shapes & supersession semantics (the design that fixes the noise)
- **Preferences/directives are `single`** with the **topic carried in the object** (e.g. `"terse docs
  over verbose"`) → a later view on the **same topic supersedes** (taste evolution, the bi-temporal
  moat applied to beliefs), while **distinct topics coexist** (the object-topic lets the contradiction
  judge tell them apart).
- **Feedback is `multi`** — each correction/error/praise is a distinct lesson; they **accumulate, never
  supersede.** Enforced deterministically: `corrected`, `erred`, `hallucinated`, `praised` were added
  to `ACCUMULATOR_PREDS` in `pipeline.ts` (forced `multi` regardless of the LLM's returned shape).

### 5.4 Anti-noise discipline
Mind-facts capture **dispositions, not transcript moves.** The prompt forbids one-off conversational
mechanics (asking a question, acknowledging, dispatching a task, status updates) — *"when in doubt,
emit nothing."* This eliminated the over-firing seen in an earlier draft (`behavior: signals` /
`seeks clarification` ×18 → 0).

### 5.5 Worked example (from the prompt)
> *"Chatzi: From now on, always cite file:line. I like terse docs. Pythia, that was wrong — the owner
> is Person:Human, not org. Nice catch on the lazy client."* →
- `Chatzi | directive: always | cite file:line in evidence` (single)
- `Chatzi | design: prefers | terse docs over verbose` (single)
- `Chatzi | corrected | owner is Person:Human (was: org)` (multi)
- `Chatzi | praised | Pythia's lazy-client fix` (multi)

---

## 6. Data model — no schema change

Mind-facts are ordinary `facts` rows — **predicate-based S-P-O triples**, not new entity types or
columns. They compose with the existing bi-temporal stamps (`valid_from`, `valid_until`,
`superseded_by`) and provenance (`source_chunk_id`, `source_hash`). The persona schema decision (Q1)
chose **predicates over entity-types** precisely to avoid a type-namespace collision with the Lock 4
sub-kinds. Sub-kinds live in the existing free-form `entities.type` (TEXT) — no DDL change.

---

## 7. Configuration

| Knob | Flag (`ingest-transcript.ts`) | Env fallback | Effect |
|------|------------------------------|--------------|--------|
| Owner | `--owner Chatzi` | `MNEMON_OWNER` | Owner → `Person:Human`; account-as-Owner typed as person |
| AI personas | `--personas "Pythia,Dev,Dimi,Betty"` | `MNEMON_AI_PERSONAS` | listed names → `Persona:AI` |
| Scope/account | `--scope "Chatzi"` | — | ownership anchor for dependent entities |

(The live MCP `remember` verb does not yet thread these — see §9.)

---

## 8. Validation

Validated on a **2K-token slice (19 turns)** of a real Chatzi↔Pythia transcript:

- **Typing (Lock 4/2):** `Chatzi → Person:Human` ✅ (was `org`); `Pythia → Persona:AI` ✅ (was `thing`).
  8 clean entities, no vague-`thing` over-extraction.
- **Noise:** `behavior: signals` / `seeks clarification` = **0** (was ~18 in the pre-discipline draft).
- **Supersession:** **7** (was 25 — the topic-in-object fix stopped same-predicate collisions).
- **Persona captured (real traits):** `Chatzi | design: prefers | evaluating and arguing about claims
  rather than accepting them`; `design: prefers | subagent-driven evaluation`; `design: values | wiki
  as single source of truth`; `praised | spec versioning + security patch docs`.
- **Feedback:** praise fired; corrections correctly **absent** on a slice with none (no fabrication).
- **Balance:** Chatzi ~7 : Pythia ~12 mind-facts (was 8:49 before the discipline pass).

---

## 9. Known limitations / deferred 🔴

- **Live MCP `remember` hardcodes `speaker: "user"`** (`mcp-server-combined.ts:67`) and doesn't thread
  owner/personas — so persona extraction works via **transcript ingestion**, not yet via live
  `remember`. (Threading is a step in the decoupling spec.)
- **Persona extraction is transcript-grade, not live-per-utterance** — it's a heavy pass; the
  verbatim/extraction decoupling + Postgres (Option B) is the substrate that lets it run as a
  concurrent background job. See `MNEMON_OS_DECOUPLING_IMPL_SPEC_v2.md`.
- **`corrected` predicate** will be renamed to **`received_correction`** (Q4) to avoid colliding with
  Lock 6's planned `corrects` relation — pending (a Dev build-step).
- **Behavioral *traits*** (vs single-turn stances) remain a future consolidation/profile projection —
  out of scope here.

---

## 10. File-level change inventory

| File | Change |
|------|--------|
| `llm.ts` | Lazy `getClient()` (was eager module-load client). |
| `README.md` | `fuzzy-test` needs-key label; lineage note. |
| `extract.ts` | Sub-kind vocabulary + `ENTITY KIND` prompt; `owner`/`ai_personas` in `ExtractContext`; explicit `speaker` in payload; the `SPEAKER MIND-FACTS` four-lens section (lenses, 3 fact kinds, markers, shapes, example). |
| `pipeline.ts` | `INDEPENDENT` += sub-kinds; `isIdentityKind`; sticky `promoteType`; `IngestOpts.owner`/`aiPersonas`; Owner/AI anchoring + account-as-person in `ingest()`; `ACCUMULATOR_PREDS` += `corrected`/`erred`/`hallucinated`/`praised`. |
| `ingest-transcript.ts` | `--owner` / `--personas` flags (+ env fallbacks); pass-through to `ingest()`. |

---

## 11. Provenance

Built and validated 2026-06-01 against `grafix-daimonion/mnemon-os` head; documented 2026-06-02.
Commits: `bda136e` (lazy client + README, on `main`), `2fe319d` (Lock 4 + Lock 2 + four-lens, on
`feat/lock4-lock2-persona-sub-kinds`). Validated on a 2K-token real transcript slice. Forward work
(decoupling + Postgres) is specified separately and is **not** in this document.
