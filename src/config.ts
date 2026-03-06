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
  SOLANA_RPC_URL: z.string().url().default("https://betsey-5efi0d-fast-devnet.helius-rpc.com"),
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

  // ── Sponsor Wallet ──────────────────────────────────────
  // Option 1: Server-side keypair (simple, recommended for dev/hackathon)
  SPONSOR_KEYPAIR: z
    .string()
    .optional()
    .describe(
      "Base58-encoded secret key for the sponsor wallet. " +
      "Generate with: solana-keygen new --no-bip39-passphrase -o sponsor.json"
    ),

  // Option 2: Turnkey HSM (production-grade, future upgrade path)
  TURNKEY_API_PUBLIC_KEY: z
    .string()
    .optional()
    .describe("Turnkey API public key for sponsor wallet HSM"),
  TURNKEY_API_PRIVATE_KEY: z
    .string()
    .optional()
    .describe("Turnkey API private key for sponsor wallet HSM"),
  TURNKEY_ORGANIZATION_ID: z
    .string()
    .optional()
    .describe("Turnkey organization ID"),
  TURNKEY_SPONSOR_ADDRESS: z
    .string()
    .optional()
    .describe("Solana address of the sponsor wallet managed by Turnkey"),

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
  const missingRequired = [
    parsed.data.SOLANA_NETWORK ? null : "SOLANA_NETWORK",
    parsed.data.SOLANA_RPC_URL ? null : "SOLANA_RPC_URL",
    parsed.data.SEAL_PROGRAM_ID ? null : "SEAL_PROGRAM_ID",
  ].filter(Boolean);

  if (missingRequired.length > 0) {
    console.error(
      `❌ Missing required production configuration: ${missingRequired.join(", ")}`
    );
    process.exit(1);
  }
}

export type Config = z.infer<typeof envSchema>;
export const config: Config = parsed.data;
export default config;
