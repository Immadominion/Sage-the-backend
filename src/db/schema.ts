/**
 * Sage Backend — Database schema (Drizzle ORM + SQLite)
 *
 * Tables:
 *  - users: wallet-authenticated users
 *  - bots: per-user bot instances with config
 *  - positions: tracked LP positions (active + historical)
 *  - trade_log: individual trade entries
 *  - strategy_presets: system + user-defined strategy templates
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════
// Users
// ═══════════════════════════════════════════════════════════════

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Solana wallet address (base58, ~44 chars) — the user's identity */
  walletAddress: text("wallet_address").notNull().unique(),
  /** Sentinel smart wallet PDA (derived from walletAddress) */
  sentinelWalletAddress: text("sentinel_wallet_address"),
  /** Display name (optional) */
  displayName: text("display_name"),
  /** Current nonce for SIWS — invalidated after use */
  authNonce: text("auth_nonce"),
  /** Nonce expiry (unix timestamp seconds) */
  authNonceExpiresAt: integer("auth_nonce_expires_at"),
  /** Refresh token hash (for token rotation) */
  refreshTokenHash: text("refresh_token_hash"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ═══════════════════════════════════════════════════════════════
// Bots
// ═══════════════════════════════════════════════════════════════

export const bots = sqliteTable("bots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Short unique ID for API use (8-char hex) */
  botId: text("bot_id").notNull().unique(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  /** Human-readable name */
  name: text("name").notNull().default("My Bot"),
  /** Bot operating mode */
  mode: text("mode", { enum: ["simulation", "live"] })
    .notNull()
    .default("simulation"),
  /** Bot lifecycle status */
  status: text("status", {
    enum: ["stopped", "starting", "running", "stopping", "error"],
  })
    .notNull()
    .default("stopped"),
  /** Strategy type: rule-based, sage-ai, or both */
  strategyMode: text("strategy_mode", {
    enum: ["rule-based", "sage-ai", "both"],
  })
    .notNull()
    .default("rule-based"),

  // ── Entry Criteria ──
  entryScoreThreshold: real("entry_score_threshold").notNull().default(150),
  minVolume24h: real("min_volume_24h").notNull().default(1000),
  minLiquidity: real("min_liquidity").notNull().default(100),
  maxLiquidity: real("max_liquidity").notNull().default(1_000_000),

  // ── Position Sizing ──
  positionSizeSOL: real("position_size_sol").notNull().default(1),
  maxConcurrentPositions: integer("max_concurrent_positions")
    .notNull()
    .default(5),
  defaultBinRange: integer("default_bin_range").notNull().default(10),

  // ── Risk Management ──
  profitTargetPercent: real("profit_target_percent").notNull().default(8),
  stopLossPercent: real("stop_loss_percent").notNull().default(12),
  maxHoldTimeMinutes: integer("max_hold_time_minutes").notNull().default(240),
  maxDailyLossSOL: real("max_daily_loss_sol").notNull().default(2),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(79),

  // ── Scheduler ──
  cronIntervalSeconds: integer("cron_interval_seconds").notNull().default(30),

  // ── Simulation ──
  simulationBalanceSOL: real("simulation_balance_sol").notNull().default(10),

  // ── Stats (updated by engine) ──
  totalTrades: integer("total_trades").notNull().default(0),
  winningTrades: integer("winning_trades").notNull().default(0),
  totalPnlLamports: integer("total_pnl_lamports").notNull().default(0),

  /** Last error message if status=error */
  lastError: text("last_error"),
  lastActivityAt: text("last_activity_at"),

  // ── EmergencyStop Persistence ──
  /** Serialized EmergencyStop state JSON — survives server restarts */
  emergencyStopState: text("emergency_stop_state"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ═══════════════════════════════════════════════════════════════
// Positions
// ═══════════════════════════════════════════════════════════════

export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Short unique ID */
  positionId: text("position_id").notNull().unique(),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.botId),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),

  status: text("status", {
    enum: ["pending", "active", "closing", "closed", "error"],
  })
    .notNull()
    .default("pending"),

  // ── Pool Info ──
  poolAddress: text("pool_address").notNull(),
  poolName: text("pool_name").notNull(),
  tokenXMint: text("token_x_mint").notNull(),
  tokenYMint: text("token_y_mint").notNull(),
  binStep: integer("bin_step").notNull(),

  // ── Entry Data ──
  entryActiveBinId: integer("entry_active_bin_id"),
  entryPricePerToken: text("entry_price_per_token"),
  entryTimestamp: integer("entry_timestamp").notNull(),
  entryAmountXLamports: integer("entry_amount_x_lamports").notNull().default(0),
  entryAmountYLamports: integer("entry_amount_y_lamports").notNull().default(0),
  entryTxSignature: text("entry_tx_signature"),
  entryScore: real("entry_score"),
  mlProbability: real("ml_probability"),
  /** V3 ML features captured at entry time (JSON) — for online learning */
  entryFeatures: text("entry_features"),

  // ── Risk Params (snapshot at entry) ──
  profitTargetPercent: real("profit_target_percent").notNull(),
  stopLossPercent: real("stop_loss_percent").notNull(),
  maxHoldTimeMinutes: integer("max_hold_time_minutes").notNull(),

  // ── Live Checkpoint (updated every 30s while bot runs) ──
  currentPricePerToken: text("current_price_per_token"),
  unrealizedPnlLamports: integer("unrealized_pnl_lamports"),

  // ── Exit Data ──
  exitPricePerToken: text("exit_price_per_token"),
  exitTimestamp: integer("exit_timestamp"),
  exitTxSignature: text("exit_tx_signature"),
  exitReason: text("exit_reason"),
  realizedPnlLamports: integer("realized_pnl_lamports"),
  feesEarnedXLamports: integer("fees_earned_x_lamports"),
  feesEarnedYLamports: integer("fees_earned_y_lamports"),
  txCostLamports: integer("tx_cost_lamports"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ═══════════════════════════════════════════════════════════════
// Trade Log (append-only event log)
// ═══════════════════════════════════════════════════════════════

export const tradeLog = sqliteTable("trade_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.botId),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  positionId: text("position_id"),
  /** Event type */
  event: text("event", {
    enum: [
      "position_opened",
      "position_closed",
      "position_updated",
      "bot_started",
      "bot_stopped",
      "bot_error",
      "scan_completed",
    ],
  }).notNull(),
  /** JSON payload with event details */
  details: text("details"), // JSON string
  timestamp: text("timestamp")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ═══════════════════════════════════════════════════════════════
// Strategy Presets
// ═══════════════════════════════════════════════════════════════

export const strategyPresets = sqliteTable("strategy_presets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Null = system preset, non-null = user-created */
  userId: integer("user_id").references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  /** Is this a system-provided preset? */
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),

  // ── Config values (same shape as bot config) ──
  entryScoreThreshold: real("entry_score_threshold").notNull(),
  minVolume24h: real("min_volume_24h").notNull(),
  minLiquidity: real("min_liquidity").notNull(),
  maxLiquidity: real("max_liquidity").notNull(),
  positionSizeSOL: real("position_size_sol").notNull(),
  maxConcurrentPositions: integer("max_concurrent_positions").notNull(),
  profitTargetPercent: real("profit_target_percent").notNull(),
  stopLossPercent: real("stop_loss_percent").notNull(),
  maxHoldTimeMinutes: integer("max_hold_time_minutes").notNull(),
  cooldownMinutes: integer("cooldown_minutes").notNull(),

  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
