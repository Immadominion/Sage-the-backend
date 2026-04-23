/**
 * Redis client (singleton, lazy).
 *
 * Powered by ioredis. Used today by the rate-limit middleware (rate-limit-redis
 * store). When `REDIS_URL` is unset (e.g. local dev), `getRedis()` returns null
 * and callers fall back to in-process state.
 *
 * Connection strategy:
 *  - Lazy connect on first call so cold-start failures don't crash the boot.
 *  - `enableOfflineQueue: false` — fail fast if Redis is down rather than
 *    silently buffering and exhausting memory.
 *  - Exponential reconnect backoff capped at 5s.
 */

import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../middleware/logger.js";

let client: Redis | null = null;
let logged = false;

export function getRedis(): Redis | null {
  if (!config.REDIS_URL) return null;
  if (client) return client;

  client = new Redis(config.REDIS_URL, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  });

  client.on("error", (err: Error) => {
    // Log first error per process; subsequent failures are noisy.
    if (!logged) {
      logger.warn({ err: err.message }, "Redis connection error");
      logged = true;
    }
  });

  client.on("connect", () => {
    logger.info("Redis connected");
    logged = false;
  });

  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
