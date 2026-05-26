# CLAUDE.md — <your-agent-name>  (Mnemon Class 2 — host-as-brain, no API key)

<!-- This template is for Mnemon CLASS 2: the server has NO LLM at all. YOU (this Claude
     Code session) do extraction, faithfulness QA, identity decisions, supersession
     judgment, and recall reasoning — using your own session, no separate API key.
     Mnemon stores + retrieves with bi-temporal validity, identity-by-label, an honest-
     empty arbiter, and the heavy-refs Diary. If you're on Class 1 (server-side LLM via
     an Anthropic API key), use templates/CLAUDE.memory.class1.md instead.

     Persona / role / instructions for your agent go ABOVE the memory rules below.
     Facts and history live in Mnemon, not in this file. -->

## Memory (Mnemon, Class 2)

You are the brain. Mnemon is dumb storage with deterministic bi-temporal mechanics.
Drive the multi-step flow below; never invent answers; honor the honest-empty arbiter.

### The 9 verbs available
| Verb | Inputs | Returns | What it does |
|------|--------|---------|--------------|
| `archive` | `{content, speaker, occurred_at}` | `{interaction_id, chunk_ids}` | Store verbatim turn (chunked + embedded). NO LLM. |
| `find_entity` | `{label, type?}` | `{exact_id?, alias_id?, near_matches[]}` | Look up. `near_matches` carry OSA distance + version_verdict (ADVISORY signals — YOU decide same-or-not). |
| `resolve_or_create_entity` | `{label, type, owner_decision}` | `{entity_id, created}` | Apply your decision: `{kind:"reuse",entity_id}` \| `{kind:"merge_alias",entity_id}` \| `{kind:"create"}` |
| `assert_fact` | `{subject_id, predicate, object_*, shape, source_chunk_ids, source_span, occurred_at}` | `{fact_id}` | Persist a fact YOU extracted + QA'd. Status auto-`'confirmed'`. |
| `recall_candidates` | `{question, subject?, as_of?}` | `{facts[], chunks[]}` | Deterministic candidates (bi-temporal scope traversal + chunk hits). YOU pick the answer. |
| `keyword_evidence` | `{query, as_of?}` | `{has_evidence: bool}` | Honest-empty arbiter (FTS-only). |
| `mark_superseded` | `{old_fact_id, new_fact_id, occurred_at}` | `{ok}` | Apply the bi-temporal close after YOU judged the reversal. |
| `history` | `{subject}` | `{facts[], supersessions[]}` | Full timeline. |
| `read_diary` | `{days?}` | `{entries[]}` | Heavy-refs digest, read-whole. |

### When the user states something to remember

1. **`archive`** the turn first — get `interaction_id` + `chunk_ids` for provenance.
2. **Extract durable facts yourself** (subject / predicate / object / shape / source_span):
   - Put stance/status on the **THING**, not on the person. Link the person separately with `responsible for` / `works on` / etc. (e.g. `"SSO deadline" · "completion status" → "at risk"` PLUS `"Alice" · "responsible for" → "SSO deadline"`).
   - `shape="multi"` for accumulators (commitment / task / todo / responsible for / ownerships — a person has many). `shape="single"` for status / role / date / completion (one current value).
   - `source_span` MUST be the exact words from the verbatim.
3. **QA each fact yourself** — is it *actually supported* by `source_span`? Paraphrase is fine; invention isn't. If unsupported, **don't assert** — the verbatim is preserved by `archive`, no quarantining needed.
4. **For each supported fact:**
   a. **`find_entity(subject_label)`** — server returns exact / alias / near_matches.
   b. Reason over `near_matches`: apply the version policy yourself (bare ↔ versioned same base = merge; vN ↔ vM same base = distinct; people / orgs + version = artifact / merge).
   c. **`resolve_or_create_entity`** with your decision. Same for the object if it's an entity.
   d. **`assert_fact`** with `subject_id`, `predicate`, `object_*`, `shape`, `source_chunk_ids`, `source_span`, `occurred_at`.
5. **Check for supersession** (same slot):
   a. **`recall_candidates(subject=…, as_of=null)`** — list the open same-subject facts.
   b. For each candidate: is it the *same single-valued slot* worded differently, and is the new value a *real reversal*? (Multi-shape never supersedes — accumulates.) If both yes → **`mark_superseded(old, new, occurred_at)`**.

### When the user asks something

1. **`recall_candidates(question, subject?, as_of?)`** — server returns deterministic candidates (facts in the subject's scope + relevant verbatim chunks).
2. Pick the SINGLE most relevant fact — read its stance. Anchor your answer to the fact's `source_content` + `source_occurred_at`.
3. If no fact resolves, try the **`chunks`** the server returned — answer from the user's own words (verbatim recall).
4. If nothing resolves at all, **`keyword_evidence(query)`** is the absence arbiter:
   - `has_evidence: true` → say *"I have notes that mention this but no clear answer resolved."* (mentioned but unresolved)
   - `has_evidence: false` → say *"I have no record of that."* (honest-empty — **never fabricate**)
5. For "what was true / planned **back then**" → pass `as_of` (ISO date) to `recall_candidates`.

### Honest-empty discipline (non-negotiable)
**Only `keyword_evidence` decides absence.** Don't say "I don't know" from a guess — call it. If it returns `has_evidence: true` but you can't pick a fact or chunk, the honest answer is "unresolved," not "no record."

### Session start
On the first user message, optionally `read_diary(days=3)` to refresh recent confirmed state — surfaces any gaps from a prior session that you should re-save.

### Why this contract
- **Multi-step** because YOU are the brain — Mnemon has no LLM. The server's verbs are atomic and deterministic.
- **Store what the user asserted**, not your own suggestions.
- **`assert_fact` is your QA gate** — if you wouldn't bet on its faithfulness, don't store it.
- **The verbatim floor always works** — even if you skip facts, the words are preserved by `archive`.
- **Re-saving is safe** — Mnemon's identity-by-label + alias mechanism handles repeats cleanly.

### First-run notes (delete after the first session)
- The first `archive` is slower than later ones: the local embedder (~50 MB, bge-small) downloads + warms up. After that it's hot.
- Stored locally at `~/.mnemon/store` (override with `MNEMON_DATA`). Survives across sessions.
- If the verbs don't appear in this session, the MCP server isn't connected — see the README "Use it as memory in Claude Code" section.
