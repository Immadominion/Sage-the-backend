/**
 * Sage Backend — Environment configuration with Zod validation.
 *
 * All env vars are validated at startup. If any are missing or invalid,
 * the process exits immediately with a clear error message.
 */

import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  SOLANA_NETWORK: z
    .string()
    .default("devnet")
    .transform((v) => (v === "mainnet" ? "mainnet-beta" : v))
    .pipe(z.enum(["mainnet-beta", "devnet", "localnet"])),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  SEAL_PROGRAM_ID: z.string().min(32).max(50).default("EV3TKRVz7pTHpAqBTjP8jmwuvoRBRCpjmVSPHhcMnXqb"),
  SEAL_ALLOWED_PROGRAMS: z
    .string()
    .optional()
    .describe("Comma-separated extra program IDs allowed for Seal agents across all clusters"),
  SEAL_ALLOWED_PROGRAMS_MAINNET: z
    .string()
    .optional()
    .describe("Comma-separated extra program IDs allowed for Seal agents on mainnet-beta"),
  SEAL_ALLOWED_PROGRAMS_DEVNET: z
    .string()
    .optional()
    .describe("Comma-separated extra program IDs allowed for Seal agents on devnet/localnet"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("sage-backend"),
  JWT_ACCESS_TTL: z.string().default(process.env.NODE_ENV === "production" ? "15m" : "24h"),
  JWT_REFRESH_TTL: z.string().default(process.env.NODE_ENV === "production" ? "7d" : "30d"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().default(
    process.env.NODE_ENV === "production"
      ? "postgresql://localhost:5432/sage"
      : "postgresql://localhost:5432/sage_dev"
  ),
  CORS_ORIGINS: z.string().default("*"),
  HELIUS_API_KEY: z.string().optional(),
  METEORA_API_URL: z
    .string()
    .url()
    .default("https://dlmm-api.meteora.ag"),
  WALLET_PATH: z
    .string()
    .optional()
    .describe("Path to Solana wallet keypair JSON (required for live mode)"),
  WALLET_PRIVATE_KEY: z
    .string()
    .optional()
    .describe("Base64-encoded secret key (alternative to WALLET_PATH)"),

  // ── AI Services ──────────────────────────────────────
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .describe("Anthropic API key for Claude LLM (strategy + portfolio chat)"),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .describe("OpenAI API key for speech-to-text (gpt-4o-mini-transcribe)"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.format());
  process.exit(1);
}

if (parsed.data.NODE_ENV === "production") {
  const warnings: string[] = [];
  const errors: string[] = [];

  // JWT_SECRET must not be the dev default
  if (
    parsed.data.JWT_SECRET.includes("dev-secret") ||
    parsed.data.JWT_SECRET.includes("change-this")
  ) {
    errors.push(
      "JWT_SECRET is using a development default — set a secure random secret"
    );
  }

  // DATABASE_URL must point to a real database, not localhost
  if (
    parsed.data.DATABASE_URL.includes("localhost") ||
    parsed.data.DATABASE_URL.includes("127.0.0.1")
  ) {
    errors.push(
      "DATABASE_URL points to localhost — set to your Railway/production PostgreSQL URL"
    );
  }

  // CORS must not be wildcard in production
  if (parsed.data.CORS_ORIGINS === "*") {
    warnings.push(
      "CORS_ORIGINS is '*' — consider restricting to your frontend domain"
    );
  }

  // RPC should not be a public endpoint
  if (
    parsed.data.SOLANA_RPC_URL.includes("api.mainnet-beta.solana.com") ||
    parsed.data.SOLANA_RPC_URL.includes("api.devnet.solana.com")
  ) {
    warnings.push(
      "SOLANA_RPC_URL is a public endpoint — use Helius/Alchemy for reliability"
    );
  }

  // Cross-validate network vs RPC URL
  if (parsed.data.SOLANA_NETWORK === "mainnet-beta") {
    if (parsed.data.SOLANA_RPC_URL.includes("devnet")) {
      errors.push(
        "SOLANA_RPC_URL contains 'devnet' but SOLANA_NETWORK is mainnet-beta — this will connect to the wrong network"
      );
    }
  }

  for (const w of warnings) {
    console.warn(`⚠️  ${w}`);
  }

  if (errors.length > 0) {
    console.error("❌ Production configuration errors:");
    for (const e of errors) {
      console.error(`   • ${e}`);
    }
    process.exit(1);
  }
}

export type Config = z.infer<typeof envSchema>;
export const config: Config = parsed.data;
export default config;
