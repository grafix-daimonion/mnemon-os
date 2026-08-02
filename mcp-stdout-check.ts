// mcp-stdout-check.ts — verify the local embedder doesn't pollute stdout.
// MCP servers communicate JSON-RPC over stdin/stdout — ANY stray stdout output
// corrupts the channel. transformers.js famously logs model-load progress; we
// must confirm it stays off stdout (or fix it) before connecting to Claude Code.
//
// Usage:  bun run mcp-stdout-check.ts > /tmp/mcp-stdout 2> /tmp/mcp-stderr
//         test -s /tmp/mcp-stdout && echo "DIRTY" || echo "CLEAN"
// The script writes its OWN signals to stderr; if anything lands on stdout,
// that's a leak from the embedder (or its deps) and must be fixed.
import { embed } from "./embed.ts";

console.error("[check] importing embedder + embedding a string (cold load) ...");
const v = await embed("the quick brown fox jumps over the lazy dog");
console.error(`[check] embed ok — dim=${v.length}`);
console.error("[check] embedding again (cached load) ...");
const v2 = await embed("a second string");
console.error(`[check] embed ok — dim=${v2.length}`);
console.error("[check] DONE.");
