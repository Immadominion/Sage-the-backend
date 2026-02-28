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
    .enum(["mainnet-beta", "devnet", "localnet"])
    .default("devnet"),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  SENTINEL_PROGRAM_ID: z.string().min(32).max(50),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("sage-backend"),
  JWT_ACCESS_TTL: z.string().default(process.env.NODE_ENV === "production" ? "15m" : "24h"),
  JWT_REFRESH_TTL: z.string().default(process.env.NODE_ENV === "production" ? "7d" : "30d"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().default("file:sage.db"),
  CORS_ORIGINS: z.string().default("*"),
  HELIUS_API_KEY: z.string().optional(),
  METEORA_API_URL: z
    .string()
    .url()
    .default("https://dlmm-api.meteora.ag"),
  ML_SERVICE_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:8100"),
  ML_API_KEY: z
    .string()
    .optional()
    .describe("API key for authenticating with the ML prediction service"),
  WALLET_PATH: z
    .string()
    .optional()
    .describe("Path to Solana wallet keypair JSON (required for live mode)"),
  WALLET_PRIVATE_KEY: z
    .string()
    .optional()
    .describe("Base64-encoded secret key (alternative to WALLET_PATH)"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.format());
  process.exit(1);
}

export type Config = z.infer<typeof envSchema>;
export const config: Config = parsed.data;
export default config;
