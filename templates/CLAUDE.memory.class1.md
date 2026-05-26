# CLAUDE.md — <your-agent-name>  (Mnemon Class 1 — server-side LLM, API key)

<!-- This template is for Mnemon CLASS 1: server-side LLM via your Anthropic API key.
     The server does extraction, faithfulness QA, contradiction judgment, and recall
     reasoning; you just call the four verbs and read the answer. If you're on Class 2
     (Claude Code subscription, no API key), use templates/CLAUDE.memory.class2.md instead.

     Persona / role / instructions for your agent go ABOVE the memory rules below.
     Facts and history live in Mnemon, not in this file. -->

## Memory (Mnemon, Class 1)

This instance uses **Mnemon** as long-term memory over MCP. **Mnemon is the single source
of truth for facts, decisions, and history.** This file holds only static config + the
memory rules below — facts do **not** live in this file.

Facts, decisions, history, and recall go through Mnemon's tools — NOT this file.

- **Recall first.** Before answering anything that could be in memory — past decisions,
  people, projects, prior context — call **`recall`** first. Don't answer from assumption.
  For "what did I think / decide about X *back then*," call **`recall_as_of`** with the date.
- **Remember decisions & facts.** When the user states a decision, fact, preference, or
  commitment — or says "remember this" — call **`remember`**. Store **what the user
  asserted**, not your own suggestions. Re-saving is safe (Mnemon deduplicates); when in
  doubt, save. If the user back-dates something ("last week"), keep that phrasing so the
  fact is dated to the event, not to now.
- **Entity history.** For how something changed over time, call **`history`** on the subject.
- **Honest-empty is real.** If Mnemon returns "no evidence," say so — do not fabricate.
  (Absence is decided from the source verbatim, not from a guess.)
- **Session start.** On a greeting / first message, confirm recent activity is on record;
  if something from a prior session is missing, save it.

## The verbs

| Verb | Use |
|------|-----|
| `remember(text)` | save a fact / decision / commitment |
| `recall(question)` | current answer, with the verbatim source |
| `recall_as_of(question, date)` | what was true / believed *as of* that date |
| `history(subject)` | the subject's state over time |

## First-run notes (delete after the first session)

- The first `remember` / `recall` is slower than later ones: the local embedder
  (~50 MB, bge-small) downloads + warms up. After that it's hot.
- Stored locally at `~/.mnemon/store` (override with the `MNEMON_DATA` env var on the
  spawned MCP server). The store survives across sessions.
- If Mnemon's tools don't appear in this session, the MCP server isn't connected — see
  the mnemon-os README "Use it as memory in Claude Code" section.
