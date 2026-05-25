// chunk.ts — split a verbatim turn into L0 retrieval units.
// Turn-aware first (blank lines / "Speaker:" boundaries), then a fixed ~800-char / ~100-overlap
// window for anything still long (sentence-boundary preferred). A short save → one chunk.
// (Fixed-window ~800/100 is the MemPalace-proven default; turn-awareness keeps a fact from being
//  cut across speakers — see ENGINE_SPEC_v2 §8.)
const MAX = 800;     // target chars per chunk
const OVERLAP = 100; // overlap between windowed pieces of a long turn

export function chunkText(content: string): string[] {
  const text = (content ?? "").trim();
  if (!text) return [];
  if (text.length <= MAX) return [text]; // short save = one chunk (the common case)

  // turn-aware: split on blank lines or "Speaker:" line starts
  const turns = text
    .split(/\n{2,}|\n(?=[A-Z][\w .'\-]{0,40}:\s)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const turn of turns) {
    if (turn.length <= MAX) { out.push(turn); continue; }
    // window a long turn, preferring a sentence boundary inside the window
    let i = 0;
    while (i < turn.length) {
      let end = Math.min(i + MAX, turn.length);
      if (end < turn.length) {
        const dot = turn.lastIndexOf(". ", end);
        if (dot > i + MAX / 2) end = dot + 1;
      }
      const piece = turn.slice(i, end).trim();
      if (piece) out.push(piece);
      if (end >= turn.length) break;
      i = end - OVERLAP; // overlap so a fact isn't split at a hard boundary
    }
  }
  return out.filter(Boolean);
}
