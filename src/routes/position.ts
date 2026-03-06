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
import { PublicKey } from "@solana/web3.js";
import db from "../db/index.js";
import { positions } from "../db/schema.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import { orchestrator } from "../engine/orchestrator.js";
import { LAMPORTS_PER_SOL } from "../engine/types.js";
import { getConnection } from "../services/solana.js";

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
  const dbActive = await db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.status, "active")))
    .orderBy(desc(positions.entryTimestamp));

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

  const rows = await db
    .select()
    .from(positions)
    .where(and(...conditions))
    .orderBy(desc(positions.exitTimestamp))
    .limit(query.limit)
    .offset(query.offset);

  const allMatchingRows = await db
    .select({ count: positions.id })
    .from(positions)
    .where(and(...conditions));
  const totalCount = allMatchingRows.length;

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

  const rows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.botId, botId)))
    .orderBy(desc(positions.entryTimestamp));

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
  const [row] = await db
    .select()
    .from(positions)
    .where(
      and(eq(positions.userId, userId), eq(positions.positionId, positionId))
    );

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

// ═══════════════════════════════════════════════════════════════
// POST /position/reconcile — Compare DB positions vs on-chain state
//
// Finds active positions whose on-chain account has been closed
// (e.g. the app crashed mid-close, or the user closed via a
// different wallet tool). Marks them as resolved so they don't
// show as phantom open positions forever.
// ═══════════════════════════════════════════════════════════════

app.post("/reconcile", async (c) => {
  const userId = c.get("userId") as number;

  // 1. Fetch all "active" positions for this user that have an on-chain key
  const activeRows = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.status, "active")
      )
    );

  if (activeRows.length === 0) {
    return c.json({ success: true, reconciled: 0, orphaned: 0, details: [] });
  }

  const connection = getConnection();
  const details: Array<{
    positionId: string;
    poolName: string;
    action: "closed" | "orphaned" | "ok";
  }> = [];

  let reconciledCount = 0;
  let orphanedCount = 0;

  // 2. Check which positions have on-chain keys we can verify
  const withOnChainKey = activeRows.filter((r) => r.onChainPositionKey);
  const withoutOnChainKey = activeRows.filter((r) => !r.onChainPositionKey);

  // 3. Batch-fetch account info for all on-chain keys (efficient RPC call)
  if (withOnChainKey.length > 0) {
    const pubkeys = withOnChainKey.map(
      (r) => new PublicKey(r.onChainPositionKey!)
    );

    const accounts = await connection.getMultipleAccountsInfo(pubkeys);

    for (let i = 0; i < withOnChainKey.length; i++) {
      const row = withOnChainKey[i];
      const accountInfo = accounts[i];

      if (!accountInfo) {
        // Account doesn't exist on-chain — position was closed outside our tracking
        await db
          .update(positions)
          .set({
            status: "closed",
            exitTimestamp: Date.now(),
            exitReason: "RECONCILED_MISSING",
            updatedAt: new Date(),
          })
          .where(eq(positions.positionId, row.positionId));

        reconciledCount++;
        details.push({
          positionId: row.positionId,
          poolName: row.poolName,
          action: "closed",
        });
      } else {
        // Account exists on-chain — check if a bot is actively tracking it
        const isTracked = orchestrator
          .getAllLivePositions(userId)
          .some((p) => p.id === row.positionId);

        if (!isTracked) {
          // On-chain but no bot watching it → orphaned
          await db
            .update(positions)
            .set({
              status: "orphaned",
              updatedAt: new Date(),
            })
            .where(eq(positions.positionId, row.positionId));

          orphanedCount++;
          details.push({
            positionId: row.positionId,
            poolName: row.poolName,
            action: "orphaned",
          });
        } else {
          details.push({
            positionId: row.positionId,
            poolName: row.poolName,
            action: "ok",
          });
        }
      }
    }
  }

  // 4. Positions without on-chain key — check if bot is tracking
  for (const row of withoutOnChainKey) {
    const isTracked = orchestrator
      .getAllLivePositions(userId)
      .some((p) => p.id === row.positionId);

    if (!isTracked) {
      // No on-chain key and no bot tracking → likely a simulation position
      // that got stuck. Mark orphaned.
      await db
        .update(positions)
        .set({
          status: "orphaned",
          updatedAt: new Date(),
        })
        .where(eq(positions.positionId, row.positionId));

      orphanedCount++;
      details.push({
        positionId: row.positionId,
        poolName: row.poolName,
        action: "orphaned",
      });
    } else {
      details.push({
        positionId: row.positionId,
        poolName: row.poolName,
        action: "ok",
      });
    }
  }

  return c.json({
    success: true,
    reconciled: reconciledCount,
    orphaned: orphanedCount,
    total: activeRows.length,
    details,
  });
});

export default app;
