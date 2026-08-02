# Mnemon backends — choose your install

Mnemon offers **four install paths** (three classes + one combined). Pick by how your agent
will talk to Mnemon and where the LLM work runs. Switching later is a config change, not a
re-architecture.

| Path | Transport | Server-side LLM? | API key? | Use when |
|------|-----------|------------------|----------|----------|
| **Class 1** | MCP (stdio) | yes — server does extract / QA / recall reasoning | yes (`ANTHROPIC_API_KEY`) | You're on Claude Code and want `remember` / `recall` to "just work." |
| **Class 2** | MCP (stdio) | **no** — host (Claude Code) is the brain | no — host uses its own session | You want $0 ongoing cost beyond your Claude Code subscription, and don't mind a multi-step host-driven flow. |
| **Class 3** | HTTP (Bun.serve + bearer auth) | yes | yes | You're calling from Python / Ruby / Go / curl — anything that isn't Claude Code. |
| **Combined** | MCP (stdio) — ONE process exposes ALL 14 verbs | yes (Class-1 verbs) + no (Class-2 verbs) | yes | You're on Claude Code and want **both** read surfaces: simple `recall` for everyday questions AND `recall_candidates` for richer multi-step reasoning. |

The fastest path: `bun run setup.ts` runs the interactive chooser and writes `.env` + prints
the `claude mcp add` command for your choice.

---

## Class 1 — server-side LLM, MCP (recommended for most agents)

**Setup**
```sh
bun run setup.ts --classes=1                # interactive; or pass --yes for non-interactive
# Then run the printed `claude mcp add` command and paste templates/CLAUDE.memory.class1.md
# into your agent's CLAUDE.md.
```

**Verbs (4):** `remember(text)` · `recall(question)` · `recall_as_of(question, date)` · `history(subject)`

**Wins**
- Highest-quality LLM judgments. Default model is Haiku 4.5; opt-in Sonnet 4.6 via
  `MNEMON_LLM_MODEL=claude-sonnet-4-6` for installs with dense / multi-claim content.
- Fastest per-call (<1 s typical on Haiku).
- Eval: **Haiku 8/8 in 51 s · Sonnet 7/8 in 87 s** (measured 2026-05-26, E4 validation).
- Bulk ingest of a 500-turn transcript: **~60–90 min on Haiku**.

**Trade-offs**
- Costs money (small; see §Cost below).
- Calls leave your machine (Anthropic sees chunk text + facts during processing).
- Requires the key.

---

## Class 2 — host-as-brain, MCP (no API key)

**Setup**
```sh
bun run setup.ts --classes=2
# No API key needed. Paste templates/CLAUDE.memory.class2.md into your agent's CLAUDE.md.
```

**Verbs (10):** `archive` · `assert_fact` · `find_entity` · `resolve_or_create_entity` ·
`recall_candidates` · `keyword_evidence` · `mark_superseded` · `unmark_superseded` ·
`history` · `read_diary`

**Wins**
- **$0** ongoing cost beyond your Claude Code subscription.
- **No key** — nothing leaves the machine *unless* your Claude Code session itself routes to
  Anthropic (which it does — but that traffic is on your subscription, not your API).
- Strongest possible LLM judgment for extraction + recall, because *you* (Claude Code) are
  doing it — no separate model.
- All bi-temporal mechanics (`mark_superseded` / `unmark_superseded`) + honest-empty
  arbiter (`keyword_evidence`) + identity resolution (`find_entity` /
  `resolve_or_create_entity`) are server-side and deterministic — no LLM in the server.

**Trade-offs**
- **Multi-step write path** — the host (your CLAUDE.md template) must `archive` → extract →
  `find_entity` → `resolve_or_create_entity` → `assert_fact` for each fact. Not "one call."
- **Host owns faithfulness QA** — the trust boundary is per-install explicit (the contract
  the template establishes).
- **Token cost is yours** — every `recall_candidates` returns candidates the host then
  reasons over; that's tokens on your Claude Code subscription.

---

## Class 3 — server-side LLM, HTTP API (any language)

**Setup**
```sh
bun run setup.ts --classes=3
# Generates a bearer token; prints the `bun run api-server.ts` command.
curl -H "Authorization: Bearer $MNEMON_API_TOKEN" http://127.0.0.1:7777/health
```

**Endpoints (mirror Class 1 verbs):** `POST /remember` · `POST /recall` · `POST /recall_as_of` · `GET /history`

**Wins**
- Same LLM quality as Class 1 (same server-side path; same `MNEMON_LLM_MODEL` knob).
- Any language can call it — Python, Ruby, Go, curl, your shell.
- Bearer auth + a local-only listener by default (`127.0.0.1`).

**Trade-offs**
- Costs money (same per-call cost as Class 1).
- One extra process to keep alive (`launchctl` / `systemd` / `tmux`).
- ⚠ **Cannot coexist with combined-server on the same store** (PGLite single-writer; see
  `MNEMON_OS_ENGINE_SPEC_v6 §15c`). Workaround: run Class-3 against a different
  `MNEMON_DATA` directory.

---

## Combined — Class 1 + Class 2 in ONE process

A single MCP server (`mcp-server-combined.ts`) exposes **all 14 verbs** (4 Class-1 + 10
Class-2) against ONE store. Resolves the F-MNEMON-20 PGLite single-writer-lock that
prevents running two separate MCP servers against the same data dir.

**Setup**
```sh
bun run setup.ts --classes=combined
# Setup chooser asks: which write path? (Class-1 'remember' default, or Class-2 'assert_fact')
# Pastes the chosen template (combined.md or class2.md) into the right place.
```

**The single-class-at-write contract (important).** Combined installs must designate **ONE
primary write path** at setup time (see `ENGINE_SPEC_v6 §4.2` / `CLASS2_DESIGN_v6 §3.4d`):

| Primary write path | When to choose | `facts.status='confirmed'` means |
|--------------------|----------------|----------------------------------|
| **Class-1 `remember` (default)** | Host LLM ≈ `MNEMON_LLM_MODEL`; you want audited server-side QA | Server-side QA promoted it |
| **Class-2 `assert_fact`** | Host LLM is meaningfully stronger than `MNEMON_LLM_MODEL` | Host asserted it (host bears the faithfulness judgment) |

This is a *UX gate* (per §4.2a / §3.4e enforcement decision): `setup.ts` picks one and
installs the matching template; the other surface is read-mostly. No schema gate, no
runtime gate — the contract is established by which template the install ships with.

**Wins**
- Both read surfaces: simple `recall` (cheap; server reasons) + `recall_candidates` (rich;
  host reasons).
- One process, one store, one `claude mcp add` — simpler ops than running Class-1 and
  Class-2 servers side-by-side (which PGLite blocks anyway).
- Same server-side LLM as Class 1 (same `MNEMON_LLM_MODEL` knob).

**Trade-offs**
- Needs an `ANTHROPIC_API_KEY` (the Class-1 verbs require it).
- More verbs = more template responsibility — `templates/CLAUDE.memory.combined.md` tells
  the agent which verb to reach for when.
- Same Class-3 × combined coexistence limit as Class 3 above (PGLite single-writer).

---

## Choosing the model — `MNEMON_LLM_MODEL` (Class 1 / 3 / combined)

Default: `claude-haiku-4-5-20251001`. Opt-in: `claude-sonnet-4-6`.

| Model | Eval (E4 baseline) | Wall-clock | Per-month cost (heavy: ~100 remembers/day) |
|-------|-------------------|-----------|--------------------------------------------|
| Haiku 4.5 (default) | 8/8 in 51.4 s | tight, deterministic | ~$15 |
| Sonnet 4.6 (opt-in) | 7/8 in 86.5 s (1 fail = verbosity scoring fragility, not recall regression) | ~1.7× slower | ~$75 |

When to choose Sonnet: dense / multi-claim content where extraction *recall* matters more
than per-call cost. The lower scorer-match band is a known eval scoring fragility
(W-MNEMON-25); the via-verbatim fallback still surfaces the right anchor.

Set per-install via `.env`:
```
MNEMON_LLM_MODEL=claude-sonnet-4-6
```

The setup chooser writes this for you — pass `--llm-model=sonnet` non-interactively.

---

## The local-only fallback (no LLM at all)

Don't have an API key + don't want to use Claude Code as the host either? Class 2 still
works for the *write* path if you call it from a non-Anthropic host — but you'd be
writing your own extraction/QA logic.

What always works without any LLM:
- `archive` — verbatim turn capture, chunked + embedded with the local `bge-small`
  (~50 MB, downloaded once).
- `recall_candidates` (chunks only — the verbatim floor) — returns the user's own words.
- `keyword_evidence` — deterministic FTS over the verbatim. The honest-empty arbiter.

You lose: fact extraction, bi-temporal supersession (no facts to supersede), structured
`recall` answers. You keep: every word ever stored, plus search over it.

---

## Cost — Class 1 / 3 / combined (Anthropic API)

**Per-operation breakdown** (measured on real data; see `MNEMON_OS_PROGRESS_REPORT_v5`):

Each `remember` typically fires:
- 1 × `extractFacts` per chunk (~700 tokens; a typical turn = 1–3 chunks)
- 3–5 × `faithful` QA — one per fact (~1500 tokens total)
- 0–2 × `contradicts` — one per open same-subject fact (~350 tokens)
- 0–1 × `sameEntity` — only for fuzzy near-misses (~250 tokens)
- **~2,500–4,500 tokens per `remember`** on Haiku 4.5 (more on Sonnet due to verbosity)

Each `recall` typically fires:
- 1 × `subjectOf` (~250 tokens)
- 1 × `answerFrom` (~680 tokens)
- 0.3 × `answerFromChunks` fallback (~200 tokens average)
- **~1,000–1,200 tokens per `recall`** on Haiku

**Two usage scenarios** (Haiku 4.5):

| Scenario | Daily mix | Tokens/day | $/day | $/month |
|----------|-----------|------------|-------|---------|
| **Light** — ~20 remembers + 50 recalls + 5 as-of | ~110 k | ~$0.15–0.25 | **~$5–8** |
| **Heavy** — ~100 remembers + 100 recalls + 10 as-of | ~360 k | ~$0.50–0.70 | **~$15–22** |

On Sonnet 4.6, multiply by ~4–5× for both extraction-heavy and recall-heavy mixes.

**One-off bulk ingest** (Haiku, measured this period):

| Transcript | Turns | Tokens | Cost |
|------------|-------|--------|------|
| Short slice | 40 | ~100 k | ~$0.15 |
| One transcript | 231 | ~580 k | ~$0.80 |
| Larger transcript | 519 | ~1.3 M | ~$1.80 |
| Combined accumulation run | 750 | ~1.9 M | ~$2.70 |

> Pricing assumes ~70% input / 30% output (typical for this engine). Verify current rates
> at [anthropic.com/pricing](https://www.anthropic.com/pricing).

**Honest caveats**
- Averages. A turn with denser facts → more `faithful` calls → more tokens.
- `contradicts` + `sameEntity` are rare in clean data; somewhat more in noisy conversations.
- A `recall` against a very large fact set passes more facts to `answerFrom`, slightly
  increasing per-call cost.
- Class 2 cost is **on your Claude Code subscription, not your API key** — the breakdown
  above applies only when the server makes the LLM call.

---

## Switching paths later

Each install path is a config + template + `claude mcp add` registration — no code
changes. To switch, re-run `bun run setup.ts` and pick a different option. The store
stays at `~/.mnemon/store` (or your custom `MNEMON_DATA`); facts/chunks already there are
preserved.

Re-ingesting old transcripts on a new path will produce *new* facts (extraction is path-
dependent: Class 1 server extracts vs Class 2 host extracts). They accumulate alongside the
originals — no loss, but you may see duplicates if you don't drop the store first.

---

## TL;DR

- **Default choice: Class 1.** Lowest friction, lowest token cost on your side, audited.
- **No API key budget? Class 2.** $0 server cost; pay in template complexity + Claude Code
  tokens.
- **Calling from non-Claude-Code? Class 3.** HTTP + bearer.
- **Want both read surfaces? Combined.** Pick a write path; the other surface is read-mostly.
- **Cost on Class 1 / 3 / combined is genuinely small** — under $10/mo typical, under
  $25/mo heavy. Sonnet ~4–5× that.
- **The L0 verbatim floor always works** — you never lose your words, regardless of path.
