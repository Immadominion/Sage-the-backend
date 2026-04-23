/**
 * FCM (Firebase Cloud Messaging) dispatcher.
 *
 * Single source of truth for sending push notifications to user devices
 * registered via `POST /auth/device-token`. Wraps `firebase-admin` with:
 *   • Lazy SDK init from `FIREBASE_SERVICE_ACCOUNT_JSON` (single-line JSON).
 *   • Per-(user, category) cooldown to avoid spam during rapid trade bursts.
 *   • Multi-device fan-out (a user may have iOS + Android).
 *   • Stale-token cleanup: deletes any token the FCM API rejects with
 *     `messaging/registration-token-not-registered` or `…/invalid-argument`.
 *   • Graceful degradation: when env unset, every push silently no-ops
 *     (logged once at boot).
 *
 * Hooked into `eventBus` by `notification-dispatcher.ts`. The cron job in
 * `digest.ts` calls `pushToUser()` directly for daily PnL summaries.
 */

import admin from "firebase-admin";
import { eq, inArray } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { deviceTokens } from "../db/schema.js";
import { logger } from "../middleware/logger.js";

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

let initialised = false;
let enabled = false;

function ensureInit(): boolean {
    if (initialised) return enabled;
    initialised = true;

    const raw = config.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (!raw) {
        logger.warn(
            "FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM dispatcher disabled (pushes will be no-ops)"
        );
        enabled = false;
        return false;
    }

    try {
        const cred = JSON.parse(raw) as admin.ServiceAccount;
        admin.initializeApp({ credential: admin.credential.cert(cred) });
        enabled = true;
        logger.info(
            { projectId: (cred as { project_id?: string }).project_id },
            "FCM dispatcher initialised"
        );
    } catch (err) {
        logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to init firebase-admin from FIREBASE_SERVICE_ACCOUNT_JSON"
        );
        enabled = false;
    }
    return enabled;
}

// ─────────────────────────────────────────────────────────────
// Throttle (per-user, per-category, in-process)
// ─────────────────────────────────────────────────────────────

/**
 * Categories used by callers. The throttle bucket is `${userId}:${category}`.
 * Daily digest is exempt from throttling (it fires at most once per 24h).
 */
export type PushCategory =
    | "position_opened"
    | "position_closed"
    | "fee_charged"
    | "bot_started"
    | "bot_stopped"
    | "engine_error"
    | "daily_digest";

const lastSentAt = new Map<string, number>();

function isThrottled(userId: number, category: PushCategory): boolean {
    if (category === "daily_digest") return false;
    const ttl = config.PUSH_THROTTLE_MS;
    if (ttl <= 0) return false;
    const key = `${userId}:${category}`;
    const last = lastSentAt.get(key) ?? 0;
    if (Date.now() - last < ttl) return true;
    lastSentAt.set(key, Date.now());
    return false;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface PushPayload {
    title: string;
    body: string;
    /** Arbitrary key/value sent in the data channel for in-app routing. */
    data?: Record<string, string>;
}

/**
 * Send a push to every registered device for `userId`. Returns the number
 * of devices that received the push (0 if disabled, throttled, or no
 * devices registered).
 */
export async function pushToUser(
    userId: number,
    category: PushCategory,
    payload: PushPayload
): Promise<number> {
    if (!ensureInit()) return 0;
    if (isThrottled(userId, category)) {
        logger.debug({ userId, category }, "push throttled");
        return 0;
    }

    const rows = await db
        .select({ id: deviceTokens.id, token: deviceTokens.token })
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId));

    if (rows.length === 0) return 0;

    const tokens = rows.map((r) => r.token);
    const message: admin.messaging.MulticastMessage = {
        tokens,
        notification: { title: payload.title, body: payload.body },
        data: { category, ...(payload.data ?? {}) },
        android: { priority: "high" },
        apns: {
            payload: { aps: { sound: "default" } },
        },
    };

    try {
        const res = await admin.messaging().sendEachForMulticast(message);

        // Cleanup invalid/expired tokens.
        const dead: string[] = [];
        res.responses.forEach((r: admin.messaging.SendResponse, i: number) => {
            if (r.success) return;
            const code = r.error?.code ?? "";
            if (
                code === "messaging/registration-token-not-registered" ||
                code === "messaging/invalid-argument" ||
                code === "messaging/invalid-registration-token"
            ) {
                const tok = tokens[i];
                if (tok) dead.push(tok);
            } else {
                logger.warn(
                    { userId, code, msg: r.error?.message },
                    "FCM send failed for one device"
                );
            }
        });

        if (dead.length > 0) {
            try {
                await db.delete(deviceTokens).where(inArray(deviceTokens.token, dead));
                logger.info(
                    { userId, count: dead.length },
                    "Pruned stale device tokens"
                );
            } catch (err) {
                logger.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    "Failed to prune stale device tokens"
                );
            }
        }

        return res.successCount;
    } catch (err) {
        logger.error(
            { err: err instanceof Error ? err.message : String(err), userId, category },
            "FCM dispatch failed"
        );
        return 0;
    }
}

/**
 * Test-only: clear the throttle map. Not exported in any router.
 */
export function _resetThrottle(): void {
    lastSentAt.clear();
}
