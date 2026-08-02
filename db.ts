// db.ts — embedded Postgres (PGLite), so Phase 0 runs with no server.
// Applies schema.sql statement-by-statement; a statement that PGLite can't build
// (e.g. an HNSW index — unused in Phase 0) is skipped with a warning, not fatal.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initDb(dataDir?: string): Promise<PGlite> {
  // dataDir => file-backed persistence (survives between runs); omit => in-memory (eval).
  if (dataDir) mkdirSync(dataDir, { recursive: true }); // PGLite's NodeFS won't create parents
  const db = new PGlite(dataDir ? { dataDir, extensions: { vector } } : { extensions: { vector } });
  const raw = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const sql = raw.replace(/--[^\n]*\n/g, "\n"); // strip line comments
  const stmts = sql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) {
    try {
      await db.exec(s);
    } catch (e: any) {
      console.warn(`  (schema) skipped: ${s.slice(0, 48).replace(/\s+/g, " ")}… — ${e.message}`);
    }
  }
  return db;
}
