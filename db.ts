// db.ts — backend-agnostic store.
//
// Option B (Postgres) per MNEMON_OS_MEMORY_ARCHITECTURE_DECISION_v3 D1 + DECOUPLING_IMPL_SPEC_v2 §7.
//   MNEMON_PG_URL set   → connect via postgres.js to a PostgreSQL server (HNSW indexes build).
//   MNEMON_PG_URL unset → embedded PGLite (local-degrade / eval; HNSW silently skipped).
//
// Both paths run schema.sql statement-by-statement; a statement that the backend can't build
// (e.g. HNSW under PGLite) is skipped with a warning, not fatal — preserves the existing
// "degrade-friendly" boot behavior.

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import postgres from "postgres";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Thin backend-agnostic interface (O3 LOCKED: minimal — no query builder, no ORM).
 *
 * Shape matches PGLite's query() result so existing consumers
 *   (await db.query<T>(sql, params)).rows
 * keep compiling against either backend.
 */
export interface Db {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  /** Schema bootstrap path; consumers should prefer query(). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** PGLite adapter — passes through, since PGLite already exposes the right shape. */
class PGliteDb implements Db {
  constructor(private db: PGlite) {}
  async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
    return (await this.db.query<T>(sql, params)) as any;
  }
  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

/** postgres.js adapter — wraps sql.unsafe() into the PGLite-shaped result envelope. */
class PostgresDb implements Db {
  constructor(private sql: postgres.Sql) {}
  async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
    const rows = (await this.sql.unsafe<any>(sql, params)) as unknown as T[];
    return { rows };
  }
  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }
  async close(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Initialize the store + apply schema.
 *
 * @param dataDir Only used by the PGLite path; ignored when MNEMON_PG_URL is set.
 */
export async function initDb(dataDir?: string): Promise<Db> {
  const pgUrl = process.env.MNEMON_PG_URL;
  let db: Db;

  if (pgUrl) {
    // Option B: server Postgres + pgvector. HNSW indexes will build.
    const sql = postgres(pgUrl);
    db = new PostgresDb(sql);
  } else {
    // PGLite (retained as local-degrade / eval path).
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const pglite = new PGlite(
      dataDir ? { dataDir, extensions: { vector } } : { extensions: { vector } },
    );
    db = new PGliteDb(pglite);
  }

  // Schema bootstrap — same loop for both backends.
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
