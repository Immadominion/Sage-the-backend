/**
 * Analytics routes — platform-wide metrics for monitoring, marketing, and ops.
 *
 * GET  /analytics/platform   — comprehensive platform metrics
 * GET  /analytics/errors     — recent error events from trade log
 * GET  /analytics/growth     — user & bot growth over time
 */

import { Hono } from "hono";
import db from "../db/index.js";
import { users, bots, positions, tradeLog } from "../db/schema.js";
import { sql, eq, isNull, and, gte, desc } from "drizzle-orm";

const analytics = new Hono();

// ═══════════════════════════════════════════════════════════════
// GET /analytics/platform — Comprehensive platform snapshot
// ═══════════════════════════════════════════════════════════════

analytics.get("/platform", async (c) => {
    const now = new Date();
    const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // User metrics
    const [userStats] = await db
        .select({
            totalUsers: sql<number>`count(*)`,
            setupComplete: sql<number>`count(*) filter (where ${users.setupCompleted} = true)`,
            last24h: sql<number>`count(*) filter (where ${users.createdAt} >= ${h24ago})`,
            last7d: sql<number>`count(*) filter (where ${users.createdAt} >= ${d7ago})`,
            last30d: sql<number>`count(*) filter (where ${users.createdAt} >= ${d30ago})`,
        })
        .from(users);

    // Bot metrics
    const [botStats] = await db
        .select({
            totalBots: sql<number>`count(*)`,
            running: sql<number>`count(*) filter (where ${bots.status} = 'running')`,
            stopped: sql<number>`count(*) filter (where ${bots.status} = 'stopped')`,
            errorState: sql<number>`count(*) filter (where ${bots.status} = 'error')`,
            simulation: sql<number>`count(*) filter (where ${bots.mode} = 'simulation')`,
            live: sql<number>`count(*) filter (where ${bots.mode} = 'live')`,
            totalTrades: sql<number>`coalesce(sum(${bots.totalTrades}), 0)`,
            totalWins: sql<number>`coalesce(sum(${bots.winningTrades}), 0)`,
            totalPnlLamports: sql<number>`coalesce(sum(${bots.totalPnlLamports}), 0)`,
        })
        .from(bots)
        .where(isNull(bots.deletedAt));

    // Position metrics
    const [posStats] = await db
        .select({
            totalPositions: sql<number>`count(*)`,
            active: sql<number>`count(*) filter (where ${positions.status} = 'active')`,
            closed: sql<number>`count(*) filter (where ${positions.status} = 'closed')`,
            totalRealizedPnl: sql<number>`coalesce(sum(${positions.realizedPnlLamports}), 0)`,
            totalFeesX: sql<number>`coalesce(sum(${positions.feesEarnedXLamports}), 0)`,
            totalFeesY: sql<number>`coalesce(sum(${positions.feesEarnedYLamports}), 0)`,
            totalTxCosts: sql<number>`coalesce(sum(${positions.txCostLamports}), 0)`,
            avgHoldMinutes: sql<number>`coalesce(avg(
        case when ${positions.exitTimestamp} is not null
          then (${positions.exitTimestamp} - ${positions.entryTimestamp}) / 60000.0
          else null end
      ), 0)`,
        })
        .from(positions);

    // Recent errors (last 24h)
    const [errorCount] = await db
        .select({
            count: sql<number>`count(*)`,
        })
        .from(tradeLog)
        .where(
            and(eq(tradeLog.event, "bot_error"), gte(tradeLog.timestamp, h24ago))
        );

    const LAMPORTS = 1_000_000_000;

    return c.json({
        success: true,
        timestamp: now.toISOString(),
        users: {
            total: userStats.totalUsers,
            setupComplete: userStats.setupComplete,
            new24h: userStats.last24h,
            new7d: userStats.last7d,
            new30d: userStats.last30d,
        },
        bots: {
            total: botStats.totalBots,
            running: botStats.running,
            stopped: botStats.stopped,
            errorState: botStats.errorState,
            byMode: {
                simulation: botStats.simulation,
                live: botStats.live,
            },
        },
        trading: {
            totalTrades: botStats.totalTrades,
            totalWins: botStats.totalWins,
            winRate:
                botStats.totalTrades > 0
                    ? Math.round((botStats.totalWins / botStats.totalTrades) * 10000) / 100
                    : 0,
            totalPnlSOL: Math.round((botStats.totalPnlLamports / LAMPORTS) * 10000) / 10000,
        },
        positions: {
            total: posStats.totalPositions,
            active: posStats.active,
            closed: posStats.closed,
            realizedPnlSOL:
                Math.round((posStats.totalRealizedPnl / LAMPORTS) * 10000) / 10000,
            totalFeesEarnedSOL:
                Math.round(
                    ((posStats.totalFeesX + posStats.totalFeesY) / LAMPORTS) * 10000
                ) / 10000,
            totalTxCostsSOL:
                Math.round((posStats.totalTxCosts / LAMPORTS) * 10000) / 10000,
            avgHoldMinutes: Math.round(posStats.avgHoldMinutes),
        },
        errors: {
            last24h: errorCount.count,
        },
    });
});

// ═══════════════════════════════════════════════════════════════
// GET /analytics/errors — Recent error events
// ═══════════════════════════════════════════════════════════════

analytics.get("/errors", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

    const errors = await db
        .select({
            id: tradeLog.id,
            botId: tradeLog.botId,
            event: tradeLog.event,
            details: tradeLog.details,
            timestamp: tradeLog.timestamp,
        })
        .from(tradeLog)
        .where(eq(tradeLog.event, "bot_error"))
        .orderBy(desc(tradeLog.timestamp))
        .limit(limit);

    return c.json({
        success: true,
        count: errors.length,
        errors: errors.map((e) => ({
            id: e.id,
            botId: e.botId,
            details: e.details ? JSON.parse(e.details) : null,
            timestamp: e.timestamp.toISOString(),
        })),
    });
});

// ═══════════════════════════════════════════════════════════════
// GET /analytics/growth — User & bot growth over time
// ═══════════════════════════════════════════════════════════════

analytics.get("/growth", async (c) => {
    const days = Math.min(Number(c.req.query("days") ?? 30), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Daily signups
    const userGrowth = await db
        .select({
            date: sql<string>`date_trunc('day', ${users.createdAt})::date::text`.as(
                "date"
            ),
            count: sql<number>`count(*)`,
        })
        .from(users)
        .where(gte(users.createdAt, since))
        .groupBy(sql`date_trunc('day', ${users.createdAt})`)
        .orderBy(sql`date_trunc('day', ${users.createdAt})`);

    // Daily bots created
    const botGrowth = await db
        .select({
            date: sql<string>`date_trunc('day', ${bots.createdAt})::date::text`.as(
                "date"
            ),
            count: sql<number>`count(*)`,
        })
        .from(bots)
        .where(and(gte(bots.createdAt, since), isNull(bots.deletedAt)))
        .groupBy(sql`date_trunc('day', ${bots.createdAt})`)
        .orderBy(sql`date_trunc('day', ${bots.createdAt})`);

    // Daily positions opened
    const positionGrowth = await db
        .select({
            date: sql<string>`date_trunc('day', ${positions.createdAt})::date::text`.as(
                "date"
            ),
            count: sql<number>`count(*)`,
        })
        .from(positions)
        .where(gte(positions.createdAt, since))
        .groupBy(sql`date_trunc('day', ${positions.createdAt})`)
        .orderBy(sql`date_trunc('day', ${positions.createdAt})`);

    return c.json({
        success: true,
        days,
        users: userGrowth,
        bots: botGrowth,
        positions: positionGrowth,
    });
});

export default analytics;
