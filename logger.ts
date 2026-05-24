// logger.ts — the decision log: a durable, reviewable trail of what the LLM decided.
// This is the QA substrate. Every extraction (note -> facts) and every contradiction
// judgment (with the model's reasoning) is appended as one JSON line. It never throws:
// logging must not be able to break the pipeline.
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "logs");
export const logPath = join(dir, "decisions.jsonl");

export function logEvent(type: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
  } catch {
    /* logging must never break the pipeline */
  }
}
