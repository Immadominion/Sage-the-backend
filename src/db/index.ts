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
import Database from "better-sqlite3";
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

/** Close the underlying SQLite connection. Call during graceful shutdown. */
export function closeDatabase(): void {
  sqlite.close();
}

export type Database = typeof db;
export default db;
