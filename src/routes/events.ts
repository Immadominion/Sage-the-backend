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

// ═══════════════════════════════════════════════════════════════
// SSE Stream — All bot events for the authenticated user
// ═══════════════════════════════════════════════════════════════

events.get("/stream", async (c) => {
  const userId = c.var.userId;
  log.info({ userId }, "SSE client connected");

  return streamSSE(c, async (stream) => {
    // Send initial heartbeat
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        userId,
        timestamp: Date.now(),
        message: "Connected to Sage event stream",
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

    // Cleanup on disconnect
    stream.onAbort(() => {
      log.info({ userId }, "SSE client disconnected");
      unsubscribe();
      clearInterval(heartbeat);
    });

    // Keep the stream open indefinitely
    // The stream closes when the client disconnects (onAbort fires)
    await new Promise(() => {});
  });
});

export default events;
