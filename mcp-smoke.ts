// mcp-smoke.ts — connect to mcp-server.ts the SAME way Claude Code does (spawn + stdio),
// list tools, then exercise remember + recall. Proves the MCP connection end-to-end.
//   set ANTHROPIC_API_KEY in the environment, then: bun run mcp-smoke.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", join(import.meta.dir, "mcp-server.ts")],
  cwd: import.meta.dir,
  env: { ...process.env, MNEMON_DATA: join(import.meta.dir, "data", "_smoke") } as Record<string, string>,
});

const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const r1 = await client.callTool({ name: "remember", arguments: { text: "Acme's contract renewal is in November." } });
console.log("remember →", (r1.content as any)[0].text);

const r2 = await client.callTool({ name: "recall", arguments: { question: "When is Acme's contract renewal?" } });
console.log("recall   →", (r2.content as any)[0].text);

await client.close();
process.exit(0);
