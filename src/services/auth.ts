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
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface SageJWTPayload extends JWTPayload {
  sub: string; // wallet address
  userId: number;
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

/** Generate a random nonce and store it for the given wallet address. */
export async function generateNonce(walletAddress: string): Promise<string> {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS;

  // Upsert user with new nonce
  const existing = db
    .select()
    .from(users)
    .where(eq(users.walletAddress, walletAddress))
    .get();

  if (existing) {
    db.update(users)
      .set({ authNonce: nonce, authNonceExpiresAt: expiresAt })
      .where(eq(users.walletAddress, walletAddress))
      .run();
  } else {
    db.insert(users)
      .values({
        walletAddress,
        authNonce: nonce,
        authNonceExpiresAt: expiresAt,
      })
      .run();
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
    `sage.app wants you to sign in with your Solana account:`,
    walletAddress,
    ``,
    `Sign in to Sage — your autonomous LP trading agent.`,
    ``,
    `URI: https://sage.app`,
    `Version: 1`,
    `Chain ID: ${config.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : config.SOLANA_NETWORK}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/**
 * Verify an Ed25519 signature over a SIWS message.
 * Returns the user ID if valid, throws if invalid.
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

  // 3. Verify nonce (replay prevention)
  const user = db
    .select()
    .from(users)
    .where(eq(users.walletAddress, walletAddress))
    .get();

  if (!user || !user.authNonce) {
    throw new Error("No pending nonce for this wallet");
  }

  // Extract nonce from message
  const nonceMatch = message.match(/Nonce: (.+)/);
  if (!nonceMatch || nonceMatch[1] !== user.authNonce) {
    throw new Error("Nonce mismatch");
  }

  // Check nonce expiry
  const now = Math.floor(Date.now() / 1000);
  if (user.authNonceExpiresAt && user.authNonceExpiresAt < now) {
    throw new Error("Nonce expired");
  }

  // 4. Invalidate nonce (single-use)
  db.update(users)
    .set({ authNonce: null, authNonceExpiresAt: null })
    .where(eq(users.walletAddress, walletAddress))
    .run();

  return { userId: user.id, walletAddress: user.walletAddress };
}

// ═══════════════════════════════════════════════════════════════
// JWT Token Management
// ═══════════════════════════════════════════════════════════════

/** Issue access + refresh JWT tokens for a verified user. */
export async function issueTokens(
  userId: number,
  walletAddress: string
): Promise<AuthTokens> {
  const accessToken = await new SignJWT({
    sub: walletAddress,
    userId,
  } satisfies SageJWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(config.JWT_ISSUER)
    .setExpirationTime(config.JWT_ACCESS_TTL)
    .sign(JWT_SECRET);

  const refreshToken = await new SignJWT({
    sub: walletAddress,
    userId,
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

  db.update(users)
    .set({ refreshTokenHash: hash })
    .where(eq(users.walletAddress, walletAddress))
    .run();

  return {
    accessToken,
    refreshToken,
    expiresIn: config.JWT_ACCESS_TTL,
  };
}

/** Verify a JWT access token and return the payload. */
export async function verifyAccessToken(
  token: string
): Promise<SageJWTPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    issuer: config.JWT_ISSUER,
  });
  return payload as SageJWTPayload;
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

  const user = db
    .select()
    .from(users)
    .where(eq(users.walletAddress, walletAddress))
    .get();

  if (!user || user.refreshTokenHash !== hash) {
    throw new Error("Refresh token revoked or invalid");
  }

  // Issue new token pair (rotation)
  return issueTokens(user.id, user.walletAddress);
}
