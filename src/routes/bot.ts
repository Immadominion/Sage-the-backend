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
 * DELETE /bot/:botId         — delete stopped bot
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import crypto from "node:crypto";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { bots, positions, tradeLog } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { orchestrator } from "../engine/orchestrator.js";
import { LAMPORTS_PER_SOL } from "../engine/types.js";

const bot = new Hono<{ Variables: AuthVariables }>();

// All bot routes require authentication
bot.use("/*", requireAuth);

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const createBotSchema = z.object({
  name: z.string().min(1).max(64).default("My Bot"),
  mode: z.enum(["simulation", "live"]).default("simulation"),
  strategyMode: z.enum(["rule-based", "sage-ai", "both"]).default("rule-based"),
  // Entry criteria
  entryScoreThreshold: z.number().positive().default(150),
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
});

const updateBotConfigSchema = createBotSchema.partial().omit({ mode: true });

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

function getUserBot(userId: number, botId: string) {
  return db
    .select()
    .from(bots)
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
    .get();
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

  // Limit bots per user
  const existingBots = db
    .select({ count: sql<number>`count(*)` })
    .from(bots)
    .where(eq(bots.userId, userId))
    .get();

  if (existingBots && existingBots.count >= 10) {
    throw createApiError("Maximum 10 bots per user", 400);
  }

  const botId = generateBotId();

  db.insert(bots)
    .values({
      botId,
      userId,
      name: body.name,
      mode: body.mode,
      strategyMode: body.strategyMode,
      entryScoreThreshold: body.entryScoreThreshold,
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
    })
    .run();

  // Log the creation
  db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_started", // reuse closest enum value
      details: JSON.stringify({ action: "created", config: body }),
    })
    .run();

  const created = getUserBot(userId, botId);

  return c.json({ success: true, bot: created }, 201);
});

/**
 * GET /bot/list
 * List all bots for the authenticated user.
 */
bot.get("/list", async (c) => {
  const userId = c.var.userId;

  const userBots = db
    .select()
    .from(bots)
    .where(eq(bots.userId, userId))
    .all();

  return c.json({ success: true, bots: userBots });
});

/**
 * GET /bot/:botId
 * Get bot detail + stats including active positions count.
 */
bot.get("/:botId", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  // Count active positions
  const activePositions = db
    .select({ count: sql<number>`count(*)` })
    .from(positions)
    .where(
      and(
        eq(positions.botId, botId),
        eq(positions.status, "active")
      )
    )
    .get();

  // S2: Include live engine stats if bot is running
  const engineStats = orchestrator.getEngineStats(botId);
  const performanceSummary = orchestrator.getPerformanceSummary(botId);
  const livePositions = orchestrator.getActivePositions(botId);

  return c.json({
    success: true,
    bot: botData,
    activePositionCount: activePositions?.count ?? 0,
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
 * Update bot configuration (only when stopped).
 */
bot.put(
  "/:botId/config",
  zValidator("json", updateBotConfigSchema),
  async (c) => {
    const userId = c.var.userId;
    const botId = c.req.param("botId");
    validateBotId(botId);
    const updates = c.req.valid("json");

    const botData = getUserBot(userId, botId);
    if (!botData) {
      throw createApiError("Bot not found", 404);
    }

    if (botData.status !== "stopped") {
      throw createApiError(
        "Cannot update config while bot is running. Stop it first.",
        400
      );
    }

    db.update(bots)
      .set({ ...updates, updatedAt: new Date().toISOString() })
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
      .run();

    const updated = getUserBot(userId, botId);
    return c.json({ success: true, bot: updated });
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

  const botData = getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  if (botData.status === "running") {
    throw createApiError("Bot is already running", 400);
  }

  // Update status to running
  db.update(bots)
    .set({
      status: "running",
      lastActivityAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
    .run();

  // Log start event
  db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_started",
      details: JSON.stringify({ mode: botData.mode }),
    })
    .run();

  // S2: Spawn TradingEngine via BotOrchestrator
  try {
    await orchestrator.startBot(botId, userId);
  } catch (error) {
    // Revert status on failure
    db.update(bots)
      .set({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
      .run();

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

  const botData = getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  if (botData.status === "stopped") {
    throw createApiError("Bot is already stopped", 400);
  }

  db.update(bots)
    .set({
      status: "stopped",
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
    .run();

  // Log stop event
  db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_stopped",
      details: JSON.stringify({ reason: "user_requested" }),
    })
    .run();

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

  const botData = getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  // Mark bot as stopped
  db.update(bots)
    .set({
      status: "stopped",
      lastError: "Emergency stop triggered by user",
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
    .run();

  // Mark all active positions as closing
  db.update(positions)
    .set({
      status: "closing",
      exitReason: "emergency_stop",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(positions.botId, botId), eq(positions.status, "active"))
    )
    .run();

  // Log
  db.insert(tradeLog)
    .values({
      botId,
      userId,
      event: "bot_stopped",
      details: JSON.stringify({ reason: "emergency_stop" }),
    })
    .run();

  // S2: Emergency stop via BotOrchestrator
  await orchestrator.emergencyStop(botId);

  return c.json({ success: true, status: "emergency_stopped" });
});

/**
 * DELETE /bot/:botId
 * Delete a stopped bot and its data.
 */
bot.delete("/:botId", async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const botData = getUserBot(userId, botId);
  if (!botData) {
    throw createApiError("Bot not found", 404);
  }

  if (botData.status !== "stopped") {
    throw createApiError(
      "Cannot delete a running bot. Stop it first.",
      400
    );
  }

  // Delete in order (foreign key safety)
  db.delete(tradeLog)
    .where(eq(tradeLog.botId, botId))
    .run();
  db.delete(positions)
    .where(eq(positions.botId, botId))
    .run();
  db.delete(bots)
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
    .run();

  return c.json({ success: true, deleted: true });
});

export default bot;
