// persona.ts — the GDPR gate for four-lens persona/feedback extraction.
//
// Persona extraction profiles individuals (how they think, their preferences, the feedback that
// calibrates an AI), so it ships in the repo but DORMANT: enabled only when MNEMON_PERSONA_EXTRACTION
// is explicitly truthy. Default OFF. Shared by extract.ts (prompt gating + output filter) and
// pipeline.ts (defense-in-depth drop) — a tiny standalone module so neither can be mocked out from
// under the other.

export function personaExtractionEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.MNEMON_PERSONA_EXTRACTION ?? "").trim());
}

// A persona/feedback predicate: the four lenses (behavior|relationship|design|philosophy: …),
// directives, and the calibration-feedback verbs. With persona off, these are never captured.
export function isPersonaPredicate(predicate: string): boolean {
  const p = (predicate ?? "").toLowerCase().trim();
  return /^(behavior|relationship|design|philosophy|directive):/.test(p)
    || ["received_correction", "erred", "hallucinated", "praised"].includes(p);
}
