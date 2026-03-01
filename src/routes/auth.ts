/**
 * Authentication routes — SIWS (Sign-In With Solana)
 *
 * POST /auth/nonce    — Generate nonce for wallet
 * POST /auth/verify   — Verify signature, return JWT
 * POST /auth/refresh  — Refresh token rotation
 * GET  /auth/me       — Get current user (requires auth)
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  generateNonce,
  verifySIWSSignature,
  issueTokens,
  refreshTokens,
  buildSIWSMessage,
} from "../services/auth.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

const auth = new Hono<{ Variables: AuthVariables }>();

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const nonceSchema = z.object({
  walletAddress: z
    .string()
    .min(32)
    .max(50)
    .describe("Solana wallet address (base58)")
    .optional(),
});

const verifySchema = z.object({
  walletAddress: z.string().min(32).max(50),
  signature: z
    .string()
    .min(64)
    .describe("Ed25519 signature of SIWS message (base58)"),
  message: z.string().min(1).describe("The signed SIWS message"),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

/**
 * POST /auth/nonce
 * Generate a nonce for SIWS authentication.
 *
 * Two modes:
 *  - With `walletAddress`: legacy flow — nonce stored in user record,
 *    full SIWS message returned.
 *  - Without `walletAddress`: MWA-safe flow — nonce stored in memory,
 *    client builds the SIWS message locally after getting the address
 *    from wallet authorization.
 */
auth.post("/nonce", zValidator("json", nonceSchema), async (c) => {
  const { walletAddress } = c.req.valid("json");

  const nonce = await generateNonce(walletAddress ?? null);
  const issuedAt = new Date().toISOString();

  // If walletAddress provided, return the full SIWS message (legacy flow).
  // Otherwise, just return the nonce for client-side message construction.
  const response: Record<string, unknown> = {
    success: true,
    nonce,
    issuedAt,
    expiresInSeconds: 300,
  };

  if (walletAddress) {
    response.message = buildSIWSMessage(walletAddress, nonce, issuedAt);
  }

  return c.json(response);
});

/**
 * POST /auth/verify
 * Verify an Ed25519 signature over a SIWS message.
 * Returns access + refresh JWTs.
 */
auth.post("/verify", zValidator("json", verifySchema), async (c) => {
  const { walletAddress, signature, message } = c.req.valid("json");

  try {
    const { userId } = await verifySIWSSignature(
      walletAddress,
      signature,
      message
    );
    const tokens = await issueTokens(userId, walletAddress);
    const user = db
      .select({
        id: users.id,
        walletAddress: users.walletAddress,
        sentinelWalletAddress: users.sentinelWalletAddress,
        displayName: users.displayName,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();

    return c.json({
      success: true,
      ...tokens,
      walletAddress,
      user,
    });
  } catch (err) {
    throw createApiError(
      err instanceof Error ? err.message : "Verification failed",
      401
    );
  }
});

/**
 * POST /auth/refresh
 * Rotate refresh token and issue new access token.
 */
auth.post("/refresh", zValidator("json", refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid("json");

  try {
    const tokens = await refreshTokens(refreshToken);
    return c.json({ success: true, ...tokens });
  } catch (err) {
    throw createApiError(
      err instanceof Error ? err.message : "Refresh failed",
      401
    );
  }
});

/**
 * GET /auth/me
 * Get current authenticated user info.
 */
auth.get("/me", requireAuth, async (c) => {
  const walletAddress = c.var.walletAddress;

  const user = db
    .select({
      id: users.id,
      walletAddress: users.walletAddress,
      sentinelWalletAddress: users.sentinelWalletAddress,
      displayName: users.displayName,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.walletAddress, walletAddress))
    .get();

  if (!user) {
    throw createApiError("User not found", 404);
  }

  return c.json({ success: true, user });
});

export default auth;
