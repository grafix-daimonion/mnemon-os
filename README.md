# Mnemon_OS

Open-source, domain-agnostic memory for AI agents over **MCP**. The engine is a commodity; the
differentiators are **bi-temporal correctness** (what's true now vs. what was true then),
**honest-empty** ("won't lie" — no fabricated recall), and an identity layer.

> **Status: early / work-in-progress.** The bi-temporal + honest-empty core is built and measured on
> an eval harness; the MCP server and several hardening passes are still in progress.

## What's here
- `schema.sql` — the store (Postgres / PGLite + pgvector)
- `pipeline.ts` — the write path (archive verbatim → extract → resolve → contradiction→current-state)
- `synapsis/resolve.ts` — contradiction → current-state (the bi-temporal core)
- `recall.ts` — the read path (current / as-of / honest-empty), as explicit single-job steps
- `eval/*.fixture.json` + `run-eval.ts` + `qa.ts` — the eval + QA harness (stability / drift / review)

## Run it
Requires [Bun](https://bun.sh).

```sh
bun install
export ANTHROPIC_API_KEY="your-key"   # or put it in a local .env (git-ignored)
bun run run-eval.ts                    # the eval gate
bun run qa.ts                          # stability + extraction-drift measurement
```

Ingest a transcript (JSON/JSONL/CSV) into a local file-backed store, then query it:

```sh
bun run ingest-transcript.ts <file> --scope "<owner/account>"
bun run ask.ts "your question" --data ./data/<store>
bun run browse.ts --data ./data/<store>
```

## Clean-room
Built from an architecture specification; no code is copied from any prior or proprietary engine.

## License
MIT — see [LICENSE](./LICENSE).
