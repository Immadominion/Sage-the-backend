/**
 * Aura Backend — Environment configuration with Zod validation.
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
  MASTER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "MASTER_ENCRYPTION_KEY must be 64 hex chars (32 bytes)")
    .describe("AES-256-GCM key for encrypting bot keypairs at rest"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("aura-backend"),
  JWT_ACCESS_TTL: z.string().default(process.env.NODE_ENV === "production" ? "15m" : "24h"),
  JWT_REFRESH_TTL: z.string().default(process.env.NODE_ENV === "production" ? "7d" : "30d"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().default(
    process.env.NODE_ENV === "production"
      ? "postgresql://localhost:5432/aura"
      : "postgresql://localhost:5432/aura_dev"
  ),
  CORS_ORIGINS: z.string().default("*"),
  HELIUS_API_KEY: z.string().optional(),
  /**
   * Jupiter Developer Platform API key (https://developers.jup.ag/portal).
   * Powers the Smart Wallet feature: token metadata, USD prices, and
   * swap-to-SOL routing for the /wallet/sweep endpoint. When unset, the
   * portfolio endpoint still works (returns raw mints with no USD value)
   * but /wallet/sweep returns 503.
   */
  JUPITER_API_KEY: z
    .string()
    .optional()
    .describe("Jupiter Developer Platform API key (x-api-key header)"),
  METEORA_API_URL: z
    .string()
    .url()
    .default("https://dlmm.datapi.meteora.ag"),
  LP_AGENT_API_KEY: z
    .string()
    .optional()
    .describe("LP Agent API key for bounty endpoints (zap in/out + data APIs)"),
  LP_AGENT_BASE_URL: z
    .string()
    .url()
    .default("https://api.lpagent.io/open-api/v1")
    .describe("LP Agent Open API base URL"),
  LP_AGENT_TIMEOUT_MS: z
    .coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(15000)
    .describe("LP Agent request timeout in milliseconds"),
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

  // ── Fee Collection (per-trade billing) ───────────────
  /**
   * Solana wallet address that receives platform fees collected per trade.
   * In live mode, an extra SystemProgram.transfer instruction is appended
   * to the position-open tx. In simulation mode, the fee is deducted from
   * the bot's virtual balance and recorded in fee_ledger.
   * If unset, fee collection is disabled (treated as 0 bps).
   */
  FEE_COLLECTOR_WALLET: z
    .string()
    .optional()
    .refine(
      (v) => v == null || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v),
      "FEE_COLLECTOR_WALLET must be a valid base58 Solana address (32-44 chars)"
    )
    .describe("Base58 Solana address that receives per-trade platform fees"),
  /** Base fee in basis points charged on every position open (1 bp = 0.01%). Default 9 bps = 0.09%. */
  FEE_BPS_BASE: z.coerce.number().int().min(0).max(500).default(9),
  /** Extra fee in bps when strategyMode = "aura-ai" or "both". Default 0 (same as base). */
  FEE_BPS_AURA_AI_SURCHARGE: z.coerce.number().int().min(0).max(500).default(0),
  /** Extra fee in bps when strategyMode = "llm" (covers Claude API cost). Default 15 bps. */
  FEE_BPS_LLM_SURCHARGE: z.coerce.number().int().min(0).max(500).default(15),
  /** Floor — never charge less than this many lamports per trade. Default 3000 lamports. */
  FEE_MIN_LAMPORTS: z.coerce.number().int().min(0).default(3000),
  /** Ceiling — never charge more than this many lamports per trade. Default 15_000_000 lamports = 0.015 SOL. */
  FEE_MAX_LAMPORTS: z.coerce.number().int().min(0).default(15_000_000),

  // ── Redis (rate-limit store, optional) ────────────────
  /**
   * If set, all rate-limit middleware uses Redis as the shared store
   * (so limits are enforced across multiple replicas). When unset, the
   * limiter falls back to per-process in-memory state — fine for a single
   * Railway instance, breaks under horizontal scaling.
   */
  REDIS_URL: z
    .string()
    .url()
    .optional()
    .describe("Redis connection string (rediss://… for TLS) used by the rate limiter"),

  // ── Admin gate ───────────────────────────────────────
  /**
   * Shared secret required for admin-only routes (`/ml/reload`,
   * `/ml/feedback`, `/analytics/*`). When unset, the entire admin
   * surface returns 503. Compared in length-aware constant time inside
   * `middleware/admin.ts`.
   */
  ADMIN_TOKEN: z
    .string()
    .min(16)
    .optional()
    .describe("Shared secret for admin routes (x-admin-token header)"),

  // ── Push notifications (FCM) ─────────────────────────
  /**
   * Firebase service-account JSON, single-line. Required to send pushes
   * via firebase-admin. When unset, the dispatcher logs once at boot and
   * silently no-ops every push attempt (graceful degradation).
   */
  FIREBASE_SERVICE_ACCOUNT_JSON: z
    .string()
    .optional()
    .describe("Single-line JSON for the Firebase service account"),
  /**
   * Per-user, per-category cooldown for push notifications (ms).
   * Prevents notification spam when bots open many positions in quick
   * succession. Default 60s.
   */
  PUSH_THROTTLE_MS: z.coerce.number().int().min(0).default(60_000),
  /**
   * Daily PnL digest hour (UTC). Default 21:00 UTC ≈ 13:00 PT / 16:00 ET.
   * Set to -1 to disable the digest cron entirely.
   */
  DIGEST_HOUR_UTC: z.coerce.number().int().min(-1).max(23).default(21),

  // ── Wallet Intelligence service ──────────────────────
  WALLET_INTEL_URL: z
    .string()
    .url()
    .optional()
    .describe("Base URL of the wallet-intelligence FastAPI service (e.g. http://localhost:8200)"),
  WALLET_INTEL_API_KEY: z
    .string()
    .optional()
    .describe("Shared secret sent as X-WI-API-Key to the wallet-intelligence service"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Use raw stdout writes so the message survives any logger reconfiguration
  // and is visible in Railway's deploy log stream (which sometimes drops
  // pino's structured JSON during a crash window).
  process.stdout.write("\n");
  process.stdout.write("================================================================\n");
  process.stdout.write("FATAL: Invalid environment variables — process cannot continue.\n");
  process.stdout.write("================================================================\n");
  process.stdout.write(JSON.stringify(parsed.error.format(), null, 2) + "\n");
  process.stdout.write("================================================================\n\n");
  // Give stdout a tick to flush before exit (Railway buffers child stdio).
  setTimeout(() => process.exit(1), 100);
  // Throw synchronously so nothing further runs in this tick either.
  throw new Error("Invalid environment variables");
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
    errors.push(
      "CORS_ORIGINS is '*' — set an explicit comma-separated origin list (e.g. https://useaura.wtf,https://app.useaura.wtf)"
    );
  } else {
    // Validate every entry is a real https origin (or http://localhost for dev tunnels)
    const bad = parsed.data.CORS_ORIGINS
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .filter((s) => {
        try {
          const u = new URL(s);
          return !(u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost"));
        } catch {
          return true;
        }
      });
    if (bad.length > 0) {
      errors.push(`CORS_ORIGINS contains invalid entries: ${bad.join(", ")}`);
    }
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
    // Loud, plain-text output so the failure shows up in Railway's deploy
    // log stream (which sometimes truncates pino JSON during a crash).
    process.stdout.write("\n");
    process.stdout.write("================================================================\n");
    process.stdout.write("PRODUCTION CONFIG ERRORS — service is starting in DEGRADED mode.\n");
    process.stdout.write("Auth / CORS / DB-dependent routes will misbehave until fixed.\n");
    process.stdout.write("/health will respond so the platform keeps the container alive.\n");
    process.stdout.write("================================================================\n");
    for (const e of errors) {
      process.stdout.write(`  • ${e}\n`);
    }
    process.stdout.write("================================================================\n\n");
    // NOTE: We deliberately do NOT process.exit(1) here. A hard exit during
    // boot causes Railway to mark the deploy 'service unavailable' with no
    // useful logs in the Healthcheck panel — operators then can't see *why*
    // the deploy failed. Boot proceeds; the offending env vars are logged
    // explicitly above. Each of these conditions is also enforced at runtime
    // by the relevant middleware (auth rejects weak JWT_SECRET, CORS
    // middleware never echoes '*' with credentials, db connect fails fast).
  }
}

export type Config = z.infer<typeof envSchema>;
export const config: Config = parsed.data;
export default config;
