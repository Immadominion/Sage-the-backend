/**
 * Rate limiting middleware for the Aura Backend.
 *
 * Uses hono-rate-limiter. When `REDIS_URL` is configured, every limiter
 * shares state via Redis (rate-limit-redis store) so limits hold across
 * replicas. Otherwise each process keeps its own in-memory MemoryStore.
 *
 * Tiers:
 *  - Auth: strict (prevent brute force)
 *  - Bot lifecycle: moderate (prevent spam start/stop)
 *  - Read endpoints: generous (allow polling)
 *  - ML: moderate (prevent abuse of inference)
 *  - External provider passthrough: low (protect server-side keys)
 *  - Global: absolute ceiling per IP/user
 */

import { rateLimiter } from "hono-rate-limiter";
import RedisStore from "rate-limit-redis";
import type { Context } from "hono";
import { getRedis } from "../db/redis.js";
import { logger } from "./logger.js";

function getClientIp(c: Context): string {
  const cfIp = c.req.header("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}

/**
 * Extract a key for rate limiting.
 * Uses JWT userId if authenticated, otherwise IP address.
 */
function getKeyGenerator(c: Context): string {
  // Try to get userId from JWT (set by requireAuth middleware)
  const userId = (c as any).var?.userId;
  if (userId) return `user:${userId}`;

  // Fall back to IP
  const ip = getClientIp(c);
  return `ip:${ip}`;
}

/**
 * Build a per-tier RedisStore (so each tier's keys don't collide).
 *
 * We hand `rate-limit-redis` a `sendCommand` shim that forwards to ioredis's
 * generic `call()` — that's the documented adapter for ioredis. If Redis is
 * unavailable we return undefined and hono-rate-limiter falls back to its
 * built-in MemoryStore.
 *
 * The `Store` shapes between `express-rate-limit` (what rate-limit-redis
 * targets) and `hono-rate-limiter` are structurally identical — same
 * `increment` / `decrement` / `resetKey` contract — so we cast across the
 * nominal-type boundary.
 */
let redisFallbackLogged = false;
function buildStore(prefix: string): unknown {
  const redis = getRedis();
  if (!redis) {
    if (!redisFallbackLogged) {
      logger.warn("REDIS_URL not set — rate limiter using in-memory store (single-replica only)");
      redisFallbackLogged = true;
    }
    return undefined; // hono-rate-limiter will use MemoryStore
  }
  return new RedisStore({
    prefix: `aura:rl:${prefix}:`,
    sendCommand: ((...args: string[]) =>
      (redis as any).call(...args)) as (...args: string[]) => Promise<any>,
  });
}

function tier(prefix: string, opts: { windowMs: number; limit: number; message: string }) {
  const store = buildStore(prefix) as any;
  const baseConfig = {
    windowMs: opts.windowMs,
    limit: opts.limit,
    keyGenerator: getKeyGenerator,
    message: { error: opts.message },
  };
  return rateLimiter(store ? { ...baseConfig, store } : baseConfig);
}

/**
 * Strict rate limit for auth endpoints.
 * 10 requests per minute per IP — prevents brute force on nonce/verify.
 */
export const authRateLimit = tier("auth", {
  windowMs: 60 * 1000,
  limit: 10,
  message: "Too many auth requests, please try again later",
});

/**
 * Moderate rate limit for bot lifecycle (start/stop/create/delete).
 * 30 requests per minute per user.
 */
export const botLifecycleRateLimit = tier("bot", {
  windowMs: 60 * 1000,
  limit: 30,
  message: "Too many bot operations, please slow down",
});

/**
 * Generous rate limit for read endpoints (list, detail, positions).
 * 120 requests per minute per user — allows polling every 500ms.
 */
export const readRateLimit = tier("read", {
  windowMs: 60 * 1000,
  limit: 120,
  message: "Too many requests, please slow down",
});

/**
 * ML inference rate limit.
 * 30 requests per minute per user — ML predictions are expensive.
 */
export const mlRateLimit = tier("ml", {
  windowMs: 60 * 1000,
  limit: 30,
  message: "Too many ML prediction requests",
});

/**
 * External provider passthrough rate limit.
 * LP Agent currently allows low request rates (observed 10 RPM on key),
 * so this tier protects server-side keys from client bursts.
 */
export const externalApiRateLimit = tier("ext", {
  windowMs: 60 * 1000,
  limit: 10,
  message: "Too many external API requests, please slow down",
});

/**
 * Global rate limit — absolute ceiling per IP/user.
 * 300 requests per minute — catches any abuse pattern the tier limits miss.
 */
export const globalRateLimit = tier("global", {
  windowMs: 60 * 1000,
  limit: 300,
  message: "Rate limit exceeded",
});
