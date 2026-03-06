/**
 * Database connection — Drizzle ORM + PostgreSQL (node-postgres)
 *
 * Production-grade setup:
 *  - Connection pooling via pg.Pool
 *  - Auto-migration on startup (Drizzle migrator)
 *  - Graceful shutdown with pool.end()
 *  - SSL support for Railway/cloud providers
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import config from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,                 // max connections in pool
  idleTimeoutMillis: 30000, // close idle clients after 30s
  connectionTimeoutMillis: 5000, // fail fast if can't connect
  // Railway/cloud providers typically need SSL
  ssl: config.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : undefined,
});

export const db = drizzle(pool, { schema });

/**
 * Run Drizzle migrations on startup.
 * Must be called (and awaited) before the server starts accepting requests.
 */
export async function runMigrations(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const migrationsFolder = resolve(__dirname, "..", "..", "drizzle");

  try {
    await migrate(db, { migrationsFolder });
    console.log("✅ Database migrations applied successfully");
  } catch (err: unknown) {
    // Check the full error chain (DrizzleQueryError wraps pg errors in .cause)
    const fullText = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
    const causeText = (err as any)?.cause?.message ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    const combined = `${msg} ${causeText} ${fullText}`;

    if (combined.includes("already exists") || combined.includes("already been applied")) {
      console.log("ℹ️  Database schema up to date — skipping migration");
    } else {
      console.error("❌ Database migration failed:", err);
      process.exit(1);
    }
  }
}

/** Close the connection pool. Call during graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export type Database = typeof db;
export default db;
