# Mnemon_OS

Open-source, domain-agnostic memory for AI agents over **MCP** (and HTTP). The engine is a
commodity; the differentiators are **bi-temporal correctness** (what's true now vs. what
was true then), **honest-empty** ("won't lie" — no fabricated recall), and an identity
layer with deterministic supersession.

> **Status: early / work-in-progress.** The bi-temporal + honest-empty core is built and
> measured on an eval harness, validated end-to-end on real transcripts, connected over
> MCP, and packaged into four install paths (three classes + combined).

## Quick start — `setup.ts` picks your install path

Requires [Bun](https://bun.sh).

```sh
git clone <this-repo> ~/mnemon-os && cd ~/mnemon-os
bun install
bun run setup.ts          # interactive chooser
```

The chooser asks which install path you want, writes `.env`, and prints the
`claude mcp add` command + the right `templates/CLAUDE.memory.*.md` to paste into your
agent's `CLAUDE.md`. Run any time to change selection.

### The four paths (short version)

| | What it is | Needs | Cost |
|---|---|---|---|
| **Class 1** | Server does LLM (extract / QA / recall). You call `remember` / `recall`. | `ANTHROPIC_API_KEY` | ~$5–25/mo Haiku (default) or ~$15–75/mo Sonnet |
| **Class 2** | NO LLM in server. **You** (Claude Code) drive a multi-step host-as-brain flow. | Just a Claude Code subscription | $0 server-side; tokens on your subscription |
| **Class 3** | Server-side LLM via HTTP API + bearer auth. Any language can call it. | `ANTHROPIC_API_KEY` | Same as Class 1 |
| **Combined** | Class 1 + Class 2 in ONE process. Pick one primary write path; both read surfaces are available. | `ANTHROPIC_API_KEY` | Same as Class 1 |

See [BACKENDS.md](./BACKENDS.md) for the full trade-off table, per-operation cost
breakdown, and the single-class-at-write contract for combined installs.

### Verify the engine works (any install path)

```sh
bun run mcp-smoke.ts                  # Class 1
bun run mcp-smoke-class2.ts           # Class 2 (no API key needed)
bun run mcp-smoke-combined.ts         # Combined (Class 1 + Class 2 in one process)
bun run api-smoke.ts                  # Class 3 (HTTP)
bun run fuzzy-test.ts                 # entity-resolution unit tests (must be 31/31)
```

### First-run notes
- The local embedder (~50 MB, `bge-small`) downloads + warms up on first use; first
  `remember` / `recall` is slower than later ones. After that it's hot.
- The store lives at `~/.mnemon/store` by default — file-backed, survives across
  sessions. Override per-install with `MNEMON_DATA`.
- If the tools don't appear in a Claude Code session, the MCP server isn't connected —
  re-run the smoke test for your install path, then check `claude mcp list`.

---

## What's here (developer view)

**Engine**
- `schema.sql` — the store (Postgres / PGLite + pgvector)
- `pipeline.ts` — the Class-1 write path (archive verbatim → per-chunk parallel extract →
  resolve → contradiction → current-state)
- `pipeline-class2.ts` — the Class-2 primitives (host-as-brain: `archive`, `assertFact`,
  `markSuperseded`, `unmarkSuperseded`)
- `synapsis/` — `resolve.ts` (bi-temporal core), `fuzzy.ts` (identity by label +
  Damerau-Levenshtein + version policy), `verify.ts` (faithfulness QA)
- `recall.ts` — Class-1 read path (current / as-of / honest-empty)
- `recall-class2.ts` — Class-2 read path (`recall_candidates`, `keyword_evidence`,
  `history`, `read_diary`)
- `entity-class2.ts` — Class-2 entity verbs (`find_entity`, `resolve_or_create_entity`)
- `diary.ts` — L5 deterministic Diary projection; `rebuild-diary.ts` — manual rebuild
- `llm.ts` — Anthropic SDK seam; `MNEMON_LLM_MODEL` env var (default Haiku 4.5, opt-in
  Sonnet 4.6)

**Servers + transports**
- `mcp-server.ts` — Class 1 MCP (stdio)
- `mcp-server-class2.ts` — Class 2 MCP (stdio)
- `mcp-server-combined.ts` — Combined MCP (stdio); 14 verbs against one store
- `api-server.ts` — Class 3 HTTP (Bun.serve + bearer)

**Onboarding**
- `setup.ts` — interactive installer (writes `.env`, prints `claude mcp add`)
- `templates/CLAUDE.memory.class1.md` · `class2.md` · `combined.md` — drop-in memory rules
- `templates/.env.example`

**Tests + eval**
- `mcp-smoke.ts` / `mcp-smoke-class2.ts` / `mcp-smoke-combined.ts` / `api-smoke.ts`
- `fuzzy-test.ts` — entity-resolution + version policy (31/31)
- `eval/*.fixture.json` + `run-eval.ts` — eval gate (Haiku 8/8; Sonnet 7/8 with scoring
  fragility caveat)
- `qa.ts` — stability + extraction-drift measurement

### Develop

```sh
bun install
cp templates/.env.example .env        # paste ANTHROPIC_API_KEY (chmod 600 the file)
bun run run-eval.ts                   # the eval gate (Haiku)
MNEMON_LLM_MODEL=claude-sonnet-4-6 bun run run-eval.ts   # Sonnet band
bun run qa.ts                         # stability + extraction-drift measurement
bun run fuzzy-test.ts                 # entity-resolution unit + integration tests
```

Ingest a transcript (JSON/JSONL/CSV) into a local file-backed store, then query it:

```sh
bun run ingest-transcript.ts <file> --scope "<owner/account>"
bun run ask.ts "your question" --data ./data/<store>
bun run browse.ts --data ./data/<store>
bun run compare-stores.ts ./data/<a> ./data/<b>   # side-by-side fragmentation metrics
```

## Clean-room
Built from an architecture specification; no code is copied from any prior or proprietary
engine.

## License
MIT — see [LICENSE](./LICENSE).
