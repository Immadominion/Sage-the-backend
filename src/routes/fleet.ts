/**
 * Fleet routes — public leaderboard of top-performing bots.
 *
 * GET  /fleet/leaderboard   — top bots by PnL (public + own)
 * GET  /fleet/stats         — platform-wide aggregate stats
 * PUT  /fleet/visibility    — toggle bot public visibility
 *
 * Only bots with isPublic=true appear to other users.
 * Users always see their own bots regardless of visibility.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, optionalAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { bots, users } from "../db/schema.js";
import { eq, and, or, sql, desc, isNull } from "drizzle-orm";

const fleet = new Hono<{ Variables: AuthVariables }>();

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const visibilitySchema = z.object({
    botId: z.string().regex(/^[0-9a-f]{8}$/),
    isPublic: z.boolean(),
});

// ═══════════════════════════════════════════════════════════════
// GET /fleet/leaderboard
// ═══════════════════════════════════════════════════════════════

/**
 * Returns top-performing public bots across the platform.
 * Authenticated users also see their own bots (even if private).
 * Sorted by total PnL descending.
 */
fleet.get("/leaderboard", optionalAuth, async (c) => {
    const userId = c.var.userId; // may be undefined if not authenticated
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 50);
    const sortBy = c.req.query("sort") ?? "pnl"; // pnl | winRate | trades

    // Build sort column
    let orderCol;
    switch (sortBy) {
        case "winRate":
            orderCol = sql`CASE WHEN ${bots.totalTrades} > 0
        THEN ${bots.winningTrades}::float / ${bots.totalTrades}
        ELSE 0 END`;
            break;
        case "trades":
            orderCol = bots.totalTrades;
            break;
        default: // pnl
            orderCol = bots.totalPnlLamports;
    }

    // Fetch public bots + own bots (if authenticated)
    const condition = userId
        ? and(
            isNull(bots.deletedAt),
            or(eq(bots.isPublic, true), eq(bots.userId, userId))
        )
        : and(isNull(bots.deletedAt), eq(bots.isPublic, true));

    // Only include bots that have actually traded
    const minTradesCondition = sql`${bots.totalTrades} > 0`;

    const rows = await db
        .select({
            botId: bots.botId,
            name: bots.name,
            mode: bots.mode,
            status: bots.status,
            strategyMode: bots.strategyMode,
            totalTrades: bots.totalTrades,
            winningTrades: bots.winningTrades,
            totalPnlLamports: bots.totalPnlLamports,
            isPublic: bots.isPublic,
            isOwn: userId ? sql<boolean>`${bots.userId} = ${userId}` : sql<boolean>`false`,
            // Owner display name (anonymized if not own)
            ownerName: users.displayName,
            ownerWallet: users.walletAddress,
            // Config highlights for context
            positionSizeSOL: bots.positionSizeSOL,
            profitTargetPercent: bots.profitTargetPercent,
            stopLossPercent: bots.stopLossPercent,
            entryScoreThreshold: bots.entryScoreThreshold,
            lastActivityAt: bots.lastActivityAt,
            createdAt: bots.createdAt,
        })
        .from(bots)
        .innerJoin(users, eq(bots.userId, users.id))
        .where(and(condition, minTradesCondition))
        .orderBy(desc(orderCol))
        .limit(limit);

    // Anonymize other users' wallets (show first 4 + last 4 chars)
    // Never expose full personal wallet — use seal wallet or anonymize.
    const leaderboard = rows.map((row, index) => {
        const walletShort = `${row.ownerWallet.slice(0, 4)}...${row.ownerWallet.slice(-4)}`;

        const winRate =
            row.totalTrades > 0
                ? Math.round((row.winningTrades / row.totalTrades) * 100)
                : 0;
        const pnlSol = row.totalPnlLamports / 1_000_000_000;

        return {
            rank: index + 1,
            botId: row.botId,
            name: row.isOwn ? row.name : `${row.name.slice(0, 12)}${row.name.length > 12 ? "…" : ""}`,
            owner: row.ownerName ?? walletShort,
            ownerWallet: walletShort, // Always anonymized — never expose full wallet on Fleet
            isOwn: row.isOwn,
            mode: row.mode,
            status: row.status,
            strategyMode: row.strategyMode,
            totalTrades: row.totalTrades,
            winRate,
            pnlSol: Math.round(pnlSol * 10000) / 10000,
            // Config preview
            positionSizeSOL: row.positionSizeSOL,
            profitTargetPercent: row.profitTargetPercent,
            stopLossPercent: row.stopLossPercent,
            entryScoreThreshold: row.entryScoreThreshold,
            lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
        };
    });

    return c.json({ success: true, leaderboard });
});

// ═══════════════════════════════════════════════════════════════
// GET /fleet/stats
// ═══════════════════════════════════════════════════════════════

/**
 * Platform-wide aggregate stats (anonymous).
 */
fleet.get("/stats", async (c) => {
    const [stats] = await db
        .select({
            totalBots: sql<number>`count(*)`,
            publicBots: sql<number>`count(*) filter (where ${bots.isPublic} = true)`,
            runningBots: sql<number>`count(*) filter (where ${bots.status} = 'running')`,
            totalTrades: sql<number>`coalesce(sum(${bots.totalTrades}), 0)`,
            totalPnlLamports: sql<number>`coalesce(sum(${bots.totalPnlLamports}), 0)`,
            avgWinRate: sql<number>`coalesce(
        avg(CASE WHEN ${bots.totalTrades} > 0
          THEN ${bots.winningTrades}::float / ${bots.totalTrades}
          ELSE null END
        ), 0)`,
        })
        .from(bots)
        .where(isNull(bots.deletedAt));

    return c.json({
        success: true,
        stats: {
            totalBots: stats.totalBots,
            publicBots: stats.publicBots,
            runningBots: stats.runningBots,
            totalTrades: stats.totalTrades,
            totalPnlSol: Math.round((stats.totalPnlLamports / 1_000_000_000) * 10000) / 10000,
            avgWinRatePercent: Math.round(stats.avgWinRate * 100),
        },
    });
});

// ═══════════════════════════════════════════════════════════════
// PUT /fleet/visibility
// ═══════════════════════════════════════════════════════════════

/**
 * Toggle whether a bot appears on the public leaderboard.
 * Only the bot owner can change visibility.
 */
fleet.put(
    "/visibility",
    requireAuth,
    zValidator("json", visibilitySchema),
    async (c) => {
        const userId = c.var.userId;
        const { botId, isPublic } = c.req.valid("json");

        // Verify ownership
        const [bot] = await db
            .select({ id: bots.id })
            .from(bots)
            .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

        if (!bot) {
            throw createApiError("Bot not found", 404);
        }

        await db
            .update(bots)
            .set({ isPublic, updatedAt: new Date() })
            .where(eq(bots.botId, botId));

        return c.json({ success: true, botId, isPublic });
    }
);

export default fleet;
