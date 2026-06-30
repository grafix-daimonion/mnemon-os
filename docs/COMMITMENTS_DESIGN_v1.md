# Mnemon_OS — Commitments as a First-Class Memory Primitive

## Document Control

| Field | Value |
|-------|-------|
| Title | Commitments — directed, deadline-bearing obligations as a core engine primitive |
| Version | **v1 (built — pending review)** |
| Status | **IMPLEMENTED + VERIFIED 2026-06-30 (TDD). Pythia/Dev review PENDING.** The two reversal eval cases (`current-state`, `paraphrase-reversal-current`) went from 100% FAIL → 100% PASS across 3 clean runs. Q3 resolved (see §6). |
| Date | 2026-06-30 |
| Author | Chatzi (drafted during the commitment-extraction recovery session) |
| Reviewers | Pythia (⏳ pending) · Dev (⏳ pending) |
| Supersedes | — (new doc) |
| Engine baseline | Mnemon_OS **v8** (single-Owner, MCP, Bun/PGLite), schema `schema.sql` (5 tables → 6) |
| Scope | How Mnemon stores commitments/promises. Placement decision + table design + lifecycle. NOT Betty persona content; NOT the extractor prompt (companion change). |

---

## 1. Context — the bug that started this

The extractor stores facts as `subject → predicate → object` triples. A commitment utterance —
*"I'll send you the report by Friday"* — collapses to `Speaker → will_send → report`. **The
recipient ("you") is dropped**, because a 3-slot triple has exactly one slot past the subject and
that slot is already spent on the object. Time ("Friday") and modality ("will/promise") are lost
too. For an assistant whose users have **customers**, "what did we promise whom, by when, and did
we deliver?" is a primary query — and today it is unanswerable.

This was confirmed empirically in-session (the speaker-context fix in `synapsis/verify.ts` recovered
false-quarantined commitments, but the *recipient* loss is structural, not a QA bug).

---

## 2. The decision

**Commitments become a first-class, dedicated, typed table in the Mnemon engine core.** They are
**not** modeled as reified `facts` triples, and they are **not** pushed into a separate CS-layer
database.

Two sub-decisions, recorded separately because they were graded separately during review:

- **D1 — Dedicated typed table, not reified triples.** *Robustly supported.* (§4, §6)
- **D2 — In the engine core, not a separate layer.** *Decided on present-tense business grounds.* (§3)

---

## 3. Why in the core — and why that is NOT premature generalization

An adversarial verification pass (instructed to argue *against* core placement) established that the
strongest objection to putting domain structure in the core is **YAGNI / Speculative Generality**:
building for a second domain that does not yet exist. That objection rests entirely on the domain
being *hypothetical*.

**It is not hypothetical here.** The product is memory for businesses, and those businesses have
customers. Commitment-tracking is therefore a **certainty across the entire user base**, not a
maybe-someday domain. The YAGNI objection collapses on its own terms.

The clinching reframe: **a commitment is a universal memory primitive the engine was missing, not a
CS bolt-on.** *"X owes Y a thing by T"* is as fundamental as *"X is-a Y."* Mnemon could already say
*"Acme uses Postgres"* but could not say *"we promised Acme a fix by Friday."* That is an
expressiveness hole in the engine for **any** relationship-bearing user — it merely becomes glaring
once customers enter the picture. Filling it *completes* the generic engine rather than branching it.

Consequences accepted with eyes open:
- **Positioning shift.** Mnemon is now "a memory engine with first-class commitments," not a
  domain-neutral one. Given the business, this is a sharper product and a **deeper moat** — the OSS
  memory landscape (Letta / Zep / Cognee / Mem0) ships no first-class commitments; directed,
  bi-temporal obligations extend Mnemon's honest-empty + verbatim + bi-temporal differentiation.
- **No cross-boundary cost.** Because the table lives in the same Postgres/PGLite instance as
  `entities`, `recipient_id` is a *real, enforced* FK. The cross-database integrity hazards and
  migration-coupling that a separate CS-layer table would incur simply do not arise.

Betty (and the CS Exec Assistant) is the **surface** that captures and chases commitments; the
engine **stores and time-versions** them.

---

## 4. Why a table and not reified triples

Shattering a hot, frequently-mutated concept into ~5 triples fails on the four axes that matter:

| Axis | Reified triples | Dedicated table |
|------|-----------------|-----------------|
| Integrity | Cannot enforce `recipient_id NOT NULL`, `status IN (...)`, FK | Enforced by the schema |
| Write | 1 commitment = 1 entity + ~5 facts in a txn; status flip = multi-row delete+insert | One row; status = one cell |
| Read (hot path) | "open promises to Acme, overdue first" = 5-way self-join | One indexed `WHERE` |
| Scale | Reified-statement models degrade at volume (cf. Wikidata qualifier timeouts) | Standard relational scaling |

Even graph-native memory systems that win on latency do so by making validity a **native edge
attribute**, not a reification — i.e. they too give the concept first-class typed identity, which a
table is.

---

## 5. Schema — `commitments` (6th core table)

```sql
-- 6. commitments — directed, deadline-bearing obligations. "owner owes recipient an action by due_at."
-- A universal primitive (not CS-specific): any relationship-bearing memory needs it.
-- Reuses entities (owner/recipient/about), interactions (provenance), and the bi-temporal
-- + QA-status machinery already proven on `facts`.
create table if not exists commitments (
  id                    bigserial   primary key,

  -- participants (the slots a triple cannot hold)
  owner_id              bigint      not null references entities(id),  -- who must act   (the promiser)
  recipient_id          bigint      not null references entities(id),  -- WHO IT'S TO    (the recovered slot)
  about_id              bigint      references entities(id),            -- the deal/thing it concerns (optional)

  action                text        not null,                          -- "send the report" (verbatim promise text)
  due_at                timestamptz,                                   -- "by Friday" (nullable: open-ended promises)
  modality              text        not null default 'promise',        -- promise|will|intend|must (commissive force)
  status                text        not null default 'open',           -- open|fulfilled|broken|cancelled

  -- bi-temporal — same primitives as `facts`, applied to obligations
  valid_from            timestamptz not null,                          -- when the promise was made
  valid_until           timestamptz,                                   -- NULL = still live; closed on fulfilled/broken/superseded
  superseded_by         bigint      references commitments(id),        -- "actually, make it Monday"

  -- provenance — same contract as `facts` (honest-empty rests on this)
  source_interaction_id bigint      not null references interactions(id),
  source_span           text,                                          -- exact words this came from
  source_chunk_id       bigint      references chunks(id),
  qa_status             text        not null default 'confirmed',      -- provisional|confirmed|quarantined
  confidence            real        not null default 1.0,

  created_at            timestamptz not null default now()
);

-- the hot path: "open promises to <recipient>, overdue first"
create index if not exists commitments_recipient_open
  on commitments (recipient_id, due_at) where valid_until is null;
-- owner's open obligations
create index if not exists commitments_owner_open
  on commitments (owner_id, due_at) where valid_until is null;
-- recall_as_of windowing (mirrors facts_validity)
create index if not exists commitments_validity on commitments (valid_from, valid_until);
```

`recipient_id` is `NOT NULL` **by design** — a commitment with no recipient is the original bug. The
schema now makes that bug unrepresentable.

---

## 5b. What was built (2026-06-30, TDD — 20 unit assertions + eval acceptance)

- `commitments` table + 3 hot-path indexes + status-provenance columns (`status_at`,
  `status_source_interaction_id`, `status_source_span`) → `schema.sql`.
- `commitments.ts`: `createCommitment`, `currentCommitmentFor`, `applyReversal` (re-anchors status
  provenance to the reversal), `commitmentVerdict` (status → yes/no, anchored to the status source).
- `pipeline.ts`: routes extracted `commitments`/`reversals` to the table, reusing the same entity
  resolver as facts (so "API rollout" ≈ "API migration" collapses and a reversal finds its commitment).
- `extract.ts`: emits `commitments`/`reversals` channels alongside `facts` (third-party "Bob said…"
  → owner Bob; "can't make it"/"won't finish" → reversal).
- `recall.ts`: STEP 1.5 — for current-state questions a commitment's live status is authoritative and
  shadows any stale "X committed to Y" fact; as-of queries still use the bi-temporal facts/verbatim path.
- Companion bug fixes found en route: `verify.ts` reported-speech faithfulness rule (third-party facts
  no longer wrongly quarantined); `llm.ts` returns null instead of throwing on unparseable JSON
  (one malformed model reply no longer aborts an ingest/recall).
- **Result:** `current-state` + `paraphrase-reversal-current` 100% FAIL → 100% PASS (3/3 clean runs).
- **Tests:** `commitments-test.ts`, `commitments-routing-test.ts`, `commitment-recall-test.ts`.

## 6. Lifecycle (bi-temporal, never-delete)

- **Made:** insert with `status='open'`, `valid_from = occurred_at`, `valid_until = NULL`.
- **Fulfilled / broken:** set `status`, close `valid_until` at the resolving moment. The row is
  **kept** — "what did we promise as of last month, and did we keep it?" stays answerable
  (`recall_as_of` applied to obligations).
- **Renegotiated** ("make it Monday"): insert the new commitment, point the old one's
  `superseded_by` at it, close the old `valid_until`. Same supersession pattern as `facts`.
- Never `DELETE`. Consistent with the research never-delete principle.

---

## 7. Companion change (separate, not in this doc's scope)

The extractor must stop collapsing commissive utterances to `s-p-o`. It should slot-fill
FrameNet-style — `Speaker / Addressee / Message / Time / Modality` — and route those to
`owner / recipient / action / due_at / modality`. Tracked as a follow-up to `extract.ts`; this doc
covers only storage.

---

## 8. Rejected alternatives

- **(R1) Widen the universal triple** (add recipient/time/modality columns to `facts`). Rejected:
  arity has no natural stopping point; breaks the binary graph edge for *every* fact; NULL-sparse on
  the 2-participant majority; positional slots confuse the extractor.
- **(R2) Reify commitment as `entity(type=commitment)` + role facts.** Rejected per §4 (integrity,
  write amplification, 5-way-join hot path).
- **(R3) Dedicated table in a separate CS-layer database, FK emulated.** Rejected per §3 — once CS is
  in-scope for the core, the boundary is artificial and only buys cross-DB integrity hazards.

---

## 9. Open questions (for review)

- **Q1** — Is `modality` worth four values now, or start with `promise` only and widen later?
- **Q2** — Should `action` ever resolve to an `about_id` entity, or stay verbatim text? (Lean: verbatim.)
- **Q3** — RESOLVED: status carries fulfilled/broken; the row stays current (`valid_until` NULL) so
  recall reads the live status directly. `valid_until` closes only on renegotiation. No separate
  `fulfilled_at` — status-provenance columns (`status_at`/`status_source_*`) capture when/whence.
- **Q4** — Detection/extraction confidence threshold for auto-creating vs. proposing a commitment.

---

## 10. Provenance of this decision

Three research/verification passes in the 2026-06-30 session: (1) KG representation of n-ary directed
facts (W3C n-ary, Wikidata statements, neo-Davidsonian event reification, FrameNet roles); (2) how
real products store commitments (Salesforce Task `WhoId`/`WhatId`, HubSpot associations, Clari/Gong
"creates a Task", Zep/Graphiti edges) — recipient is always a FK, never inline; (3) an adversarial
verification of "keep the core generic," which split the decision, confirmed D1, and exposed the
"future domains" rationale as Speculative Generality — retired here in favour of the universal-primitive
+ present-tense-business grounds in §3.
