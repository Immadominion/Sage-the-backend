/**
 * Position Routes — Active positions, history, close, and position detail.
 *
 * Endpoints:
 *   GET  /position/active          — all active positions for user
 *   GET  /position/history         — closed positions (paginated)
 *   POST /position/:positionId/close — close a specific position
 *   GET  /position/:positionId     — single position detail
 *   GET  /position/bot/:botId      — positions for a specific bot
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import db from "../db/index.js";
import { positions } from "../db/schema.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import { orchestrator } from "../engine/orchestrator.js";
import { LAMPORTS_PER_SOL } from "../engine/types.js";

const app = new Hono<{ Variables: AuthVariables }>();

// All position routes require auth
app.use("*", requireAuth);

// ═══════════════════════════════════════════════════════════════
// GET /position/active — All active positions across all bots
// ═══════════════════════════════════════════════════════════════

app.get("/active", async (c) => {
  const userId = c.get("userId") as number;

  // Get in-memory live positions from all running bots
  const livePositions = orchestrator.getAllLivePositions(userId);

  // Also get persisted active positions from DB (for bots that may have stopped)
  const dbActive = db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.status, "active")))
    .orderBy(desc(positions.entryTimestamp))
    .all();

  // Merge: prefer live data when available (has real-time price)
  const liveIds = new Set(livePositions.map((p) => p.id));
  const combinedPositions = [
    ...livePositions.map((p) => ({
      positionId: p.id,
      botId: "", // Will be filled from DB if found
      poolAddress: p.poolAddress,
      poolName: p.poolName,
      status: "active" as const,
      entryPrice: p.entryPricePerToken,
      currentPrice: p.currentPricePerToken ?? p.entryPricePerToken,
      entryTimestamp: p.entryTimestamp,
      entryAmountYSol: p.entryAmountY.toNumber() / LAMPORTS_PER_SOL,
      entryScore: p.entryScore,
      mlProbability: p.mlProbability,
      pnlPercent: calculatePnlPercent(
        p.entryPricePerToken,
        p.currentPricePerToken ?? p.entryPricePerToken
      ),
      holdTimeMinutes: (Date.now() - p.entryTimestamp) / (1000 * 60),
      source: "live" as const,
    })),
    // DB-only positions (not currently live in memory)
    ...dbActive
      .filter((row) => !liveIds.has(row.positionId))
      .map((row) => ({
        positionId: row.positionId,
        botId: row.botId,
        poolAddress: row.poolAddress,
        poolName: row.poolName,
        status: row.status,
        entryPrice: row.entryPricePerToken,
        currentPrice: row.currentPricePerToken ?? row.entryPricePerToken,
        entryTimestamp: row.entryTimestamp,
        entryAmountYSol: row.entryAmountYLamports / LAMPORTS_PER_SOL,
        entryScore: row.entryScore,
        mlProbability: row.mlProbability,
        pnlPercent: calculatePnlPercent(
          row.entryPricePerToken ?? "0",
          row.currentPricePerToken ?? row.entryPricePerToken ?? "0"
        ),
        holdTimeMinutes: (Date.now() - row.entryTimestamp) / (1000 * 60),
        source: "db" as const,
      })),
  ];

  return c.json({
    success: true,
    count: combinedPositions.length,
    positions: combinedPositions,
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /position/history — Closed positions (paginated)
// ═══════════════════════════════════════════════════════════════

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  botId: z.string().optional(),
});

app.get("/history", async (c) => {
  const userId = c.get("userId") as number;
  const query = historyQuerySchema.parse(c.req.query());

  const conditions = [
    eq(positions.userId, userId),
    eq(positions.status, "closed"),
  ];
  if (query.botId) {
    conditions.push(eq(positions.botId, query.botId));
  }

  const rows = db
    .select()
    .from(positions)
    .where(and(...conditions))
    .orderBy(desc(positions.exitTimestamp))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const totalCount = db
    .select({ count: positions.id })
    .from(positions)
    .where(and(...conditions))
    .all().length;

  return c.json({
    success: true,
    count: rows.length,
    total: totalCount,
    offset: query.offset,
    limit: query.limit,
    positions: rows.map(formatPositionRow),
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /position/bot/:botId — All positions for a specific bot
// ═══════════════════════════════════════════════════════════════

app.get("/bot/:botId", async (c) => {
  const userId = c.get("userId") as number;
  const botId = c.req.param("botId");

  if (!/^[0-9a-f]{8}$/.test(botId)) {
    throw createApiError("Invalid bot ID format", 400);
  }

  const rows = db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.botId, botId)))
    .orderBy(desc(positions.entryTimestamp))
    .all();

  return c.json({
    success: true,
    count: rows.length,
    positions: rows.map(formatPositionRow),
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /position/:positionId/close — Close a specific active position
// ═══════════════════════════════════════════════════════════════

const closeBodySchema = z.object({
  reason: z.string().optional().default("USER_CLOSE"),
});

app.post("/:positionId/close", async (c) => {
  const userId = c.get("userId") as number;
  const positionId = c.req.param("positionId");
  const body = closeBodySchema.parse(await c.req.json().catch(() => ({})));

  const result = await orchestrator.closePosition(positionId, userId, body.reason);

  if (!result.success) {
    throw createApiError(result.error ?? "Failed to close position", 400);
  }

  return c.json({
    success: true,
    positionId,
    pnlLamports: result.pnlLamports ?? 0,
    pnlSol: (result.pnlLamports ?? 0) / LAMPORTS_PER_SOL,
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /position/:positionId — Single position detail
// ═══════════════════════════════════════════════════════════════

app.get("/:positionId", async (c) => {
  const userId = c.get("userId") as number;
  const positionId = c.req.param("positionId");

  // Try live data first
  const livePositions = orchestrator.getAllLivePositions(userId);
  const livePos = livePositions.find((p) => p.id === positionId);

  // Get DB record
  const row = db
    .select()
    .from(positions)
    .where(
      and(eq(positions.userId, userId), eq(positions.positionId, positionId))
    )
    .get();

  if (!row && !livePos) {
    throw createApiError("Position not found", 404);
  }

  const formatted = row ? formatPositionRow(row) : null;

  // Merge live data on top of DB data
  const result = {
    ...(formatted ?? {}),
    positionId,
    // Live overrides
    ...(livePos
      ? {
          status: "active",
          currentPrice: livePos.currentPricePerToken ?? livePos.entryPricePerToken,
          pnlPercent: calculatePnlPercent(
            livePos.entryPricePerToken,
            livePos.currentPricePerToken ?? livePos.entryPricePerToken
          ),
          holdTimeMinutes: (Date.now() - livePos.entryTimestamp) / (1000 * 60),
          highWaterMarkPercent: livePos.highWaterMarkPercent,
          feesEarnedYSol: livePos.feesEarnedY ? livePos.feesEarnedY.toNumber() / LAMPORTS_PER_SOL : 0,
          entryFeatures: livePos.entryFeatures,
          mlProbability: livePos.mlProbability,
          source: "live",
        }
      : { source: "db" }),
  };

  return c.json({ success: true, position: result });
});

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function formatPositionRow(row: typeof positions.$inferSelect) {
  const entryPrice = row.entryPricePerToken
    ? parseFloat(row.entryPricePerToken)
    : 0;
  const exitPrice = row.exitPricePerToken
    ? parseFloat(row.exitPricePerToken)
    : null;
  const pnlPercent = exitPrice
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : 0;
  const pnlSol = row.realizedPnlLamports
    ? row.realizedPnlLamports / LAMPORTS_PER_SOL
    : 0;

  return {
    positionId: row.positionId,
    botId: row.botId,
    status: row.status,
    poolAddress: row.poolAddress,
    poolName: row.poolName,
    tokenXMint: row.tokenXMint,
    tokenYMint: row.tokenYMint,
    binStep: row.binStep,
    entryPrice: row.entryPricePerToken,
    entryActiveBinId: row.entryActiveBinId,
    entryTimestamp: row.entryTimestamp,
    entryAmountYSol: row.entryAmountYLamports / LAMPORTS_PER_SOL,
    entryScore: row.entryScore,
    mlProbability: row.mlProbability,
    exitPrice: row.exitPricePerToken,
    exitTimestamp: row.exitTimestamp,
    exitReason: row.exitReason,
    pnlPercent,
    pnlSol,
    feesEarnedXSol: (row.feesEarnedXLamports ?? 0) / LAMPORTS_PER_SOL,
    feesEarnedYSol: (row.feesEarnedYLamports ?? 0) / LAMPORTS_PER_SOL,
    holdTimeMinutes: row.exitTimestamp
      ? (row.exitTimestamp - row.entryTimestamp) / (1000 * 60)
      : (Date.now() - row.entryTimestamp) / (1000 * 60),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function calculatePnlPercent(
  entryPrice: string,
  currentPrice: string
): number {
  const entry = parseFloat(entryPrice);
  const current = parseFloat(currentPrice);
  if (entry === 0 || isNaN(entry) || isNaN(current)) return 0;
  return ((current - entry) / entry) * 100;
}

export default app;
