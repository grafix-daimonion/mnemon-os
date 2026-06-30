// verify.ts — the L2 QA gate: cross-check an extracted fact against its source verbatim before it's
// trusted. "Verify, don't trust" — verified ≠ correct, but an unverified fact never drives the moat.
import { llmJSON } from "../llm.ts";
import { createHash } from "node:crypto";

// hash of the source span → cheap deterministic drift detection (re-hash later to confirm provenance
// still resolves). Borrowed from the provenance-aware tiered-memory work.
export const sourceHash = (s: string): string =>
  createHash("sha256").update((s ?? "").trim().toLowerCase()).digest("hex").slice(0, 16);

// SAME-ENTITY: a fuzzy/semantic candidate matched an existing node by spelling or meaning —
// confirm they denote the SAME real-world entity before merging. The guardrail on fuzzy's
// false positives ("Pythia" vs "Python"): the LLM proposes, this gate confirms. Conservative.
export async function sameEntity(
  incoming: string, candidate: string, account: string | null,
): Promise<{ ok: boolean; reason: string }> {
  const j = await llmJSON(
    `Two entity names from a memory system might refer to the SAME real-world thing — one may be a
typo, abbreviation, or reworded variant of the other — OR they may be genuinely different things
that merely look/sound alike. Return JSON {same: boolean, reason: string}.
Be CONSERVATIVE: only say same=true if you are confident they denote the same specific entity.
When unsure, say false — a wrong merge corrupts memory; a missed merge only duplicates it.

If one or both names carry a version suffix, apply this policy where it fits:
- people and organizations have NO versions: "Acme v2" is an artifact of "Acme" → same=true.
- projects/products/campaigns/specs DO have versions:
  - bare name and one of its versions ("Pythia" ↔ "Pythia v4") refer to the same overall thing → same=true.
  - two distinct version numbers of the same name ("Pythia v3" vs "Pythia v4") are different releases → same=false.
If the policy doesn't fit (no version suffix, or the case is ambiguous), judge by general identity.`,
    JSON.stringify({ name_a: incoming, name_b: candidate, account }));
  return { ok: !!j?.same, reason: String(j?.reason ?? "") };
}

// FAITHFULNESS: is the fact actually supported by the source text (true to it, not invented/distorted)?
export async function faithful(
  fact: { subject: string; predicate: string; object: string },
  sourceText: string,
  speaker?: string | null,
): Promise<{ ok: boolean; reason: string }> {
  const j = await llmJSON(
    `You verify a memory FACT against the SOURCE text it was extracted from. Return JSON
{supported: boolean, reason: string}.
- supported=true if the source reasonably states or implies the fact (paraphrase is fine).
- supported=false if the fact is invented, distorted, or about something the source doesn't say.
- The source is spoken BY the speaker named below. First-person words in the source — "I", "me",
  "my", "we", "our" — refer to that speaker. So a fact whose subject is the speaker's NAME is
  supported by a first-person source statement; do NOT reject it merely because the source writes
  "I" while the fact uses the speaker's name (they are the same person).
- REPORTED SPEECH: when the speaker reports what a THIRD PARTY said, thinks, did, or committed to
  ("Bob said X", "Alice now thinks Y", "they promised Z"), a fact whose subject is that third party
  IS supported by the source. The speaker reporting it is HOW the fact entered memory; do NOT reject
  a fact just because the speaker is relaying someone else's statement rather than asserting it
  first-hand. "Bob said the migration ships in Q2" supports {Bob, committed to, migration} and
  {migration, target date, Q2}.
Be fair, not pedantic — a faithful paraphrase counts as supported.`,
    JSON.stringify({ fact, speaker: speaker ?? null, source: sourceText }));
  return { ok: !!j?.supported, reason: String(j?.reason ?? "") };
}
