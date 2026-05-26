#!/usr/bin/env bash
# run-class1.sh — robust launcher for the Class-1 MCP server.
#
# Why: Claude Code's MCP spawn may not honour the `cwd` field in .mcp.json, so the
# subprocess can land with cwd != mnemon-os/. llm.ts loads ANTHROPIC_API_KEY from
# either process.env or .env in process.cwd() — without one of those it crashes at
# module-load. This wrapper sources mnemon-os/.env explicitly before exec'ing the
# server, regardless of caller cwd. Keeps the key in one place (mnemon-os/.env,
# chmod 600) — never inlined into any per-project .mcp.json.
#
# Usage in .mcp.json:
#   { "command": "/ABS/PATH/mnemon-os/run-class1.sh",
#     "env": { "MNEMON_DATA": "/ABS/PATH/your-store" } }
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
exec bun run "$HERE/mcp-server.ts" "$@"
