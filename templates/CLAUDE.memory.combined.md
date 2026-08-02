# CLAUDE.md — <your-agent-name>  (Mnemon Combined — Class 1 write + Class 2 read)

<!-- This template is for Mnemon's COMBINED-SERVER install — a single MCP server exposing
     ALL 14 verbs (Class 1 + Class 2) against ONE store. You get:
       · Class-1 high-level verbs (server-side LLM) for the write path + simple reads.
       · Class-2 primitive verbs (no LLM in server) for richer reads when you want them.

     Requires an ANTHROPIC_API_KEY (the Class-1 verbs make server-side LLM calls).
     If you want Class-2-only writes (host-as-brain, no key needed for writes), use
     templates/CLAUDE.memory.class2.md instead.

     Persona / role / instructions for your agent go ABOVE the memory rules below.
     Facts and history live in Mnemon, not in this file. -->

## Memory (Mnemon, combined server)

This instance uses **Mnemon** as long-term memory over MCP. **Mnemon is the single source
of truth for facts, decisions, and history.** This file holds only static config + the
memory rules below — facts do **not** live in this file.

### Write path — **`remember` only**

Per the single-class-at-write contract (combined-server installs designate ONE primary
write path), this install writes via Class-1 `remember`. The Class-2 write verbs
(`assert_fact`, `mark_superseded`) are technically callable but are **not the primary
write path for this install** — don't use them for new facts; the QA + bi-temporal book-
keeping happens server-side via `remember`.

- **Recall first.** Before answering anything that could be in memory — past decisions,
  people, projects, prior context — call **`recall`** first. Don't answer from assumption.
  For "what did I think / decide about X *back then*," call **`recall_as_of`** with the date.
- **Remember decisions & facts.** When the user states a decision, fact, preference, or
  commitment — or says "remember this" — call **`remember`**. Store **what the user
  asserted**, not your own suggestions. Re-saving is safe (Mnemon deduplicates); when in
  doubt, save. If the user back-dates something ("last week"), keep that phrasing so the
  fact is dated to the event, not to now.
- **Honest-empty is real.** If Mnemon returns "no evidence," say so — do not fabricate.
  Absence is decided from the source verbatim, not from a guess.
- **Session start.** On a greeting / first message, confirm recent activity is on record;
  if something from a prior session is missing, save it.

### Read path — pick the right verb for the question shape

| If the user wants... | Use | Why |
|---------------------|-----|-----|
| A short, current answer with a verbatim anchor | **`recall`** | Server-side LLM picks the answer from confirmed facts + chunks; honest-empty fallback built in. |
| "What did I think / commit to back then" | **`recall_as_of`** | Bi-temporal AS-OF answer; same shape as `recall`. |
| A human-readable timeline of how a subject changed | **`history`** | Returns formatted text — `YYYY-MM-DD → YYYY-MM-DD: predicate = object`. |
| Programmatic access to the timeline ({facts, supersessions}) | **`history_raw`** | Class-2 JSON projection — when you need to re-process or summarize the timeline yourself. |
| Multiple candidates for the agent to reason over | **`recall_candidates`** | Class-2 candidate set (facts + chunks). Use when `recall` resolves but you want to see the alternatives, or for token-heavy multi-step reasoning. Costs tokens — see below. |
| "Do I have anything mentioning X at all?" | **`keyword_evidence`** | Honest-empty arbiter — `has_evidence: true / false`. Use before reporting "no record." |
| A read-whole digest of the last few days | **`read_diary`** | Deterministic heavy-refs digest; no retrieval needed. |

### The 14 verbs available

| Verb | Class | Purpose |
|------|-------|---------|
| `remember(text)` | 1 (write) | **Your write path.** Save a fact / decision / commitment. |
| `recall(question)` | 1 (read) | Current answer with verbatim source. |
| `recall_as_of(question, date)` | 1 (read) | What was true / believed AS-OF that date. |
| `history(subject)` | 1 (read) | Subject's timeline as formatted text. |
| `archive` · `assert_fact` · `mark_superseded` · `unmark_superseded` | 2 (write — NOT for this install) | Don't use — the contract is `remember` for writes. |
| `recall_candidates` · `keyword_evidence` · `history_raw` · `find_entity` · `resolve_or_create_entity` · `read_diary` | 2 (read) | Available for richer / programmatic queries when you need them. |

### Token economics
The Class-2 read verbs (`recall_candidates`, `keyword_evidence`, `history_raw`) charge
**your** Claude Code session tokens — Mnemon returns the candidates; you do the reasoning.
The Class-1 read verbs (`recall`, `history`) charge the **server's** Anthropic key
(your `ANTHROPIC_API_KEY`) — Mnemon does the reasoning, you get back a short answer.

- For simple questions, prefer `recall` — cheaper for you, audited by Mnemon, less context burn.
- For multi-step reasoning where the agent needs to see alternatives, use `recall_candidates`.

### First-run notes (delete after the first session)
- The first `remember` is slower than later ones: the local embedder (~50 MB, `bge-small`)
  downloads + warms up. After that it's hot.
- Stored locally at `~/.mnemon/store` (override with `MNEMON_DATA` on the spawned MCP
  server). Survives across sessions.
- If the verbs don't appear in this session, the MCP server isn't connected — see the
  mnemon-os README "Use it as memory" section.
