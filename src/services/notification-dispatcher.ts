/**
 * Notification dispatcher.
 *
 * Subscribes the FCM dispatcher to relevant `eventBus` events. Imported
 * once at boot from `index.ts`; never instantiated elsewhere.
 *
 * Wired events:
 *   • position:opened  → "Position opened" with pool + score
 *   • position:closed  → "Position closed" with PnL ± SOL
 *   • fee:charged      → "Fee charged" with lamports/SOL amount
 *   • engine:started   → "Bot started"
 *   • engine:stopped   → "Bot stopped"
 *   • engine:error     → "Bot stopped" with redacted error message
 *
 * Per-event payloads come from `orchestrator.ts:emitBotEvent` calls; see
 * those callsites for the canonical shape. Pushes here are best-effort —
 * any throw is swallowed so a notification failure can never break the
 * trading engine.
 */

import { eventBus } from "../engine/event-bus.js";
import { logger } from "../middleware/logger.js";
import { pushToUser } from "./fcm.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

let started = false;

export function startNotificationDispatcher(): void {
    if (started) return;
    started = true;

    // ── position:opened ──
    eventBus.on("position:opened", (e) => {
        const pool = String(e.data.pool ?? "pool");
        const score = typeof e.data.score === "number" ? e.data.score : null;
        void pushToUser(e.userId, "position_opened", {
            title: "Position opened",
            body: score !== null
                ? `Aura entered ${pool} (score ${score.toFixed(2)})`
                : `Aura entered ${pool}`,
            data: { botId: e.botId, positionId: String(e.data.positionId ?? "") },
        }).catch((err) => {
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "position_opened push failed"
            );
        });
    });

    // ── position:closed ──
    eventBus.on("position:closed", (e) => {
        const pool = String(e.data.pool ?? "pool");
        const pnl = typeof e.data.pnlSol === "number" ? e.data.pnlSol : 0;
        const sign = pnl >= 0 ? "+" : "";
        const result = String(e.data.result ?? "");
        void pushToUser(e.userId, "position_closed", {
            title: result === "WIN" ? "Position closed — win" : "Position closed",
            body: `${pool}: ${sign}${pnl.toFixed(4)} SOL`,
            data: {
                botId: e.botId,
                positionId: String(e.data.positionId ?? ""),
                pnlSol: pnl.toString(),
            },
        }).catch((err) => {
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "position_closed push failed"
            );
        });
    });

    // ── fee:charged ──
    eventBus.on("fee:charged", (e) => {
        const lamports = typeof e.data.feeLamports === "number" ? e.data.feeLamports : 0;
        const sol = lamports / LAMPORTS_PER_SOL;
        void pushToUser(e.userId, "fee_charged", {
            title: "Fee charged",
            body: `-${sol.toFixed(6)} SOL`,
            data: {
                botId: e.botId,
                feeLamports: String(lamports),
            },
        }).catch((err) => {
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "fee_charged push failed"
            );
        });
    });

    // ── engine:started ──
    eventBus.on("engine:started", (e) => {
        void pushToUser(e.userId, "bot_started", {
            title: "Bot started",
            body: "Trading engine is running",
            data: { botId: e.botId },
        }).catch((err) => {
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "bot_started push failed"
            );
        });
    });

    // ── engine:stopped ──
    eventBus.on("engine:stopped", (e) => {
        void pushToUser(e.userId, "bot_stopped", {
            title: "Bot stopped",
            body: "Trading engine stopped",
            data: { botId: e.botId },
        }).catch((err) => {
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "bot_stopped push failed"
            );
        });
    });

    // ── engine:error ──
    eventBus.on("engine:error", (e) => {
        const errMsg = String(e.data.error ?? "Unknown error").slice(0, 140);
        void pushToUser(e.userId, "engine_error", {
            title: "Bot stopped",
            body: errMsg,
            data: { botId: e.botId },
        }).catch((err) => {
            logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "engine_error push failed"
            );
        });
    });

    logger.info("Notification dispatcher subscribed to eventBus");
}
