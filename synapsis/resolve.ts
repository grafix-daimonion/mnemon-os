// Mnemon_OS — Synapsis: contradiction -> current-state
// Clean-room. The bi-temporal heart: when a new fact arrives, decide which existing
// open facts it SUPERSEDES, so `recall` returns current state and `recall_as_of`
// returns the prior state.
//
// Design (agreed with CT): deterministic guards reject the easy cases for free;
// a small LLM judges only the survivors — "same topic, and is the new value a
// reversal?" — and its reasoning is logged so every supersession stays explainable.
import { llmJSON } from "../llm.ts";

export interface Fact {
  id: number;
  subjectId: number;
  subjectLabel: string;
  predicate: string; // the topic/slot, stance-free
  object: string;    // the current value/stance
  shape: "single" | "multi";
  validFrom: string; // ISO timestamp (= source interaction's occurred_at)
}

export interface Verdict {
  contradicts: boolean;
  reason: string;
}

/**
 * Does `incoming` cancel `existing` (an OPEN fact for the same subject)?
 * If true, the caller closes `existing` (valid_until = incoming.validFrom,
 * superseded_by = incoming.id), leaving `incoming` as the new current fact.
 */
export async function contradicts(incoming: Fact, existing: Fact): Promise<Verdict> {
  // Guard 1 — shape: only single-valued slots get replaced; multi-valued accumulate.
  if (incoming.shape !== "single" || existing.shape !== "single")
    return { contradicts: false, reason: "multi-valued shape accumulates; no supersession" };

  // Guard 2 — direction: newer supersedes older, never the reverse.
  if (new Date(incoming.validFrom) <= new Date(existing.validFrom))
    return { contradicts: false, reason: "incoming is not newer than existing" };

  // Guard 3 — identical value is a re-confirmation, not a reversal.
  if (incoming.object.trim().toLowerCase() === existing.object.trim().toLowerCase())
    return { contradicts: false, reason: "same value: re-confirmation, not a reversal" };

  // The judgment call — same topic worded differently? real reversal? (small LLM)
  const j = await llmJSON(
    `You judge whether a NEW fact replaces an OLD fact in a memory system. Both are about the
same subject. Return JSON {same_topic: boolean, is_reversal: boolean, reason: string}.
- same_topic: do both concern the SAME thing/commitment, even if worded differently?
- is_reversal: does the new value change/replace the old answer (vs. an unrelated fact)?`,
    JSON.stringify({
      subject: incoming.subjectLabel,
      old: { topic: existing.predicate, value: existing.object },
      new: { topic: incoming.predicate, value: incoming.object },
    }));

  const verdict = !!(j?.same_topic && j?.is_reversal);
  return {
    contradicts: verdict,
    reason: `judge: same_topic=${j?.same_topic} is_reversal=${j?.is_reversal} — ${j?.reason ?? ""}`,
  };
}
