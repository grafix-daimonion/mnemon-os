# Mnemon_OS

Open-source, domain-agnostic memory for AI agents over **MCP**. The engine is a commodity; the
differentiators are **bi-temporal correctness** (what's true now vs. what was true then),
**honest-empty** ("won't lie" — no fabricated recall), and an identity layer.

> **Status: early / work-in-progress.** The bi-temporal + honest-empty core is built and measured on
> an eval harness, validated end-to-end on real transcripts, and connected over MCP.

## Use it as memory in Claude Code

The 5-minute path from clone → your agent has memory.

### 1. Install
Requires [Bun](https://bun.sh).

```sh
git clone <this-repo> ~/mnemon-os && cd ~/mnemon-os
bun install
cp templates/.env.example .env       # then paste your key into .env
```

### 2. Verify the engine works
```sh
bun run mcp-stdout-check.ts > /tmp/out 2> /tmp/err && test ! -s /tmp/out && echo CLEAN
bun run mcp-smoke.ts                  # spawns the server, runs remember + recall end-to-end
```
You should see `CLEAN`, then `TOOLS: remember, recall, recall_as_of, history` and a successful
`remember` → `recall` round-trip.

### 3. Register with Claude Code
The MCP server is `mcp-server.ts`. Register it (adjust `--scope` to taste — `user` makes it available
in every Claude Code session; drop the flag to scope it to the current project only):

```sh
claude mcp add mnemon --scope user \
  --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -- bun run /ABSOLUTE/PATH/TO/mnemon-os/mcp-server.ts
```

### 4. Tell your agent how to use it
Mnemon ships with a drop-in memory-rules snippet for your agent's `CLAUDE.md` — without it the agent
will likely *forget to use* the verbs. Copy it into the agent project where Claude Code runs:

```sh
cp templates/CLAUDE.memory.md /path/to/your/agent/CLAUDE.md
# then add your persona/role/instructions at the top of that file
```

The template defines: `recall` first, `remember` on stated decisions, `history` on subjects,
honest-empty is real, session-start check — plus the verb table.

### First-run notes
- The local embedder (~50 MB, `bge-small`) downloads + warms up on first use; first
  `remember` / `recall` is slower than later ones. After that it's hot.
- The store lives at `~/.mnemon/store` by default — file-backed, survives across sessions.
  Override per-project with the `MNEMON_DATA` env var on the spawned MCP server.
- If the tools don't appear in a Claude Code session, the MCP server isn't connected —
  re-run step 2 to verify the engine, then check `claude mcp list`.

---

## What's here (developer view)
- `schema.sql` — the store (Postgres / PGLite + pgvector)
- `pipeline.ts` — the write path (archive verbatim → extract → resolve → contradiction → current-state)
- `synapsis/resolve.ts` — contradiction → current-state (the bi-temporal core)
- `synapsis/fuzzy.ts` — entity resolution (identity-by-label, Damerau-Levenshtein, version policy)
- `synapsis/verify.ts` — faithfulness QA + same-entity QA (verify, don't trust)
- `recall.ts` — the read path (current / as-of / honest-empty), as explicit single-job steps
- `mcp-server.ts` — the MCP server (stdio); `mcp-smoke.ts` — end-to-end smoke test
- `templates/` — `CLAUDE.memory.md` (drop into your agent) + `.env.example`
- `eval/*.fixture.json` + `run-eval.ts` + `qa.ts` — the eval + QA harness (stability / drift / review)

## Develop
```sh
bun install
export ANTHROPIC_API_KEY="your-key"   # or put it in a local .env (git-ignored)
bun run run-eval.ts                    # the eval gate
bun run qa.ts                          # stability + extraction-drift measurement
bun run fuzzy-test.ts                  # entity-resolution unit + integration tests
```

Ingest a transcript (JSON/JSONL/CSV) into a local file-backed store, then query it:

```sh
bun run ingest-transcript.ts <file> --scope "<owner/account>"
bun run ask.ts "your question" --data ./data/<store>
bun run browse.ts --data ./data/<store>
bun run compare-stores.ts ./data/<a> ./data/<b>   # side-by-side fragmentation metrics
```

## Clean-room
Built from an architecture specification; no code is copied from any prior or proprietary engine.

## License
MIT — see [LICENSE](./LICENSE).
