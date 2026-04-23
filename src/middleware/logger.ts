/**
 * Structured logger — pino
 *
 * Uses LOG_LEVEL from config (defaults: production=info, dev=debug).
 * Pretty-printing enabled in non-production environments only.
 *
 * Redaction: every potentially-sensitive field path is censored before
 * serialization. New secret-bearing fields MUST be added here as the
 * codebase grows. See AURA_BACKEND_HARDENING_ROADMAP.md (C1) for context.
 */

import pino from "pino";

const level =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

/**
 * Field paths that must NEVER appear in logs in plaintext.
 *
 * Pino dot-notation: `*.foo` matches `foo` at any object depth.
 */
const REDACT_PATHS = [
  // Request headers
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "*.authorization",
  "*.cookie",

  // Auth artifacts
  "*.password",
  "*.passwordHash",
  "*.refreshToken",
  "*.refreshTokenHash",
  "*.accessToken",
  "*.token",
  "*.jwt",
  "*.authNonce",
  "*.signature",
  "*.signatureBase58",

  // On-chain secrets
  "*.privateKey",
  "*.secretKey",
  "*.encryptedPrivateKey",
  "*.encryptedSecret",
  "*.keypair",
  "*.mnemonic",
  "*.seed",

  // External API keys
  "*.apiKey",
  "*.api_key",
  "*.helius",
  "*.heliusApiKey",
  "*.anthropicApiKey",
  "*.openaiApiKey",
  "*.lpAgentApiKey",

  // Env-shaped object dumps (e.g. accidental `logger.info(config)`)
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "JWT_SECRET",
  "MASTER_ENCRYPTION_KEY",
  "LP_AGENT_API_KEY",
  "HELIUS_API_KEY",
  "DATABASE_URL",
  "WALLET_PRIVATE_KEY",
];

export const logger = pino({
  level,
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
    remove: false,
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export default logger;
