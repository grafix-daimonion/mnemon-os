// Entity Resolution with Scope Isolation
// Fixes critical bug where entities from different scopes could merge
// This implementation ensures complete data isolation between scopes

import type { PGlite } from "@electric-sql/pglite";

export interface Entity {
  id: number;
  type: string;
  label: string;
  scope_id: number | null;
  merged_into: number | null;
}

// Container model: scope_id=NULL entities are containers (projects/orgs)
// Contained entities have scope_id pointing to their container
export async function resolveOrCreateEntity(
  db: PGlite,
  label: string,
  type: string,
  scopeId: number | null = null
): Promise<Entity> {
  const normalized = normalizeLabel(label);

  // CRITICAL: Scope-based resolution prevents cross-scope merging
  // Only search within the same scope or the scope container itself
  const candidates = await db.query<Entity>(
    `SELECT * FROM entities
     WHERE (scope_id IS NOT DISTINCT FROM $1) OR (id = $1)
       AND merged_into IS NULL
     ORDER BY created_at DESC`,
    [scopeId]
  );

  // Layer 1: Exact normalized match within scope
  const exactMatch = candidates.rows.find(
    e => normalizeLabel(e.label) === normalized
  );
  if (exactMatch) return exactMatch;

  // Layer 2: Check known aliases within scope
  const aliasMatch = await db.query<Entity>(
    `SELECT e.* FROM entities e
     JOIN entity_aliases a ON e.id = a.entity_id
     WHERE a.scope_id IS NOT DISTINCT FROM $1
       AND a.norm = $2
       AND e.merged_into IS NULL`,
    [scopeId, normalized]
  );
  if (aliasMatch.rows[0]) return aliasMatch.rows[0];

  // Layer 3: Fuzzy matching within scope (for typos)
  for (const candidate of candidates.rows) {
    if (isFuzzyMatch(label, candidate.label, type)) {
      // LLM verification could go here
      // For now, simple distance check
      await rememberAlias(db, candidate.id, label, scopeId);
      return candidate;
    }
  }

  // Layer 4: Create new entity in this scope
  const newEntity = await db.query<Entity>(
    `INSERT INTO entities (type, label, scope_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [type, label, scopeId]
  );

  return newEntity.rows[0];
}

// Remember an alias for future resolution
async function rememberAlias(
  db: PGlite,
  entityId: number,
  alias: string,
  scopeId: number | null
): Promise<void> {
  const normalized = normalizeLabel(alias);
  await db.query(
    `INSERT INTO entity_aliases (entity_id, alias, norm, scope_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope_id, norm) DO NOTHING`,
    [entityId, alias, normalized, scopeId]
  );
}

// Normalize labels for comparison
export function normalizeLabel(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`«»]+|["'`«».,;:!?]+$/g, "")
    .toLowerCase();
}

// Simple fuzzy matching (can be enhanced with Damerau-Levenshtein)
function isFuzzyMatch(a: string, b: string, type: string): boolean {
  const normA = normalizeLabel(a);
  const normB = normalizeLabel(b);

  // Exact match after normalization
  if (normA === normB) return true;

  // Token subset matching for person names
  if (type === "person") {
    const tokensA = normA.split(" ");
    const tokensB = normB.split(" ");

    // "john" matches "john smith"
    if (tokensA.every(t => tokensB.includes(t)) ||
        tokensB.every(t => tokensA.includes(t))) {
      return true;
    }
  }

  return false;
}

// Find entities by type within scope
export async function findEntitiesByType(
  db: PGlite,
  type: string,
  scopeId: number | null = null
): Promise<Entity[]> {
  const result = await db.query<Entity>(
    `SELECT * FROM entities
     WHERE type = $1
       AND scope_id IS NOT DISTINCT FROM $2
       AND merged_into IS NULL
     ORDER BY label`,
    [type, scopeId]
  );

  return result.rows;
}

// Merge entities (for deduplication within scope)
export async function mergeEntities(
  db: PGlite,
  keepId: number,
  mergeId: number
): Promise<void> {
  // Verify both entities are in same scope
  const check = await db.query<{same_scope: boolean}>(
    `SELECT (e1.scope_id IS NOT DISTINCT FROM e2.scope_id) as same_scope
     FROM entities e1, entities e2
     WHERE e1.id = $1 AND e2.id = $2`,
    [keepId, mergeId]
  );

  if (!check.rows[0]?.same_scope) {
    throw new Error("Cannot merge entities from different scopes");
  }

  // Update references
  await db.query("UPDATE facts SET subject_id = $1 WHERE subject_id = $2", [keepId, mergeId]);
  await db.query("UPDATE facts SET object_entity_id = $1 WHERE object_entity_id = $2", [keepId, mergeId]);
  await db.query("UPDATE entity_aliases SET entity_id = $1 WHERE entity_id = $2", [keepId, mergeId]);

  // Mark as merged
  await db.query("UPDATE entities SET merged_into = $1 WHERE id = $2", [keepId, mergeId]);
}