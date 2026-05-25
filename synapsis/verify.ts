// verify.ts — the L2 QA gate: cross-check an extracted fact against its source verbatim before it's
// trusted. "Verify, don't trust" — verified ≠ correct, but an unverified fact never drives the moat.
import { llmJSON } from "../llm.ts";
import { createHash } from "node:crypto";

// hash of the source span → cheap deterministic drift detection (re-hash later to confirm provenance
// still resolves). Borrowed from the provenance-aware tiered-memory work.
export const sourceHash = (s: string): string =>
  createHash("sha256").update((s ?? "").trim().toLowerCase()).digest("hex").slice(0, 16);

// FAITHFULNESS: is the fact actually supported by the source text (true to it, not invented/distorted)?
export async function faithful(
  fact: { subject: string; predicate: string; object: string },
  sourceText: string,
): Promise<{ ok: boolean; reason: string }> {
  const j = await llmJSON(
    `You verify a memory FACT against the SOURCE text it was extracted from. Return JSON
{supported: boolean, reason: string}.
- supported=true if the source reasonably states or implies the fact (paraphrase is fine).
- supported=false if the fact is invented, distorted, or about something the source doesn't say.
Be fair, not pedantic — a faithful paraphrase counts as supported.`,
    JSON.stringify({ fact, source: sourceText }));
  return { ok: !!j?.supported, reason: String(j?.reason ?? "") };
}
