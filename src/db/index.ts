/**
 * Database connection — Drizzle ORM + better-sqlite3
 *
 * Using SQLite for the MVP. Can swap to PostgreSQL (Supabase)
 * by changing the driver import and connection string.
 *
 * Production pragmas:
 *  - WAL mode for concurrent reads
 *  - foreign_keys enforced
 *  - busy_timeout to retry on SQLITE_BUSY instead of throwing
 *  - synchronous=NORMAL for safe WAL writes with better perf
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import config from "../config.js";
import * as schema from "./schema.js";

// Strip the "file:" prefix if present (better-sqlite3 expects a path)
const dbPath = config.DATABASE_URL.replace(/^file:/, "");

const sqlite = new Database(dbPath);

// Production-grade SQLite pragmas
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");   // 5s retry on SQLITE_BUSY
sqlite.pragma("synchronous = NORMAL");  // safe with WAL, 2x faster than FULL

export const db = drizzle(sqlite, { schema });

// Auto-migrate on startup — creates tables if they don't exist.
// Uses the generated SQL files in /drizzle (copied into Docker image).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = resolve(__dirname, "..", "..", "drizzle");

try {
  migrate(db, { migrationsFolder });
} catch (err) {
  console.error("❌ Database migration failed:", err);
  process.exit(1);
}

/** Close the underlying SQLite connection. Call during graceful shutdown. */
export function closeDatabase(): void {
  sqlite.close();
}

export type Database = typeof db;
export default db;
