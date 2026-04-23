/**
 * Daily PnL digest cron.
 *
 * Once per 24h (configurable via `DIGEST_HOUR_UTC`), sweeps all positions
 * closed in the last 24h grouped by user, then sends a summary push:
 *
 *   "Aura today: +0.42 SOL across 7 trades (5W/2L)"
 *
 * Notes:
 *   • Users with zero trades in the window are skipped (no spam on idle
 *     accounts).
 *   • Throttling in `fcm.ts` is bypassed for `daily_digest` so the digest
 *     always fires even if a per-trade push happened in the cooldown.
 *   • Implementation uses `setInterval` rather than node-cron — sufficient
 *     for a single Railway replica. Move to a real scheduler if we ever
 *     scale horizontally.
 */

import { and, eq, gte, sql } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { positions } from "../db/schema.js";
import { LAMPORTS_PER_SOL } from "../engine/types.js";
import { logger } from "../middleware/logger.js";
import { pushToUser } from "./fcm.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

let timer: NodeJS.Timeout | null = null;

/**
 * Run a single digest sweep. Exported for tests / manual triggers.
 */
export async function runDigestOnce(): Promise<{
    usersNotified: number;
    totalPushes: number;
}> {
    const sinceMs = Date.now() - ONE_DAY_MS;

    // Aggregate per-user 24h closed-position stats. We compute everything
    // in SQL to avoid pulling potentially-large position rows into Node.
    const rows = await db
        .select({
            userId: positions.userId,
            tradeCount: sql<number>`COUNT(*)::int`,
            wins: sql<number>`SUM(CASE WHEN ${positions.realizedPnlLamports} > 0 THEN 1 ELSE 0 END)::int`,
            totalPnlLamports: sql<number>`COALESCE(SUM(${positions.realizedPnlLamports}), 0)::bigint`,
        })
        .from(positions)
        .where(
            and(
                eq(positions.status, "closed"),
                gte(positions.exitTimestamp, sinceMs)
            )
        )
        .groupBy(positions.userId);

    let usersNotified = 0;
    let totalPushes = 0;

    for (const r of rows) {
        if (!r.tradeCount || r.tradeCount === 0) continue;

        // Drizzle returns bigint columns as string under pg-node.
        const lamports = Number(r.totalPnlLamports);
        const pnlSol = lamports / LAMPORTS_PER_SOL;
        const losses = r.tradeCount - r.wins;
        const sign = pnlSol >= 0 ? "+" : "";

        const sent = await pushToUser(r.userId, "daily_digest", {
            title: pnlSol >= 0 ? "Aura today" : "Aura — today's recap",
            body: `${sign}${pnlSol.toFixed(4)} SOL across ${r.tradeCount} trade${r.tradeCount === 1 ? "" : "s"
                } (${r.wins}W/${losses}L)`,
            data: {
                pnlSol: pnlSol.toString(),
                tradeCount: r.tradeCount.toString(),
            },
        });
        if (sent > 0) {
            usersNotified += 1;
            totalPushes += sent;
        }
    }

    logger.info({ usersNotified, totalPushes, rows: rows.length }, "daily digest swept");
    return { usersNotified, totalPushes };
}

function msUntilNextRun(hourUtc: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(hourUtc, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime() - now.getTime();
}

/**
 * Start the daily digest cron. No-op if already started or disabled.
 */
export function startDigestCron(): void {
    if (timer) return;
    const hour = config.DIGEST_HOUR_UTC;
    if (hour < 0) {
        logger.info("Daily PnL digest disabled (DIGEST_HOUR_UTC=-1)");
        return;
    }

    const fire = () => {
        runDigestOnce().catch((err) => {
            logger.error(
                { err: err instanceof Error ? err.message : String(err) },
                "daily digest failed"
            );
        });
    };

    // First fire at the next configured hour, then every 24h.
    const initialDelay = msUntilNextRun(hour);
    setTimeout(() => {
        fire();
        timer = setInterval(fire, ONE_DAY_MS);
        timer.unref();
    }, initialDelay).unref();

    logger.info(
        { hourUtc: hour, firstRunInMin: Math.round(initialDelay / 60000) },
        "Daily PnL digest cron scheduled"
    );
}

export function stopDigestCron(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
