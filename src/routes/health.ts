/**
 * Health check route.
 *
 * Checks: Solana RPC connectivity, SQLite database, ML prediction service.
 * Returns 200 if all healthy, 503 if any degraded.
 */

import { Hono } from "hono";
import { getConnection, SENTINEL_PROGRAM_ID } from "../services/solana.js";
import config from "../config.js";
import db from "../db/index.js";
import { users } from "../db/schema.js";
import { sql } from "drizzle-orm";

const health = new Hono();

/** Server start time for uptime reporting */
const startTime = Date.now();

health.get("/", async (c) => {
  const checks: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.2.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    environment: config.NODE_ENV,
    network: config.SOLANA_NETWORK,
    programId: SENTINEL_PROGRAM_ID.toBase58(),
  };

  // Solana RPC check
  try {
    const connection = getConnection();
    const slotPromise = connection.getSlot();
    // Timeout the RPC check at 5 seconds
    const slot = await Promise.race([
      slotPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC timeout (5s)")), 5000)
      ),
    ]);
    checks.solanaSlot = slot;
    checks.solana = "connected";
  } catch (err) {
    checks.solana = "error";
    checks.solanaError =
      err instanceof Error ? err.message : "Unknown error";
    checks.status = "degraded";
  }

  // Database check
  try {
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .get();
    checks.database = "connected";
    checks.userCount = result?.count ?? 0;
  } catch (err) {
    checks.database = "error";
    checks.databaseError =
      err instanceof Error ? err.message : "Unknown error";
    checks.status = "degraded";
  }

  // ML service check
  try {
    const mlUrl = config.ML_SERVICE_URL ?? "http://127.0.0.1:8100";
    const controller = new AbortController();
    const mlTimeout = setTimeout(() => controller.abort(), 3000);
    const mlResponse = await fetch(`${mlUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(mlTimeout);

    if (mlResponse.ok) {
      const mlData = (await mlResponse.json()) as {
        model?: string;
        version?: string;
      };
      checks.mlService = "connected";
      checks.mlModel = mlData.model ?? "unknown";
    } else {
      checks.mlService = "error";
      checks.mlError = `HTTP ${mlResponse.status}`;
      // ML is optional — mark as degraded, not down
      if (checks.status === "ok") checks.status = "degraded";
    }
  } catch (err) {
    checks.mlService = "unreachable";
    checks.mlError =
      err instanceof Error ? err.message : "Unknown error";
    // ML is optional — app can still function without it
    if (checks.status === "ok") checks.status = "degraded";
  }

  const statusCode = checks.status === "ok" ? 200 : 503;
  return c.json(checks, statusCode as 200);
});

export default health;
