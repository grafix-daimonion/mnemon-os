// transcript-claude.ts — adapt a Claude Code (.jsonl) session transcript into Mnemon's
// simple [{speaker, time, text}] shape, so the tested ingest path can consume it.
//
//   bun run transcript-claude.ts <session.jsonl> [--out FILE] [--limit N] [--dry]
//                                [--ct NAME] [--ai NAME]
//
// A Claude Code transcript records EVERYTHING (tool_use, tool_result, attachments,
// file snapshots, system reminders). We keep only the human/AI PROSE: text blocks of
// `user` and `assistant` records, with injected wrappers stripped. Order is preserved
// (the file is already oldest->newest); the ingester re-sorts by timestamp anyway.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (k: string, d: string | null = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k: string) => args.includes(`--${k}`);
if (!file) { console.error("usage: bun run transcript-claude.ts <session.jsonl> [--out FILE] [--limit N] [--dry]"); process.exit(1); }

const CT = flag("ct", "CT")!;
const AI = flag("ai", "Pythia")!;
const limit = flag("limit") ? parseInt(flag("limit")!, 10) : Infinity;

// Strip the wrappers Claude Code injects into message content — they are harness
// machinery, not anything the human or AI actually said.
function clean(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<bash-(input|stdout|stderr)>[\s\S]*?<\/bash-\1>/g, "")
    .replace(/^Caveat:.*$/gm, "")
    .trim();
}

// Pull only the spoken prose: text blocks (skip tool_use / tool_result / thinking).
function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
  return "";
}

const turns: { speaker: string; time: string; text: string }[] = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let o: any; try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== "user" && o.type !== "assistant") continue;
  const m = o.message; if (!m) continue;
  const text = clean(textOf(m.content));
  if (!text) continue;
  turns.push({ speaker: o.type === "user" ? CT : AI, time: o.timestamp, text });
  if (turns.length >= limit) break;
}

const chars = turns.reduce((n, t) => n + t.text.length, 0);
const span = turns.length ? `${turns[0].time} .. ${turns[turns.length - 1].time}` : "—";
console.error(`turns=${turns.length}  chars=${chars} (~${Math.round(chars / 4)} tok)  span ${span}`);

if (has("dry")) {
  for (const t of turns.slice(0, 8)) console.error(`  ${t.time.slice(0, 16)} ${t.speaker.padEnd(6)} ${t.text.slice(0, 88).replace(/\s+/g, " ")}`);
} else {
  const out = flag("out", "./data/normalized.json")!;
  writeFileSync(out, JSON.stringify(turns, null, 1));
  console.error(`wrote ${turns.length} turns -> ${out}`);
}
