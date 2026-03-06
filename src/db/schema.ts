/**
 * Sage Backend — Database schema (Drizzle ORM + PostgreSQL)
 *
 * Tables:
 *  - users: wallet-authenticated users
 *  - bots: per-user bot instances with config
 *  - positions: tracked LP positions (active + historical)
 *  - trade_log: individual trade entries (append-only event log)
 *  - strategy_presets: system + user-defined strategy templates
 *  - conversations: AI chat conversation history
 *
 * Production notes:
 *  - PostgreSQL for durability, replication, and Railway-native backups
 *  - Proper indexes on foreign keys and query columns
 *  - Soft-delete on bots (deletedAt) — trade history is never destroyed
 *  - On-chain position key for blockchain reconciliation
 *  - setupCompleted flag on users for cross-device state
 */

import {
  pgTable,
  text,
  integer,
  serial,
  doublePrecision,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  bigint,
  jsonb,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════════════════════
// Users
// ═══════════════════════════════════════════════════════════════

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    /** Solana wallet address (base58, ~44 chars) — the user's identity */
    walletAddress: text("wallet_address").notNull().unique(),
    /** Seal smart wallet PDA (derived from walletAddress) */
    sealWalletAddress: text("seal_wallet_address"),
    /** Display name (optional) */
    displayName: text("display_name"),
    /** Has user completed setup wizard? (cross-device flag) */
    setupCompleted: boolean("setup_completed").notNull().default(false),
    /** Execution mode chosen during setup */
    execMode: text("exec_mode"),
    /** Setup wizard progress (step, path, params) — cloud-synced across devices */
    setupProgress: jsonb("setup_progress"),
    /** Current nonce for SIWS — invalidated after use */
    authNonce: text("auth_nonce"),
    /** Nonce expiry (unix timestamp seconds) */
    authNonceExpiresAt: integer("auth_nonce_expires_at"),
    /** Refresh token hash (for token rotation) */
    refreshTokenHash: text("refresh_token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_wallet_address_idx").on(table.walletAddress),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Bots
// ═══════════════════════════════════════════════════════════════

export const bots = pgTable(
  "bots",
  {
    id: serial("id").primaryKey(),
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
    entryScoreThreshold: doublePrecision("entry_score_threshold")
      .notNull()
      .default(150),
    minVolume24h: doublePrecision("min_volume_24h").notNull().default(1000),
    minLiquidity: doublePrecision("min_liquidity").notNull().default(100),
    maxLiquidity: doublePrecision("max_liquidity")
      .notNull()
      .default(1_000_000),

    // ── Position Sizing ──
    positionSizeSOL: doublePrecision("position_size_sol")
      .notNull()
      .default(1),
    maxConcurrentPositions: integer("max_concurrent_positions")
      .notNull()
      .default(5),
    defaultBinRange: integer("default_bin_range").notNull().default(10),

    // ── Risk Management ──
    profitTargetPercent: doublePrecision("profit_target_percent")
      .notNull()
      .default(8),
    stopLossPercent: doublePrecision("stop_loss_percent")
      .notNull()
      .default(12),
    maxHoldTimeMinutes: integer("max_hold_time_minutes")
      .notNull()
      .default(240),
    maxDailyLossSOL: doublePrecision("max_daily_loss_sol")
      .notNull()
      .default(2),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(79),

    // ── Scheduler ──
    cronIntervalSeconds: integer("cron_interval_seconds")
      .notNull()
      .default(30),

    // ── Simulation ──
    simulationBalanceSOL: doublePrecision("simulation_balance_sol")
      .notNull()
      .default(10),

    /**
     * Current virtual balance in lamports — persisted on every trade and stop.
     * Null means the bot has never been started (use simulationBalanceSOL × LAMPORTS_PER_SOL).
     */
    currentVirtualBalanceLamports: bigint("current_virtual_balance_lamports", {
      mode: "number",
    }),

    // ── Stats (updated by engine) ──
    totalTrades: integer("total_trades").notNull().default(0),
    winningTrades: integer("winning_trades").notNull().default(0),
    totalPnlLamports: bigint("total_pnl_lamports", { mode: "number" })
      .notNull()
      .default(0),

    /** Last error message if status=error */
    lastError: text("last_error"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),

    // ── Visibility ──
    /** Whether this bot appears on the public Fleet leaderboard */
    isPublic: boolean("is_public").notNull().default(false),

    // ── EmergencyStop Persistence ──
    /** Serialized EmergencyStop state JSON — survives server restarts */
    emergencyStopState: text("emergency_stop_state"),

    // ── Seal Agent (per-bot wallet isolation, live mode only) ──
    /**
     * Public key of the agent registered on the user's Seal wallet.
     * Each live-mode bot has its own agent with scoped spending limits.
     * Null for simulation-mode bots or if agent not yet registered.
     */
    agentPubkey: text("agent_pubkey"),
    /**
     * Base64-encoded 64-byte agent keypair (seed + pubkey).
     * Generated server-side so the backend can sign CreateSession TXs.
     * ⚠️ SENSITIVE — should be encrypted at rest in production.
     */
    agentSecretKey: text("agent_secret_key"),
    /**
     * PDA of the AgentConfig account on-chain.
     * Derived from: seeds = ["agent", wallet_pda, agent_pubkey].
     */
    agentConfigAddress: text("agent_config_address"),
    /**
     * PDA of the active SessionKey account for this bot's agent.
     * Created on bot start (live mode), revoked on bot stop.
     * Null when bot is stopped or session hasn't been created yet.
     */
    sessionAddress: text("session_address"),
    /**
     * Public key of the ephemeral session signing key.
     * This is the key that signs executeViaSession transactions —
     * distinct from sessionAddress which is the on-chain PDA.
     */
    sessionPubkey: text("session_pubkey"),
    /**
     * Base64-encoded 64-byte session keypair (seed + pubkey).
     * Generated server-side so the orchestrator can sign trades.
     * ⚠️ SENSITIVE — should be encrypted at rest in production.
     */
    sessionSecretKey: text("session_secret_key"),

    // ── Soft Delete ──
    /** Null = active. Set = soft-deleted. Trade history preserved forever. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bots_bot_id_idx").on(table.botId),
    index("bots_user_id_idx").on(table.userId),
    index("bots_status_idx").on(table.status),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Positions
// ═══════════════════════════════════════════════════════════════

export const positions = pgTable(
  "positions",
  {
    id: serial("id").primaryKey(),
    /** Short unique ID */
    positionId: text("position_id").notNull().unique(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.botId),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),

    status: text("status", {
      enum: ["pending", "active", "closing", "closed", "orphaned", "error"],
    })
      .notNull()
      .default("pending"),

    // ── Pool Info ──
    poolAddress: text("pool_address").notNull(),
    poolName: text("pool_name").notNull(),
    tokenXMint: text("token_x_mint").notNull(),
    tokenYMint: text("token_y_mint").notNull(),
    binStep: integer("bin_step").notNull(),

    // ── On-Chain Reference (for reconciliation) ──
    /** On-chain position public key — the DLMM position account */
    onChainPositionKey: text("on_chain_position_key"),

    // ── Entry Data ──
    entryActiveBinId: integer("entry_active_bin_id"),
    entryPricePerToken: text("entry_price_per_token"),
    entryTimestamp: bigint("entry_timestamp", { mode: "number" }).notNull(),
    entryAmountXLamports: bigint("entry_amount_x_lamports", {
      mode: "number",
    })
      .notNull()
      .default(0),
    entryAmountYLamports: bigint("entry_amount_y_lamports", {
      mode: "number",
    })
      .notNull()
      .default(0),
    entryTxSignature: text("entry_tx_signature"),
    entryScore: doublePrecision("entry_score"),
    mlProbability: doublePrecision("ml_probability"),
    /** V3 ML features captured at entry time (JSON) — for online learning */
    entryFeatures: text("entry_features"),

    // ── Risk Params (snapshot at entry) ──
    profitTargetPercent: doublePrecision("profit_target_percent").notNull(),
    stopLossPercent: doublePrecision("stop_loss_percent").notNull(),
    maxHoldTimeMinutes: integer("max_hold_time_minutes").notNull(),

    // ── Live Checkpoint (updated every 30s while bot runs) ──
    currentPricePerToken: text("current_price_per_token"),
    unrealizedPnlLamports: bigint("unrealized_pnl_lamports", {
      mode: "number",
    }),

    // ── Exit Data ──
    exitPricePerToken: text("exit_price_per_token"),
    exitTimestamp: bigint("exit_timestamp", { mode: "number" }),
    exitTxSignature: text("exit_tx_signature"),
    exitReason: text("exit_reason"),
    realizedPnlLamports: bigint("realized_pnl_lamports", { mode: "number" }),
    feesEarnedXLamports: bigint("fees_earned_x_lamports", { mode: "number" }),
    feesEarnedYLamports: bigint("fees_earned_y_lamports", { mode: "number" }),
    txCostLamports: bigint("tx_cost_lamports", { mode: "number" }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("positions_position_id_idx").on(table.positionId),
    index("positions_bot_id_idx").on(table.botId),
    index("positions_user_id_idx").on(table.userId),
    index("positions_status_idx").on(table.status),
    index("positions_pool_address_idx").on(table.poolAddress),
    index("positions_on_chain_key_idx").on(table.onChainPositionKey),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Trade Log (append-only event log)
// ═══════════════════════════════════════════════════════════════

export const tradeLog = pgTable(
  "trade_log",
  {
    id: serial("id").primaryKey(),
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
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("trade_log_bot_id_idx").on(table.botId),
    index("trade_log_user_id_idx").on(table.userId),
    index("trade_log_timestamp_idx").on(table.timestamp),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Strategy Presets
// ═══════════════════════════════════════════════════════════════

export const strategyPresets = pgTable(
  "strategy_presets",
  {
    id: serial("id").primaryKey(),
    /** Null = system preset, non-null = user-created */
    userId: integer("user_id").references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    /** Is this a system-provided preset? */
    isSystem: boolean("is_system").notNull().default(false),

    // ── Config values (same shape as bot config) ──
    entryScoreThreshold: doublePrecision("entry_score_threshold").notNull(),
    minVolume24h: doublePrecision("min_volume_24h").notNull(),
    minLiquidity: doublePrecision("min_liquidity").notNull(),
    maxLiquidity: doublePrecision("max_liquidity").notNull(),
    positionSizeSOL: doublePrecision("position_size_sol").notNull(),
    maxConcurrentPositions: integer("max_concurrent_positions").notNull(),
    profitTargetPercent: doublePrecision("profit_target_percent").notNull(),
    stopLossPercent: doublePrecision("stop_loss_percent").notNull(),
    maxHoldTimeMinutes: integer("max_hold_time_minutes").notNull(),
    cooldownMinutes: integer("cooldown_minutes").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("strategy_presets_user_id_idx").on(table.userId)]
);

// ═══════════════════════════════════════════════════════════════
// Conversations (AI chat history)
// ═══════════════════════════════════════════════════════════════

export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    /** UUID for API use */
    conversationId: text("conversation_id").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    /** Conversation type */
    type: text("type", {
      enum: ["setup", "portfolio", "general"],
    })
      .notNull()
      .default("general"),
    /** Short title (auto-generated from first message or AI summary) */
    title: text("title"),
    /**
     * Messages array stored as JSONB:
     * [{ role: "user"|"assistant", content: string, timestamp: string }]
     */
    messages: jsonb("messages").notNull().default([]),
    /**
     * Strategy parameters extracted from setup conversations (JSONB).
     * Only populated for type="setup" when AI produces structured output.
     */
    extractedParams: jsonb("extracted_params"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("conversations_conversation_id_idx").on(table.conversationId),
    index("conversations_user_id_idx").on(table.userId),
    index("conversations_type_idx").on(table.type),
  ]
);
