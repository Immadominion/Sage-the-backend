/**
 * Events route — Server-Sent Events (SSE) streaming for real-time updates.
 *
 * GET /events/stream — SSE stream of all bot events for the authenticated user
 *
 * SSE is preferred over WebSocket for Hono because:
 *  - Built-in reconnection in EventSource API
 *  - Works through HTTP/1.1 proxies
 *  - Simpler auth (JWT in query param or header)
 *  - No need for ws library
 *
 * Flutter client uses `web_socket_channel` or `eventsource` package.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { eventBus } from "../engine/event-bus.js";
import { logger } from "../middleware/logger.js";
import type { BotEvent } from "../engine/types.js";

const log = logger.child({ module: "sse" });

const events = new Hono<{ Variables: AuthVariables }>();

// All event routes require authentication
events.use("/*", requireAuth);

// ─── Per-user concurrent stream cap ───
// Each EventSource holds an open HTTP/1.1 connection; without this cap a
// single compromised account can exhaust the upstream connection pool.
const MAX_STREAMS_PER_USER = 5;
const MAX_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const activeStreams = new Map<number, number>();

function tryAcquireStreamSlot(userId: number): boolean {
  const current = activeStreams.get(userId) ?? 0;
  if (current >= MAX_STREAMS_PER_USER) return false;
  activeStreams.set(userId, current + 1);
  return true;
}

function releaseStreamSlot(userId: number): void {
  const current = activeStreams.get(userId) ?? 0;
  if (current <= 1) activeStreams.delete(userId);
  else activeStreams.set(userId, current - 1);
}

// ═══════════════════════════════════════════════════════════════
// SSE Stream — All bot events for the authenticated user
// ═══════════════════════════════════════════════════════════════

events.get("/stream", async (c) => {
  const userId = c.var.userId;

  if (!tryAcquireStreamSlot(userId)) {
    log.warn({ userId, cap: MAX_STREAMS_PER_USER }, "SSE stream cap reached");
    return c.json(
      { error: { message: "Too many concurrent event streams", statusCode: 429 } },
      429
    );
  }

  log.info({ userId }, "SSE client connected");

  return streamSSE(c, async (stream) => {
    // Send initial heartbeat
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        userId,
        timestamp: Date.now(),
        message: "Connected to Aura event stream",
      }),
    });

    // Subscribe to all bot events for this user
    const unsubscribe = eventBus.subscribeUser(userId, (event: BotEvent) => {
      stream
        .writeSSE({
          event: event.type,
          data: JSON.stringify({
            botId: event.botId,
            timestamp: event.timestamp,
            ...event.data,
          }),
        })
        .catch((err) => {
          log.debug(
            { userId, err: err instanceof Error ? err.message : String(err) },
            "SSE write failed (client likely disconnected)"
          );
        });
    });

    // Heartbeat every 30s to keep the connection alive
    const heartbeat = setInterval(() => {
      stream
        .writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ timestamp: Date.now() }),
        })
        .catch(() => {
          // Connection died — cleanup will happen in onAbort
        });
    }, 30_000);

    // Hard idle timeout — server-side cap so abandoned mobile streams
    // do not pin a connection forever even if heartbeats keep flowing.
    const idleTimer = setTimeout(() => {
      log.info({ userId, maxIdleMs: MAX_IDLE_MS }, "SSE idle timeout reached");
      stream.abort();
    }, MAX_IDLE_MS);

    // Cleanup on disconnect
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      log.info({ userId }, "SSE client disconnected");
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(idleTimer);
      releaseStreamSlot(userId);
    };
    stream.onAbort(cleanup);

    // Keep the stream open indefinitely
    // The stream closes when the client disconnects (onAbort fires)
    await new Promise(() => { });
  });
});

export default events;
