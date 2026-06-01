// entity-class2.ts — Class-2 entity resolution: server provides DETERMINISTIC SIGNALS
// (exact-match / alias / fuzzy distance / version-verdict); the HOST decides same-or-not
// and calls back with the resolution. The same identity-by-label + Damerau-Levenshtein +
// versions-policy primitives Class 1 uses, but split into "find" (advisory) and "resolve"
// (apply). No LLM here; no automatic owner edges (the host explicitly assert_fact()s).
//
// Verbs exposed:
//   findEntity(label, type?)                                  → {exact_id?, alias_id?, near_matches}
//   resolveOrCreateEntity(label, type, owner_id?, decision?)  → {entity_id, created}
import type { Db } from "./db";
import { normLabel, osaDistance, fuzzyCap, versionVerdict } from "./synapsis/fuzzy.ts";
import { logEvent } from "./logger.ts";

const INDEPENDENT = new Set(["person", "org"]);

export interface NearMatch {
  id: number;
  label: string;
  type: string;
  distance: number | null;
  version_verdict: "merge" | "distinct" | "undecided";
}
export interface FindResult { exact_id?: number; alias_id?: number; near_matches: NearMatch[]; }

export async function findEntity(db: Db, label: string, type?: string): Promise<FindResult> {
  const display = String(label).trim();
  const norm = normLabel(display);
  const t = (type ?? "thing").trim();

  // 1. exact normalized match — identity = label, decoupled from type.
  const ents = (await db.query<{ id: number; label: string; type: string }>(`select id, label, type from entities`)).rows;
  const exact = ents.find((e) => normLabel(e.label) === norm);
  if (exact) { logEvent("class2.find_entity", { label: display, hit: "exact", id: exact.id }); return { exact_id: exact.id, near_matches: [] }; }

  // 2. remembered alias (previously confirmed variant).
  const al = await db.query<{ entity_id: number }>(`select entity_id from entity_aliases where norm = $1 limit 1`, [norm]);
  if (al.rows.length) { logEvent("class2.find_entity", { label: display, hit: "alias", id: al.rows[0].entity_id }); return { alias_id: al.rows[0].entity_id, near_matches: [] }; }

  // 3. near matches — fuzzy distance + version verdict (advisory; host decides).
  const near_matches: NearMatch[] = [];
  for (const e of ents) {
    const en = normLabel(e.label);
    const cap = fuzzyCap(norm, en);
    const d = cap >= 1 ? osaDistance(norm, en) : Infinity;
    const v = versionVerdict(display, e.label, t, e.type);
    if ((Number.isFinite(d) && d >= 1 && d <= cap) || v !== "undecided") {
      near_matches.push({ id: e.id, label: e.label, type: e.type, distance: Number.isFinite(d) ? (d as number) : null, version_verdict: v });
    }
  }
  near_matches.sort((a, b) => {
    const ad = a.distance ?? 999, bd = b.distance ?? 999;
    if (ad !== bd) return ad - bd;
    return (a.version_verdict === "merge" ? 0 : 1) - (b.version_verdict === "merge" ? 0 : 1);
  });
  logEvent("class2.find_entity", { label: display, hit: "near_matches", count: near_matches.length });
  return { near_matches };
}

export type OwnerDecision =
  | { kind: "reuse"; entity_id: number }
  | { kind: "merge_alias"; entity_id: number }
  | { kind: "create" };

export interface ResolveInput {
  label: string;
  type: string;
  owner_id?: number | null;        // accepted for forward compat; not used (host owns ownership edges)
  owner_decision?: OwnerDecision;
}

export async function resolveOrCreateEntity(
  db: Db, req: ResolveInput,
): Promise<{ entity_id: number; created: boolean }> {
  const display = String(req.label).trim();
  const norm = normLabel(display);
  const t = (req.type || "thing").trim();
  const decision: OwnerDecision = req.owner_decision ?? { kind: "create" };

  if (decision.kind === "reuse") {
    logEvent("class2.resolve_or_create_entity", { label: display, decision: "reuse", entity_id: decision.entity_id });
    return { entity_id: decision.entity_id, created: false };
  }
  if (decision.kind === "merge_alias") {
    await db.query(
      `insert into entity_aliases (entity_id, alias, norm) values ($1, $2, $3) on conflict (norm) do nothing`,
      [decision.entity_id, display, norm],
    );
    // type promotion: never demote a known specific type back to "thing"
    const cur = await db.query<{ type: string }>(`select type from entities where id=$1`, [decision.entity_id]);
    if (cur.rows.length && t !== "thing" && (cur.rows[0].type === "thing" || !cur.rows[0].type)) {
      await db.query(`update entities set type=$1 where id=$2`, [t, decision.entity_id]);
    }
    logEvent("class2.resolve_or_create_entity", { label: display, decision: "merge_alias", entity_id: decision.entity_id });
    return { entity_id: decision.entity_id, created: false };
  }
  // create — independent (person/org) or genuinely new dependent.
  // NOTE: unlike Class 1, NO automatic 'has' owner edge is minted. The host explicitly
  // calls assert_fact() to record any ownership relation — keeps Class 2 LLM-free + explicit.
  void INDEPENDENT;
  const childId = (await db.query<{ id: number }>(
    `insert into entities (type, label) values ($1, $2) returning id`, [t, display],
  )).rows[0].id;
  logEvent("class2.resolve_or_create_entity", { label: display, decision: "create", entity_id: childId, owner_id: req.owner_id ?? null });
  return { entity_id: childId, created: true };
}
