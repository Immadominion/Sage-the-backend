/**
 * Aura Backend — Database schema (Drizzle ORM + PostgreSQL)
 *
 * Tables:
 *  - users: wallet-authenticated users
 *  - bots: per-user bot instances with config + encrypted wallet keypairs
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
 *
 * Security:
 *  Bot private keys are encrypted at rest with AES-256-GCM.
 *  The master encryption key lives in MASTER_ENCRYPTION_KEY env var,
 *  never in the database. Keys are only decrypted in-memory during
 *  active trading and zeroized on bot stop.
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
    /**
     * Monotonically-increasing token generation. Bumped by /auth/logout to
     * invalidate every previously-issued JWT. Access tokens carry this value
     * in their payload; refresh-time check rejects mismatches.
     */
    tokenVersion: integer("token_version").notNull().default(0),
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
    /** Strategy type: rule-based, aura-ai, both, or llm */
    strategyMode: text("strategy_mode", {
      enum: ["rule-based", "aura-ai", "both", "llm"],
    })
      .notNull()
      .default("rule-based"),

    // ── Entry Criteria ──
    entryScoreThreshold: doublePrecision("entry_score_threshold")
      .notNull()
      .default(150),
    /** ML probability threshold override for aura-ai mode (0-1). Null = use model default. */
    mlThreshold: doublePrecision("ml_threshold"),
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
    /** Cumulative platform fees paid by this bot (lamports). Append-only — never reset. */
    totalFeesPaidLamports: bigint("total_fees_paid_lamports", { mode: "number" })
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

    // ── Bot Wallet (per-bot fund isolation, live mode only) ──
    /**
     * Solana public key of this bot's dedicated wallet.
     * Each live-mode bot gets its own keypair for fund isolation.
     * Null for simulation-mode bots.
     */
    walletAddress: text("wallet_address"),
    /**
     * AES-256-GCM encrypted private key (base64).
     * Decrypted in-memory only during active trading.
     * Master key stored in env MASTER_ENCRYPTION_KEY, never in DB.
     */
    encryptedPrivateKey: text("encrypted_private_key"),
    /**
     * Owner's MWA wallet address — withdrawal whitelist.
     * Funds can ONLY be withdrawn to this address.
     */
    ownerWallet: text("owner_wallet"),

    // ── LLM Mode (per-bot Anthropic key, encrypted at rest) ──
    /**
     * AES-256-GCM encrypted Anthropic API key.
     * Only decrypted in-memory when strategyMode === "llm".
     * Uses the same MASTER_ENCRYPTION_KEY as encryptedPrivateKey.
     */
    encryptedLlmApiKey: text("encrypted_llm_api_key"),
    /** LLM model override. Null = claude-haiku-4-5-20251001 */
    llmModel: text("llm_model"),
    /** Hard daily USD spend cap for LLM API calls. Null = unlimited */
    llmMaxUsdPerDay: doublePrecision("llm_max_usd_per_day"),
    /** Max pools included in a single LLM prompt. Null = 10 */
    llmMaxPoolsPerCall: integer("llm_max_pools_per_call"),

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

// ═══════════════════════════════════════════════════════════════
// Bot Decisions (per-pool scan decisions — audit §6.2)
// ═══════════════════════════════════════════════════════════════

export const botDecisions = pgTable(
  "bot_decisions",
  {
    id: serial("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.botId),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    /** Groups all decisions from the same scan cycle */
    scanId: text("scan_id").notNull(),
    poolAddress: text("pool_address").notNull(),
    poolName: text("pool_name").notNull(),
    /** What happened */
    decision: text("decision", {
      enum: ["entered", "watched", "skipped"],
    }).notNull(),
    /** Human-readable reason for the decision */
    reason: text("reason").notNull(),
    /** Rule-based total score */
    ruleScore: doublePrecision("rule_score"),
    /** ML probability (0-1) if available */
    mlProbability: doublePrecision("ml_probability"),
    /** Full MarketScore breakdown (JSON) */
    scoreBreakdown: jsonb("score_breakdown"),
    /** V3 ML feature snapshot (JSON) */
    features: jsonb("features"),
    /** Linked position ID when decision = 'entered' */
    positionId: text("position_id"),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_decisions_bot_id_idx").on(table.botId),
    index("bot_decisions_user_id_idx").on(table.userId),
    index("bot_decisions_scan_id_idx").on(table.scanId),
    index("bot_decisions_position_id_idx").on(table.positionId),
    index("bot_decisions_timestamp_idx").on(table.timestamp),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Device Tokens (FCM push notifications)
// ═══════════════════════════════════════════════════════════════

export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** FCM registration token */
    token: text("token").notNull(),
    /** Device platform: ios | android */
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("device_tokens_user_id_idx").on(table.userId),
    uniqueIndex("device_tokens_token_idx").on(table.token),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Fee Ledger (per-trade platform fees)
// ═══════════════════════════════════════════════════════════════
//
// Append-only audit log of every platform fee charged to a bot.
// One row per position open. In live mode, txSignature points to the
// SystemProgram.transfer that delivered the fee on-chain. In simulation
// mode, txSignature is null (virtual deduction only).

export const feeLedger = pgTable(
  "fee_ledger",
  {
    id: serial("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.botId),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    /** Linked position ID. Null if fee was charged but position open failed. */
    positionId: text("position_id"),
    /** Bot mode at the time the fee was charged */
    mode: text("mode", { enum: ["simulation", "live"] }).notNull(),
    /** Strategy mode at the time the fee was charged */
    strategyMode: text("strategy_mode", {
      enum: ["rule-based", "aura-ai", "both", "llm"],
    }).notNull(),
    /** Fee event type — currently only "entry"; "exit" reserved for future */
    feeType: text("fee_type", { enum: ["entry", "exit"] })
      .notNull()
      .default("entry"),
    /** Position size in lamports the fee was computed against */
    positionSizeLamports: bigint("position_size_lamports", { mode: "number" })
      .notNull(),
    /** Total bps applied (base + surcharge) */
    feeBps: integer("fee_bps").notNull(),
    /** Lamports actually charged (post-clamp to min/max) */
    feeLamports: bigint("fee_lamports", { mode: "number" }).notNull(),
    /** Fee collector wallet at the time of charge — captured for audit */
    collectorWallet: text("collector_wallet").notNull(),
    /** Solana tx signature (live mode only). Null for simulation. */
    txSignature: text("tx_signature"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("fee_ledger_bot_id_idx").on(table.botId),
    index("fee_ledger_user_id_idx").on(table.userId),
    index("fee_ledger_position_id_idx").on(table.positionId),
    index("fee_ledger_created_at_idx").on(table.createdAt),
  ]
);

// ═══════════════════════════════════════════════════════════════
// Brains (Wallet Intelligence — analysis runs)
// ═══════════════════════════════════════════════════════════════
//
// A "brain" is an analysis of a real wallet's on-chain trading: the backend
// fetches the wallet's full history, the wallet-intelligence service decodes it
// and reconstructs real DLMM positions (real PnL) + swaps, and the resulting
// behavioral fingerprint is stored here. One row per analysis run.
//
// Analysis is async (seconds-to-minutes): the row is created `queued` and the
// in-process worker advances status → fetching → decoding → reconstructing →
// complete (or error). The client polls GET /brain/:brainId.

export const brains = pgTable(
  "brains",
  {
    id: serial("id").primaryKey(),
    /** Short unique ID for API use (8-char hex) — uniqueness via brains_brain_id_idx */
    brainId: text("brain_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    /** The wallet being analyzed (NOT the user's auth wallet) */
    walletAddress: text("wallet_address").notNull(),

    /** Analysis lifecycle status */
    status: text("status", {
      enum: ["queued", "fetching", "decoding", "reconstructing", "complete", "error"],
    })
      .notNull()
      .default("queued"),

    // ── Request params ──
    windowDays: integer("window_days").notNull().default(90),
    maxTxs: integer("max_txs").notNull().default(5000),

    // ── Evidence counts (filled as analysis progresses) ──
    txsScanned: integer("txs_scanned"),
    positionsTotal: integer("positions_total"),
    positionsComplete: integer("positions_complete"),
    swapsFound: integer("swaps_found"),
    poolsResolved: integer("pools_resolved"),
    /** high | medium | low — derived from evidence volume */
    confidence: text("confidence"),

    // ── Results (JSON) ──
    /** Full behavioral fingerprint (aura.wallet_fingerprint.v1) */
    fingerprint: jsonb("fingerprint"),
    /** PnL summary (win rate, profit factor, avg pnl/alpha, median hold) */
    pnlSummary: jsonb("pnl_summary"),
    /** Top priced positions for transparency / Solscan reconciliation */
    pricedPositions: jsonb("priced_positions"),

    /** Error message if status = error */
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("brains_brain_id_idx").on(table.brainId),
    index("brains_user_id_idx").on(table.userId),
    index("brains_wallet_address_idx").on(table.walletAddress),
    index("brains_status_idx").on(table.status),
  ]
);
