-- Entity Silo Migration - Prevents cross-scope data mixing
-- This fixes the critical bug where entities from different scopes could merge
-- Original issue: Entities were globally resolved, causing data leaks between scopes

-- Add scope isolation to all tables
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS scope_id BIGINT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS scope_id BIGINT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS scope_id BIGINT;
ALTER TABLE entity_aliases ADD COLUMN IF NOT EXISTS scope_id BIGINT;
ALTER TABLE doc_index ADD COLUMN IF NOT EXISTS scope_id BIGINT;

-- Add merged_into for entity consolidation
ALTER TABLE entities ADD COLUMN IF NOT EXISTS merged_into BIGINT REFERENCES entities(id);

-- Create scope-based indexes for performance
CREATE INDEX IF NOT EXISTS interactions_scope ON interactions(scope_id);
CREATE INDEX IF NOT EXISTS entities_scope ON entities(scope_id);
CREATE INDEX IF NOT EXISTS chunks_scope ON chunks(scope_id);
CREATE INDEX IF NOT EXISTS doc_index_scope ON doc_index(scope_id);

-- Scope-based unique constraints
DROP INDEX IF EXISTS entity_aliases_norm_key;
CREATE UNIQUE INDEX IF NOT EXISTS entity_aliases_norm_scope
  ON entity_aliases(scope_id, norm)
  WHERE scope_id IS NOT NULL;

DROP INDEX IF EXISTS doc_index_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS doc_index_scope_slug
  ON doc_index(scope_id, slug)
  WHERE scope_id IS NOT NULL;

-- Comments explaining the container model
COMMENT ON COLUMN entities.scope_id IS
  'Scope container - entities with scope_id=NULL are containers (projects/orgs),
   entities with scope_id=N belong to that container.
   This prevents cross-scope entity merging.';

COMMENT ON COLUMN interactions.scope_id IS
  'Scope isolation - all interactions are scoped to prevent data leaks';