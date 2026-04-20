/**
 * Bot routes — CRUD + lifecycle management.
 *
 * POST   /bot/create        — create a new bot with config
 * GET    /bot/list           — list user's bots
 * GET    /bot/:botId         — get bot detail + stats
 * PUT    /bot/:botId/config  — update config (stopped bots only)
 * POST   /bot/:botId/start   — start bot
 * POST   /bot/:botId/stop    — stop bot
 * POST   /bot/:botId/emergency — emergency close all positions
 * POST   /bot/:botId/convert-to-live — convert simulation to live
 * DELETE /bot/:botId         — delete stopped bot
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import crypto from "node:crypto";
import { createApiError } from "../middleware/error.js";
import { generateEncryptedKeypair } from "../engine/crypto-utils.js";
import db from "../db/index.js";
import { bots, users, positions, tradeLog, botDecisions } from "../db/schema.js";
import { eq, and, sql, isNull, desc } from "drizzle-orm";
import { orchestrator } from "../engine/orchestrator.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { LAMPORTS_PER_SOL } from "../engine/types.js";
import config from "../config.js";

const bot = new Hono<{ Variables: AuthVariables }>();

// All bot routes require authentication
bot.use("/*", requireAuth);

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

/** Base shape — used for both create (with defaults) and update (partial). */
const baseBotConfigSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  mode: z.enum(["simulation", "live"]).default("simulation"),
  strategyMode: z.enum(["rule-based", "aura-ai", "both"]).default("rule-based"),
  // Entry criteria
  entryScoreThreshold: z.number().positive().default(150),
  /** ML probability threshold override (0-1). Omit to use model default. */
  mlThreshold: z.number().min(0).max(1).optional(),
  minVolume24h: z.number().nonnegative().default(1000),
  minLiquidity: z.number().nonnegative().default(100),
  maxLiquidity: z.number().positive().default(1_000_000),
  // Position sizing
  positionSizeSOL: z.number().positive().max(100).default(1),
  maxConcurrentPositions: z.number().int().min(1).max(20).default(5),
  defaultBinRange: z.number().int().min(1).max(50).default(10),
  // Risk management
  profitTargetPercent: z.number().positive().max(100).default(8),
  stopLossPercent: z.number().positive().max(100).default(12),
  maxHoldTimeMinutes: z.number().int().positive().max(1440).default(240),
  maxDailyLossSOL: z.number().positive().max(100).default(2),
  cooldownMinutes: z.number().int().nonnegative().max(1440).default(79),
  // Scheduler
  cronIntervalSeconds: z.number().int().min(10).max(300).default(30),
  // Simulation
  simulationBalanceSOL: z.number().positive().default(10),
  // Visibility
  isPublic: z.boolean().default(false),
});

/**
 * Create schema — auto-clamps capital-coherence for simulation mode.
 *
 * Instead of rejecting invalid configs, we silently fix them:
 *  1. Position size ≥ bankroll → clamp to 40% of bankroll
 *  2. Daily loss limit > bankroll → clamp to bankroll
 *  3. Max theoretical exposure > 2× bankroll → reduce maxConcurrentPositions
 *
 * This acts as a safety net after the AI prompt + clampParams
 * have already tried to produce valid params.
 *
 * Live-mode passes through unchanged (bankroll depends on future deposits).
 */
const createBotSchema = baseBotConfigSchema.transform((data) => {
  if (data.mode !== "simulation") return data;

  const bankroll = data.simulationBalanceSOL;

  // Position size must be < bankroll
  if (data.positionSizeSOL >= bankroll) {
    data.positionSizeSOL = Math.round(Math.min(bankroll * 0.4, 10.0) * 10) / 10;
    // Ensure at least 0.1
    data.positionSizeSOL = Math.max(0.1, data.positionSizeSOL);
  }

  // Daily loss ≤ bankroll
  if (data.maxDailyLossSOL > bankroll) {
    data.maxDailyLossSOL = bankroll;
  }

  // Exposure: positionSize × maxConcurrent ≤ 2× bankroll
  const maxExposure = data.positionSizeSOL * data.maxConcurrentPositions;
  if (maxExposure > bankroll * 2) {
    const maxAllowed = Math.floor((bankroll * 2) / data.positionSizeSOL);
    data.maxConcurrentPositions = Math.max(1, maxAllowed);
  }

  return data;
});

const updateBotConfigSchema = baseBotConfigSchema.partial().omit({ mode: true });

/** Bot ID is an 8-char hex string from crypto.randomBytes(4). */
const BOT_ID_REGEX = /^[0-9a-f]{8}$/;

function validateBotId(botId: string): void {
  if (!BOT_ID_REGEX.test(botId)) {
    throw createApiError("Invalid bot ID format", 400);
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function generateBotId(): string {
  return crypto.randomBytes(4).toString("hex");
}

async function getUserBot(userId: number, botId: string) {
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));
  return row;
}

/** Strip encrypted private key from bot data before sending to the client. */
function sanitizeBot<T extends Record<string, unknown>>(bot: T): Omit<T, 'encryptedPrivateKey'> {
  const { encryptedPrivateKey, ...safe } = bot;
  return safe as Omit<T, 'encryptedPrivateKey'>;
}

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

/**
 * POST /bot/create
 * Create a new bot with the given configuration.
 */
bot.post("/create", zValidator("json", createBotSchema), async (c) => {
  const userId = c.var.userId;
  const body = c.req.valid("json");

  // Limit bots per user (exclude soft-deleted)
  const [existingBots] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bots)
    .where(and(eq(bots.userId, userId), isNull(bots.deletedAt)));

  const botCount = existingBots?.count ?? 0;

  if (botCount >= 10) {
    throw createApiError("Maximum 10 bots per user", 400);
  }

  // ── Validate live mode prerequisites ──
  if (body.mode === "live" && config.SOLANA_NETWORK !== "mainnet-beta") {
    throw createApiError(
      `Live trading requires mainnet (current network: ${config.SOLANA_NETWORK}). ` +
      `Use simulation mode for testing on ${config.SOLANA_NETWORK}.`,
      400
    );
  }

  // Auto-generate sequential name if not provided by client
  const botName = body.name ?? `Strategy ${botCount + 1}`;

  // Enforce unique bot names per user (case-insensitive, exclude deleted)
  if (body.name) {
    const [duplicate] = await db
      .select({ id: bots.id })
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          sql`lower(${bots.name}) = lower(${body.name})`,
          isNull(bots.deletedAt)
        )
      );
    if (duplicate) {
      throw createApiError(
        `A bot named "${body.name}" already exists. Choose a different name.`,
        409
      );
    }
  }

  const botId = generateBotId();

  // For live bots, generate a dedicated encrypted keypair
  let walletAddress: string | undefined;
  let encryptedPrivateKey: string | undefined;
  let ownerWallet: string | undefined;

  if (body.mode === "live") {
    const { publicKey, encryptedSecret } = generateEncryptedKeypair(
      config.MASTER_ENCRYPTION_KEY
    );
    walletAddress = publicKey;
    encryptedPrivateKey = encryptedSecret;
    // ownerWallet is the user's MWA-verified wallet address
    const [user] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, userId));
    ownerWallet = user?.walletAddress;
  }

  await db.insert(bots)
    .values({
      botId,
      userId,
      name: botName,
      mode: body.mode,
      walletAddress: walletAddress ?? null,
      encryptedPrivateKey: encryptedPrivateKey ?? null,
      ownerWallet: ownerWallet ?? null,
      strategyMode: body.strategyMode,
      entryScoreThreshold: body.entryScoreThreshold,
      mlThreshold: body.mlThreshold ?? null,
      minVolume24h: body.minVolume24h,
      minLiquidity: body.minLiquidity,
      maxLiquidity: body.maxLiquidity,
      positionSizeSOL: body.positionSizeSOL,
      maxConcurrentPositions: body.maxConcurrentPositions,
      defaultBinRange: body.defaultBinRange,
      profitTargetPercent: body.profitTargetPercent,
      stopLossPercent: body.stopLossPercent,
      maxHoldTimeMinutes: body.maxHoldTimeMinutes,
      maxDailyLossSOL: body.maxDailyLossSOL,
      cooldownMinutes: body.cooldownMinutes,
      cronIntervalSeconds: body.cronIntervalSeconds,
      simulationBalanceSOL: body.simulationBalanceSOL,
    });

  // Log the creation
  await db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_started", // reuse closest enum value
      details: JSON.stringify({ action: "created", config: body }),
    });

  const created = await getUserBot(userId, botId);

  return c.json({ success: true, bot: sanitizeBot(created!) }, 201);
});

/**
 * GET /bot/list
 * List all bots for the authenticated user.
 */
bot.get("/list", async (c) => {
  const userId = c.var.userId;

  const userBots = await db
    .select()
    .from(bots)
    .where(and(eq(bots.userId, userId), isNull(bots.deletedAt)));

  // Enrich each bot with authoritative live engine state + balance.
  const enriched = userBots.map((b) => {
    const engineRunning = orchestrator.isRunning(b.botId);
    const engineStats = orchestrator.getEngineStats(b.botId);
    const performanceSummary = orchestrator.getPerformanceSummary(b.botId);
    const livePositions = orchestrator.getActivePositions(b.botId);
    let currentBalanceSol: number;
    if (performanceSummary) {
      currentBalanceSol = performanceSummary.currentBalanceSol;
    } else if (b.mode === 'live') {
      // Live bots: capital lives in the bot's dedicated wallet.
      // Show 0 until the engine reports real balance.
      currentBalanceSol = 0;
    } else if (b.currentVirtualBalanceLamports != null) {
      currentBalanceSol = b.currentVirtualBalanceLamports / LAMPORTS_PER_SOL;
    } else {
      currentBalanceSol = b.simulationBalanceSOL;
    }

    return {
      ...sanitizeBot(b),
      currentBalanceSol,
      engineRunning,
      engineStats,
      performanceSummary,
      livePositions,
      activePositionCount: livePositions.length,
    };
  });

  return c.json({ success: true, bots: enriched });
});

/**
 * GET /bot/:botId
 * Get bot detail + stats including active positions count.
 */
bot.get("/:botId", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = await getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  // Count active positions
  const [activePositions] = await db
    .select({ count: sql<number>`count(*)` })
    .from(positions)
    .where(
      and(
        eq(positions.botId, botId),
        eq(positions.status, "active")
      )
    );

  // S2: Include live engine stats if bot is running
  const engineStats = orchestrator.getEngineStats(botId);
  const performanceSummary = orchestrator.getPerformanceSummary(botId);
  const livePositions = orchestrator.getActivePositions(botId);

  // Compute the authoritative balance:
  //  1. If bot is running → live value from executor (most up-to-date)
  //  2. If persisted in DB → restored value from last stop/trade
  //  3. Live mode never-started → 0 (no simulation balance for live)
  //  4. Sim mode never-started → config simulationBalanceSOL
  let currentBalanceSol: number;
  if (performanceSummary) {
    currentBalanceSol = performanceSummary.currentBalanceSol;
  } else if (botData.currentVirtualBalanceLamports != null) {
    currentBalanceSol = botData.currentVirtualBalanceLamports / LAMPORTS_PER_SOL;
  } else if (botData.mode === 'live') {
    currentBalanceSol = 0;
  } else {
    currentBalanceSol = botData.simulationBalanceSOL;
  }

  return c.json({
    success: true,
    bot: sanitizeBot(botData),
    /** Current simulation balance in SOL — always accurate, even when stopped */
    currentBalanceSol,
    activePositionCount: Number(activePositions?.count ?? 0),
    engineRunning: orchestrator.isRunning(botId),
    engineStats: engineStats
      ? {
        totalScans: engineStats.totalScans,
        positionsOpened: engineStats.positionsOpened,
        positionsClosed: engineStats.positionsClosed,
        wins: engineStats.wins,
        losses: engineStats.losses,
        winRate: engineStats.winRate,
        totalPnlSol:
          engineStats.totalPnlLamports.toNumber() / LAMPORTS_PER_SOL,
        runtime: engineStats.runtime,
      }
      : null,
    performanceSummary: performanceSummary ?? null,
    livePositions: livePositions.map((p) => ({
      id: p.id,
      poolName: p.poolName,
      poolAddress: p.poolAddress,
      entryPrice: p.entryPricePerToken,
      currentPrice: p.currentPricePerToken ?? p.entryPricePerToken,
      entryTimestamp: p.entryTimestamp,
      status: p.status,
    })),
  });
});

/**
 * PUT /bot/:botId/config
 * Update bot configuration (allowed when stopped or errored).
 */
bot.put(
  "/:botId/config",
  zValidator("json", updateBotConfigSchema),
  async (c) => {
    const userId = c.var.userId;
    const botId = c.req.param("botId");
    validateBotId(botId);
    const updates = c.req.valid("json");

    const botData = await getUserBot(userId, botId);
    if (!botData) {
      throw createApiError("Bot not found", 404);
    }

    if (
      botData.status === "running" ||
      botData.status === "starting" ||
      botData.status === "stopping"
    ) {
      throw createApiError(
        "Cannot update config while bot is running. Stop it first.",
        400
      );
    }

    // If the user changes the starting simulation balance, reset the
    // persisted virtual balance so the next start uses the new config value.
    // Also reset accumulated stats since this is effectively a "new session".
    const resetBalance = updates.simulationBalanceSOL != null &&
      updates.simulationBalanceSOL !== botData.simulationBalanceSOL;

    await db.update(bots)
      .set({
        ...updates,
        ...(resetBalance
          ? {
            currentVirtualBalanceLamports: null,
            totalTrades: 0,
            winningTrades: 0,
            totalPnlLamports: 0,
            emergencyStopState: null,
          }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

    const updated = await getUserBot(userId, botId);
    return c.json({ success: true, bot: sanitizeBot(updated!) });
  }
);

/**
 * PUT /bot/:botId/rename
 * Rename a bot (allowed regardless of status).
 */
const renameBotSchema = z.object({
  name: z.string().min(1).max(64),
});

bot.put(
  "/:botId/rename",
  zValidator("json", renameBotSchema),
  async (c) => {
    const userId = c.var.userId;
    const botId = c.req.param("botId");
    validateBotId(botId);
    const { name } = c.req.valid("json");

    const botData = await getUserBot(userId, botId);
    if (!botData) {
      throw createApiError("Bot not found", 404);
    }

    // Enforce unique name per user (case-insensitive, exclude deleted + self)
    const [duplicate] = await db
      .select({ id: bots.id })
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          sql`lower(${bots.name}) = lower(${name})`,
          isNull(bots.deletedAt),
          sql`${bots.botId} != ${botId}`
        )
      );
    if (duplicate) {
      throw createApiError(
        `A bot named "${name}" already exists. Choose a different name.`,
        409
      );
    }

    await db
      .update(bots)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

    const updated = await getUserBot(userId, botId);
    return c.json({ success: true, bot: sanitizeBot(updated!) });
  }
);

/**
 * POST /bot/:botId/start
 * Start the bot (simulation mode for MVP).
 */
bot.post("/:botId/start", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = await getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  if (botData.status === "running") {
    throw createApiError("Bot is already running", 400);
  }

  // Update status to running and clear stale error + emergency stop state
  await db.update(bots)
    .set({
      status: "running",
      lastError: null,
      emergencyStopState: null,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

  // Log start event
  await db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_started",
      details: JSON.stringify({ mode: botData.mode }),
    });

  // S2: Spawn TradingEngine via BotOrchestrator
  try {
    await orchestrator.startBot(botId, userId);
  } catch (error) {
    // Revert status on failure
    await db.update(bots)
      .set({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

    throw createApiError(
      `Failed to start bot: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }

  return c.json({ success: true, status: "running" });
});

/**
 * POST /bot/:botId/stop
 * Stop the bot gracefully.
 */
bot.post("/:botId/stop", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = await getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  if (botData.status === "stopped") {
    throw createApiError("Bot is already stopped", 400);
  }

  await db.update(bots)
    .set({
      status: "stopped",
      updatedAt: new Date(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

  // Log stop event
  await db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_stopped",
      details: JSON.stringify({ reason: "user_requested" }),
    });

  // S2: Stop TradingEngine via BotOrchestrator
  await orchestrator.stopBot(botId);

  return c.json({ success: true, status: "stopped" });
});

/**
 * POST /bot/:botId/emergency
 * Emergency stop — close all positions immediately.
 */
bot.post("/:botId/emergency", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = await getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  // Mark bot as stopped
  await db.update(bots)
    .set({
      status: "stopped",
      lastError: "Emergency stop triggered by user",
      updatedAt: new Date(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

  // Mark all active positions as closing
  await db.update(positions)
    .set({
      status: "closing",
      exitReason: "emergency_stop",
      updatedAt: new Date(),
    })
    .where(
      and(eq(positions.botId, botId), eq(positions.status, "active"))
    );

  // Log
  await db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_stopped",
      details: JSON.stringify({ reason: "emergency_stop" }),
    });

  // S2: Emergency stop via BotOrchestrator
  await orchestrator.emergencyStop(botId);

  return c.json({ success: true, status: "emergency_stopped" });
});

/**
 * POST /bot/:botId/convert-to-live
 * Convert a simulation bot to live mode.
 * Generates an encrypted keypair and resets stats.
 * Bot must be stopped and currently in simulation mode.
 */
bot.post("/:botId/convert-to-live", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = await getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  if (botData.mode === "live") {
    throw createApiError("Bot is already in live mode", 400);
  }

  if (botData.status === "running" || botData.status === "starting" || botData.status === "stopping") {
    throw createApiError("Stop the bot before converting to live mode", 400);
  }

  if (config.SOLANA_NETWORK !== "mainnet-beta") {
    throw createApiError(
      `Live trading requires mainnet (current network: ${config.SOLANA_NETWORK}). ` +
      `Use simulation mode for testing on ${config.SOLANA_NETWORK}.`,
      400
    );
  }

  // Generate encrypted keypair for the live bot
  const { publicKey, encryptedSecret } = generateEncryptedKeypair(
    config.MASTER_ENCRYPTION_KEY
  );

  // Get owner wallet from user record
  const [user] = await db
    .select({ walletAddress: users.walletAddress })
    .from(users)
    .where(eq(users.id, userId));

  await db.update(bots)
    .set({
      mode: "live",
      walletAddress: publicKey,
      encryptedPrivateKey: encryptedSecret,
      ownerWallet: user?.walletAddress ?? null,
      // Reset stats for fresh live start
      totalTrades: 0,
      winningTrades: 0,
      totalPnlLamports: 0,
      currentVirtualBalanceLamports: null,
      emergencyStopState: null,
      status: "stopped",
      updatedAt: new Date(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

  await db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_started",
      details: JSON.stringify({ action: "converted_to_live", previousMode: "simulation" }),
    });

  const updated = await getUserBot(userId, botId);
  return c.json({ success: true, bot: sanitizeBot(updated!) });
});

/**
 * DELETE /bot/:botId
 * Delete a stopped bot and its data.
 */
bot.delete("/:botId", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = await getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  // Allow deletion if bot is stopped or in error state.
  // If running/starting/stopping, stop the engine first then delete.
  if (botData.status === "running" || botData.status === "starting" || botData.status === "stopping") {
    // Auto-stop the engine before deleting
    try {
      await orchestrator.stopBot(botId);
    } catch (_) {
      // Best-effort stop — engine may not be running
    }
    await db.update(bots)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));
  }

  // ── Auto-withdraw on delete ──
  // For live bots, remaining funds stay in the bot wallet.
  // The user should withdraw via /wallet/withdraw/:botId before deleting.
  // We keep the encrypted key so withdrawal is possible even after soft-delete.
  let withdrawResult: { signature?: string; withdrawnSol?: number } = {};

  // Soft-delete: preserve trade history forever.
  await db.update(bots)
    .set({
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

  return c.json({
    success: true,
    deleted: true,
    ...(withdrawResult.signature
      ? {
        fundsReturned: true,
        withdrawSignature: withdrawResult.signature,
        withdrawnSol: withdrawResult.withdrawnSol,
      }
      : { fundsReturned: false }
    ),
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /bot/:botId/decisions — Decision log for a bot
// ═══════════════════════════════════════════════════════════════
bot.get("/:botId/decisions", async (c) => {
  const userId = c.get("userId");
  const botId = c.req.param("botId");
  const scanId = c.req.query("scanId");
  const limit = Math.min(Number(c.req.query("limit") || 50), 100);
  const offset = Number(c.req.query("offset") || 0);

  // Verify bot belongs to user
  const [bot_] = await db
    .select({ botId: bots.botId })
    .from(bots)
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));
  if (!bot_) throw createApiError("Bot not found", 404);

  const conditions = [eq(botDecisions.botId, botId)];
  if (scanId) conditions.push(eq(botDecisions.scanId, scanId));

  const rows = await db
    .select()
    .from(botDecisions)
    .where(and(...conditions))
    .orderBy(desc(botDecisions.id))
    .limit(limit)
    .offset(offset);

  return c.json({ success: true, decisions: rows });
});

export default bot;
