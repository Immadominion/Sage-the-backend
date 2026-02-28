/**
 * Rate limiting middleware for the Sage Backend.
 *
 * Uses hono-rate-limiter with in-memory store (sufficient for single-process).
 * Different tiers for different endpoint groups:
 *  - Auth: strict (prevent brute force)
 *  - Bot lifecycle: moderate (prevent spam start/stop)
 *  - Read endpoints: generous (allow polling)
 *  - ML: moderate (prevent abuse of inference)
 */

import { rateLimiter } from "hono-rate-limiter";
import type { Context } from "hono";

/**
 * Extract a key for rate limiting.
 * Uses JWT userId if authenticated, otherwise IP address.
 */
function getKeyGenerator(c: Context): string {
  // Try to get userId from JWT (set by requireAuth middleware)
  const userId = (c as any).var?.userId;
  if (userId) return `user:${userId}`;

  // Fall back to IP
  const forwarded = c.req.header("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? "unknown";
  return `ip:${ip}`;
}

/**
 * Strict rate limit for auth endpoints.
 * 10 requests per minute per IP — prevents brute force on nonce/verify.
 */
export const authRateLimit = rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 10,
  keyGenerator: getKeyGenerator,
  message: { error: "Too many auth requests, please try again later" },
});

/**
 * Moderate rate limit for bot lifecycle (start/stop/create/delete).
 * 30 requests per minute per user.
 */
export const botLifecycleRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: getKeyGenerator,
  message: { error: "Too many bot operations, please slow down" },
});

/**
 * Generous rate limit for read endpoints (list, detail, positions).
 * 120 requests per minute per user — allows polling every 500ms.
 */
export const readRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: getKeyGenerator,
  message: { error: "Too many requests, please slow down" },
});

/**
 * ML inference rate limit.
 * 30 requests per minute per user — ML predictions are expensive.
 */
export const mlRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: getKeyGenerator,
  message: { error: "Too many ML prediction requests" },
});

/**
 * Global rate limit — absolute ceiling per IP/user.
 * 300 requests per minute — catches any abuse pattern the tier limits miss.
 */
export const globalRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 300,
  keyGenerator: getKeyGenerator,
  message: { error: "Rate limit exceeded" },
});
