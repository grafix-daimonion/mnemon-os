// synapsis/fuzzy.ts — lexical fuzzy matching for entity resolution (the typo catcher).
//
// Optimal String Alignment (restricted Damerau-Levenshtein): edit distance where an
// ADJACENT transposition counts as ONE edit, not two — so "Daimonion" → "Daiamnion"
// (swap + a wrong letter) is distance ~2, not ~4. This is the right tool for spelling
// slips; semantic variants ("the daimonion project") are a separate axis (embeddings).
//
// Pure + deterministic + dependency-free → behaves identically on PGLite and Postgres,
// and is unit-testable without a database.

export function osaDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,        // deletion
        d[i][j - 1] + 1,        // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
    }
  }
  return d[m][n];
}

// Normalized comparison key: identity is the NAME, not its casing/spacing/punctuation.
export function normLabel(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")             // collapse internal whitespace
    .replace(/^["'`«»]+|["'`«».,;:!?]+$/g, "") // strip wrapping quotes / trailing punctuation
    .toLowerCase();
}

// How many edits we tolerate before two names are even *candidates* to be the same.
// Scales with length: ~1 edit per 4 chars, so long names absorb typos but short ones
// stay strict ("Pythia" vs "Python" — distance 2, cap 1 — never auto-considered).
export function fuzzyCap(a: string, b: string): number {
  return Math.floor(Math.max(a.length, b.length) / 4);
}

// ─── Version-aware identity (the policy that lands deterministically; ambiguous
//     cases fall through to fuzzy+QA, where the LLM reasons WITH this same rule
//     in its prompt — the "code owns the track, LLM has freedom within" principle).

// Detect a trailing version suffix — separator-required so plain words starting with "v"
// (e.g. "Vortex") don't false-match. Returns {base, version} or null.
const VERSION_RX = /[\s_\-]+v(\d+(?:\.\d+)*)\s*$/i;

export function parseVersion(label: string): { base: string; version: string } | null {
  const s = (label ?? "").trim();
  const m = s.match(VERSION_RX);
  if (!m) return null;
  return { base: s.slice(0, m.index!).trim(), version: m[1] };
}

const PERSON_LIKE = new Set(["person", "org"]);

// The deterministic core of the versions policy. Returns a clear verdict when the
// case fits the rule; otherwise "undecided" → caller falls through to fuzzy+QA.
//   merge      = same thing (umbrella absorbs instance, or person/org artifact)
//   distinct   = different things (two distinct version numbers of the same project)
//   undecided  = not a clear version case → let other layers / the LLM decide
export function versionVerdict(
  incomingLabel: string, candidateLabel: string,
  incomingType: string, candidateType: string,
): "merge" | "distinct" | "undecided" {
  const iv = parseVersion(incomingLabel);
  const cv = parseVersion(candidateLabel);
  if (!iv && !cv) return "undecided";        // neither versioned — not this layer's job
  const iBase = (iv?.base ?? incomingLabel).toLowerCase().trim();
  const cBase = (cv?.base ?? candidateLabel).toLowerCase().trim();
  if (iBase !== cBase) return "undecided";   // different bases — version difference irrelevant
  if (PERSON_LIKE.has(incomingType) || PERSON_LIKE.has(candidateType))
    return "merge";                           // people/orgs can't have versions → artifact
  if (iv && cv && iv.version !== cv.version)
    return "distinct";                        // two distinct versions of the same project
  return "merge";                             // bare ↔ versioned: umbrella absorbs instance
}
