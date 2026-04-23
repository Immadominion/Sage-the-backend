/**
 * Authentication service — SIWS (Sign-In With Solana) + JWT
 *
 * Flow:
 *  1. Client calls POST /auth/nonce with wallet address
 *  2. Backend generates nonce, stores it with 5-min TTL, returns it
 *  3. Client signs the SIWS message with their wallet (via MWA)
 *  4. Client calls POST /auth/verify with address + signature + message
 *  5. Backend verifies Ed25519 signature, upserts user, returns JWT
 *
 * Uses `jose` for JWT (zero-dependency, Web Crypto compatible)
 * Uses `tweetnacl` for Ed25519 signature verification
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "node:crypto";
import config from "../config.js";
import db from "../db/index.js";
import { users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AuraJWTPayload extends JWTPayload {
  sub: string; // wallet address
  userId: number;
  /** Bumped on logout/all-device revocation. Refresh-time mismatch → reject. */
  tv?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

// ═══════════════════════════════════════════════════════════════
// JWT Secret (encoded once at startup)
// ═══════════════════════════════════════════════════════════════

const JWT_SECRET = new TextEncoder().encode(config.JWT_SECRET);

// ═══════════════════════════════════════════════════════════════
// Nonce Management
// ═══════════════════════════════════════════════════════════════

const NONCE_TTL_SECONDS = 300; // 5 minutes

// ═══════════════════════════════════════════════════════════════
// In-memory nonce store (for MWA / address-free flow)
// ═══════════════════════════════════════════════════════════════

/**
 * Standalone nonces not tied to a wallet address.
 * Used when the mobile client fetches a nonce before knowing
 * the wallet address (pre-MWA flow on Seeker).
 *
 * Bounded: rejects new entries above MAX_STANDALONE_NONCES to prevent
 * an unauthenticated attacker filling memory between the 60s sweeps.
 */
const MAX_STANDALONE_NONCES = 10_000;
const standaloneNonces = new Map<string, number>(); // nonce → expiresAt

/** Periodically clean expired standalone nonces (every 60s). */
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, expiresAt] of standaloneNonces) {
    if (expiresAt < now) standaloneNonces.delete(nonce);
  }
}, 60_000);

/** Internal helper used by `generateNonce` — throws if we're at capacity. */
function insertStandaloneNonce(nonce: string, expiresAt: number): void {
  if (standaloneNonces.size >= MAX_STANDALONE_NONCES) {
    // One opportunistic sweep before giving up
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of standaloneNonces) if (v < now) standaloneNonces.delete(k);
  }
  if (standaloneNonces.size >= MAX_STANDALONE_NONCES) {
    const err = new Error("Nonce store at capacity, try again shortly") as Error & { statusCode?: number };
    err.statusCode = 429;
    throw err;
  }
  standaloneNonces.set(nonce, expiresAt);
}

/**
 * Generate a random nonce.
 *
 * - With `walletAddress`: legacy flow — nonce stored in the user's DB record.
 * - Without `walletAddress`: MWA-safe flow — nonce stored in memory. The
 *   client will build the SIWS message locally after getting the address
 *   from wallet authorization.
 */
export async function generateNonce(walletAddress: string | null): Promise<string> {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS;

  if (walletAddress) {
    // Legacy flow: store nonce in user record
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.walletAddress, walletAddress));

    if (existing) {
      await db.update(users)
        .set({ authNonce: nonce, authNonceExpiresAt: expiresAt })
        .where(eq(users.walletAddress, walletAddress));
    } else {
      await db.insert(users)
        .values({
          walletAddress,
          authNonce: nonce,
          authNonceExpiresAt: expiresAt,
        });
    }
  } else {
    // MWA-safe flow: store nonce in memory (bounded)
    insertStandaloneNonce(nonce, expiresAt);
  }

  return nonce;
}

// ═══════════════════════════════════════════════════════════════
// SIWS Verification
// ═══════════════════════════════════════════════════════════════

/**
 * Build the Sign-In With Solana message that the client should sign.
 * This is the canonical message format.
 */
export function buildSIWSMessage(
  walletAddress: string,
  nonce: string,
  issuedAt: string
): string {
  return [
    `useaura.wtf wants you to sign in with your Solana account:`,
    walletAddress,
    ``,
    `Sign in to Aura — your autonomous LP trading agent.`,
    ``,
    `URI: https://useaura.wtf`,
    `Version: 1`,
    `Chain ID: ${config.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : config.SOLANA_NETWORK}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/**
 * Verify an Ed25519 signature over a SIWS message.
 * Returns the user ID if valid, throws if invalid.
 *
 * Supports two nonce modes:
 *  1. **Legacy (DB nonce)**: nonce was stored against the user's record
 *     via `POST /auth/nonce` with `walletAddress`.
 *  2. **MWA-safe (standalone nonce)**: nonce was stored in memory via
 *     `POST /auth/nonce` without `walletAddress`. The client built the
 *     SIWS message locally after getting the address from MWA.
 */
export async function verifySIWSSignature(
  walletAddress: string,
  signatureBase58: string,
  message: string
): Promise<{ userId: number; walletAddress: string }> {
  // 1. Decode pubkey and signature
  const publicKeyBytes = bs58.decode(walletAddress);
  const signatureBytes = bs58.decode(signatureBase58);
  const messageBytes = new TextEncoder().encode(message);

  // 2. Verify Ed25519 signature
  const isValid = nacl.sign.detached.verify(
    messageBytes,
    signatureBytes,
    publicKeyBytes
  );

  if (!isValid) {
    throw new Error("Invalid signature");
  }

  // 3. Extract nonce from message — strict, anchored, single-match.
  // We require exactly one `Nonce: <token>` line; defends against attackers
  // who try to smuggle multiple nonce lines into a custom-shaped message.
  const nonceMatches = message.match(/^Nonce: ([A-Za-z0-9_-]+)$/gm);
  if (!nonceMatches || nonceMatches.length === 0) {
    throw new Error("Message does not contain a nonce");
  }
  if (nonceMatches.length > 1) {
    throw new Error("Message contains multiple nonce lines");
  }
  const messageNonce = nonceMatches[0].slice("Nonce: ".length).trim();

  // 4. Verify nonce — check standalone store first, then user record
  const now = Math.floor(Date.now() / 1000);

  if (standaloneNonces.has(messageNonce)) {
    // MWA-safe flow: nonce from in-memory store
    const expiresAt = standaloneNonces.get(messageNonce)!;
    if (expiresAt < now) {
      standaloneNonces.delete(messageNonce);
      throw new Error("Nonce expired");
    }
    // Invalidate (single-use)
    standaloneNonces.delete(messageNonce);
  } else {
    // Legacy flow: nonce from user's DB record
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.walletAddress, walletAddress));

    if (!user || !user.authNonce) {
      throw new Error("No pending nonce for this wallet");
    }

    if (user.authNonce !== messageNonce) {
      throw new Error("Nonce mismatch");
    }

    if (user.authNonceExpiresAt && user.authNonceExpiresAt < now) {
      throw new Error("Nonce expired");
    }

    // Invalidate (single-use)
    await db.update(users)
      .set({ authNonce: null, authNonceExpiresAt: null })
      .where(eq(users.walletAddress, walletAddress));
  }

  // 5. Also validate the Issued At timestamp isn't too old (belt + suspenders)
  const issuedAtMatch = message.match(/Issued At: (.+)/);
  if (issuedAtMatch) {
    const issuedAt = new Date(issuedAtMatch[1].trim());
    const ageSeconds = (Date.now() - issuedAt.getTime()) / 1000;
    if (ageSeconds > NONCE_TTL_SECONDS) {
      throw new Error("Message too old (issued at check)");
    }
  }

  // 6. Upsert user (create if first sign-in)
  let [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.walletAddress, walletAddress));

  if (!existingUser) {
    await db.insert(users)
      .values({ walletAddress });
    [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.walletAddress, walletAddress));
  }

  return { userId: existingUser!.id, walletAddress: existingUser!.walletAddress };
}

// ═══════════════════════════════════════════════════════════════
// JWT Token Management
// ═══════════════════════════════════════════════════════════════

/** Issue access + refresh JWT tokens for a verified user. */
export async function issueTokens(
  userId: number,
  walletAddress: string
): Promise<AuthTokens> {
  // Read current tokenVersion so refresh-time check can reject revoked sessions
  const [u] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.walletAddress, walletAddress));
  const tv = u?.tokenVersion ?? 0;

  const accessToken = await new SignJWT({
    sub: walletAddress,
    userId,
    tv,
  } satisfies AuraJWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setExpirationTime(config.JWT_ACCESS_TTL)
    .sign(JWT_SECRET);

  const refreshToken = await new SignJWT({
    sub: walletAddress,
    userId,
    tv,
    type: "refresh",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setExpirationTime(config.JWT_REFRESH_TTL)
    .sign(JWT_SECRET);

  // Store refresh token hash for rotation
  const hash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  await db.update(users)
    .set({ refreshTokenHash: hash })
    .where(eq(users.walletAddress, walletAddress));

  return {
    accessToken,
    refreshToken,
    expiresIn: config.JWT_ACCESS_TTL,
  };
}

/** Verify a JWT access token and return the payload. */
export async function verifyAccessToken(
  token: string
): Promise<AuraJWTPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    issuer: config.JWT_ISSUER,
  });
  return payload as AuraJWTPayload;
}

/** Verify a refresh token, issue new tokens (rotation). */
export async function refreshTokens(
  refreshToken: string
): Promise<AuthTokens> {
  const { payload } = await jwtVerify(refreshToken, JWT_SECRET, {
    issuer: config.JWT_ISSUER,
  });

  const walletAddress = payload.sub;
  if (!walletAddress) {
    throw new Error("Invalid refresh token: missing sub");
  }

  // Verify the refresh token hash matches what's stored
  const hash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  const [refreshUser] = await db
    .select()
    .from(users)
    .where(eq(users.walletAddress, walletAddress));

  if (!refreshUser || refreshUser.refreshTokenHash !== hash) {
    throw new Error("Refresh token revoked or invalid");
  }

  // Reject if the user has bumped their tokenVersion (logout / revoke-all)
  // since this refresh token was issued.
  const tokenTv = typeof payload.tv === "number" ? payload.tv : 0;
  if (tokenTv !== refreshUser.tokenVersion) {
    throw new Error("Refresh token revoked (token version mismatch)");
  }

  // Issue new token pair (rotation)
  return issueTokens(refreshUser.id, refreshUser.walletAddress);
}

/**
 * Revoke every outstanding session for a user.
 * Bumps tokenVersion (kills any non-expired access tokens at refresh time)
 * AND clears refreshTokenHash (kills the in-flight refresh chain immediately).
 */
export async function revokeAllTokens(userId: number): Promise<void> {
  await db
    .update(users)
    .set({
      refreshTokenHash: null,
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
