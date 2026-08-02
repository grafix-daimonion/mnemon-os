// Entity Silo Test - Verifies scope isolation prevents cross-scope merging
// Tests the critical fix that prevents data leaks between different scopes

import { PGlite } from "@electric-sql/pglite";
import { resolveOrCreateEntity } from "../src/entity-resolution";

async function test() {
  const db = new PGlite();

  // Initialize schema
  await db.exec(`
    CREATE TABLE entities (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      scope_id BIGINT,
      merged_into BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE entity_aliases (
      id SERIAL PRIMARY KEY,
      entity_id BIGINT NOT NULL,
      alias TEXT NOT NULL,
      norm TEXT NOT NULL,
      scope_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX entity_aliases_norm_scope
      ON entity_aliases(scope_id, norm);
  `);

  // Create test scopes (projects/organizations)
  const scope1 = await db.query<{id: number}>(
    `INSERT INTO entities (type, label, scope_id)
     VALUES ('org', 'ProjectAlpha', NULL) RETURNING id`
  );
  const scopeId1 = scope1.rows[0].id;

  const scope2 = await db.query<{id: number}>(
    `INSERT INTO entities (type, label, scope_id)
     VALUES ('org', 'ProjectBeta', NULL) RETURNING id`
  );
  const scopeId2 = scope2.rows[0].id;

  // Test 1: Same name in different scopes must stay separate
  console.log("Test 1: Cross-scope isolation");
  const person1Scope1 = await resolveOrCreateEntity(db, "PersonA", "person", scopeId1);
  const person1Scope2 = await resolveOrCreateEntity(db, "PersonA", "person", scopeId2);

  if (person1Scope1.id === person1Scope2.id) {
    throw new Error("❌ FAIL: PersonA in different scopes merged (CRITICAL BUG)");
  }
  console.log("✓ PersonA in ProjectAlpha ≠ PersonA in ProjectBeta");

  // Test 2: Name variations within same scope should merge
  console.log("\nTest 2: Within-scope resolution");
  const person2a = await resolveOrCreateEntity(db, "PersonB", "person", scopeId1);
  const person2b = await resolveOrCreateEntity(db, "personb", "person", scopeId1); // lowercase

  if (person2a.id !== person2b.id) {
    throw new Error("❌ FAIL: PersonB variations in same scope didn't merge");
  }
  console.log("✓ PersonB variants merged within same scope");

  // Test 3: Resolve without scope (global entities)
  console.log("\nTest 3: Global entities");
  const global1 = await resolveOrCreateEntity(db, "GlobalEntity", "system", null);
  const global2 = await resolveOrCreateEntity(db, "GlobalEntity", "system", null);

  if (global1.id !== global2.id) {
    throw new Error("❌ FAIL: Global entities didn't merge");
  }
  console.log("✓ Global entities resolve correctly");

  // Test 4: Container lookup
  console.log("\nTest 4: Container entities");
  const container = await resolveOrCreateEntity(db, "ProjectAlpha", "org", null);

  if (container.id !== scopeId1) {
    throw new Error("❌ FAIL: Container entity not found");
  }
  console.log("✓ Container entities are accessible");

  // Test 5: Verify isolation with similar names
  console.log("\nTest 5: Similar names across scopes");
  const user1 = await resolveOrCreateEntity(db, "UserC Smith", "person", scopeId1);
  const user2 = await resolveOrCreateEntity(db, "UserC Jones", "person", scopeId2);

  if (user1.id === user2.id) {
    throw new Error("❌ FAIL: Similar names in different scopes merged");
  }
  console.log("✓ Similar names stay separate across scopes");

  console.log("\n✅ All entity silo tests passed!");
  console.log("The critical cross-scope merging bug has been fixed.");
}

// Run tests
test().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});