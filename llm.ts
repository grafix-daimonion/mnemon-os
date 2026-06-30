// llm.ts — the judge/extraction model, behind a thin interface.
// Reads ANTHROPIC_API_KEY from the environment (or a local, git-ignored .env).
// SWAP POINT: replace llmJSON's body with a local model (ollama, etc.) — nothing
// else in the codebase changes. The key is read at runtime, never logged.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./logger.ts";

function loadKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try {
    const txt = readFileSync(join(process.cwd(), ".env"), "utf8");
    const m = txt.match(/^ANTHROPIC_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* no local .env */ }
  throw new Error("ANTHROPIC_API_KEY not set (export it, or put it in a local .env).");
}

// Lazily constructed: paths that never call the LLM (Class-2 host-as-brain, pure
// entity-resolution) must not require ANTHROPIC_API_KEY just to import this module.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  return (_client ??= new Anthropic({ apiKey: loadKey() }));
}
// MNEMON_LLM_MODEL — per-install opt-in to a different Anthropic model (e.g. claude-sonnet-4-6).
// Default: Haiku 4.5 (small + fast + cheap). For installs where extraction recall on
// dense / multi-claim content matters (Betty), set MNEMON_LLM_MODEL=claude-sonnet-4-6.
// See ENGINE_SPEC_v5 §16.
const MODEL = process.env.MNEMON_LLM_MODEL?.trim() || "claude-haiku-4-5-20251001";

export async function llmJSON(system: string, user: string): Promise<any> {
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Salvage a JSON object embedded in prose; if even that won't parse (e.g. a max_tokens
    // truncation left it unbalanced), DEGRADE — return null rather than throw. Every caller
    // guards with `j?.x`, so a bad response becomes "no answer", never an engine crash. A
    // throw here would abort a whole ingest/recall on one malformed model reply.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    logEvent("llm.unparseable_json", { preview: cleaned.slice(0, 200) });
    return null;
  }
}
