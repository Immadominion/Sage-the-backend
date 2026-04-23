/**
 * Aura Backend — Main entry point
 *
 * Hono on Node.js server providing REST API for the Aura mobile app.
 *
 * Architecture:
 *  - Auth:    SIWS (Sign-In With Solana) → JWT
 *  - Routes:  /auth, /wallet, /bot, /strategy, /health
 *  - DB:      PostgreSQL via Drizzle ORM (production-grade with connection pooling)
 *  - Guards:  JWT validation, Zod input validation, rate limiting
 *  - Security: CORS lockdown, secure headers, body size limits, request IDs
 */

// Plain stdout heartbeats — these survive any logger/transport configuration
// and show up in Railway's deploy log stream so we can see how far boot got
// before any failure.
process.stdout.write(`[boot] aura-backend starting (pid=${process.pid}, node=${process.version})\n`);
process.on("uncaughtException", (err) => {
  process.stdout.write(`[boot] FATAL uncaughtException: ${err?.stack ?? err}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stdout.write(`[boot] FATAL unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
});

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requestId } from "hono/request-id";
import { bodyLimit } from "hono/body-limit";
import { logger as honoLogger } from "hono/logger";

import config from "./config.js";
process.stdout.write(`[boot] config loaded (PORT=${config.PORT}, NODE_ENV=${config.NODE_ENV})\n`);

import { errorHandler } from "./middleware/error.js";
import { logger } from "./middleware/logger.js";
import { globalRateLimit, authRateLimit, botLifecycleRateLimit, readRateLimit, mlRateLimit, externalApiRateLimit } from "./middleware/rate-limit.js";
import { requireAdmin } from "./middleware/admin.js";

// Routes
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import walletRoutes from "./routes/wallet.js";
import botRoutes from "./routes/bot.js";
import strategyRoutes from "./routes/strategy.js";
import mlRoutes from "./routes/ml.js";
import eventsRoutes from "./routes/events.js";
import positionRoutes from "./routes/position.js";
import aiRoutes from "./routes/ai.js";
import fleetRoutes from "./routes/fleet.js";
import analyticsRoutes from "./routes/analytics.js";
import lpAgentRoutes from "./routes/lp-agent.js";
process.stdout.write(`[boot] route imports complete\n`);

// Engine
import { orchestrator } from "./engine/orchestrator.js";
import { closeDatabase, runMigrations } from "./db/index.js";

// Notifications
import { startNotificationDispatcher } from "./services/notification-dispatcher.js";
import { startDigestCron, stopDigestCron } from "./services/digest.js";
process.stdout.write(`[boot] engine + service imports complete\n`);

// ═══════════════════════════════════════════════════════════════
// App
// ═══════════════════════════════════════════════════════════════

const app = new Hono();

// ── Security: Request ID for tracing ──
app.use("*", requestId());

// ── Security: Secure HTTP headers ──
app.use("*", secureHeaders());

// ── Security: CORS — locked to configured origins ──
// Production startup gate (config.ts) guarantees CORS_ORIGINS is never `*`
// in production, so the wildcard branch only ever runs in dev.
function parseCorsOrigins(raw: string): string | string[] {
  if (raw === "*") return "*";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => {
      try {
        // Round-trip through URL to normalise + reject malformed entries
        const u = new URL(s);
        return u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost");
      } catch {
        return false;
      }
    })
    .map((s) => new URL(s).origin);
  return list;
}

const corsOrigins = parseCorsOrigins(config.CORS_ORIGINS);

if (config.NODE_ENV === "production" && corsOrigins === "*") {
  // Defence-in-depth: config.ts hard-fails this case, but if env is mutated at runtime
  // we refuse to wildcard CORS in production.
  logger.error("CORS_ORIGINS resolved to wildcard in production — refusing to start");
  process.exit(1);
}

logger.info(
  {
    network: config.SOLANA_NETWORK,
    rpcUrl: config.SOLANA_RPC_URL,
  },
  "Backend startup configuration"
);

app.use(
  "*",
  cors({
    origin: corsOrigins as string | string[],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 600, // preflight cache 10 minutes
  })
);

// ── Security: Body size limit (1MB default, prevents payload abuse) ──
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));

// ── Audio uploads need a larger body limit (25MB per OpenAI max) ──
app.use("/ai/transcribe", bodyLimit({ maxSize: 25 * 1024 * 1024 }));

// ── Security: Global rate limit (300 req/min per IP/user) ──
app.use("*", globalRateLimit);

// ── Logging ──
app.use("*", honoLogger());

// ── Error Handler ──
app.onError(errorHandler);

// ── Per-route rate limits ──
// setup-progress is called frequently during wizard slider drags — use bot lifecycle limit, not strict auth
app.use("/auth/setup-progress", botLifecycleRateLimit);
app.use("/auth/*", authRateLimit);
app.use("/bot/create", botLifecycleRateLimit);
app.use("/bot/*/start", botLifecycleRateLimit);
app.use("/bot/*/stop", botLifecycleRateLimit);
app.use("/bot/*/emergency", botLifecycleRateLimit);
app.use("/ml/reload", mlRateLimit);
app.use("/position/*", readRateLimit);
app.use("/ai/chat", mlRateLimit);
app.use("/ai/transcribe", mlRateLimit);
app.use("/ai/conversations", readRateLimit);
app.use("/ai/conversations/*", readRateLimit);
app.use("/ai/status", readRateLimit);
app.use("/fleet/*", readRateLimit);
// /analytics/* is admin-only (platform metrics, error logs, growth) — gated
// behind ADMIN_TOKEN per the 2026-04-23 audit. The previous public exposure
// leaked aggregate user/bot counts.
app.use("/analytics/*", requireAdmin);
app.use("/analytics/*", readRateLimit);
app.use("/bot/list", readRateLimit);
app.use("/wallet/*", readRateLimit);
app.use("/lp-agent/*", externalApiRateLimit);

// ── Routes ──
app.route("/health", healthRoutes);
app.route("/auth", authRoutes);
app.route("/wallet", walletRoutes);
app.route("/bot", botRoutes);
app.route("/strategy", strategyRoutes);
app.route("/ml", mlRoutes);
app.route("/events", eventsRoutes);
app.route("/position", positionRoutes);
app.route("/ai", aiRoutes);
app.route("/fleet", fleetRoutes);
app.route("/analytics", analyticsRoutes);
app.route("/lp-agent", lpAgentRoutes);

// ── 404 ──
app.notFound((c) => c.json({
  error: "NOT_FOUND",
  message: `Route not found: ${c.req.method} ${c.req.path}`,
  timestamp: new Date().toISOString(),
}, 404));

// ═══════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════
//
// Bind the HTTP listener BEFORE running migrations so /health responds
// immediately. Railway (and most container platforms) will kill a container
// whose health endpoint doesn't answer within ~2 minutes, and a slow or
// briefly-unreachable DB during boot can blow past that window.
//
// Migrations run in the background; runMigrations() already calls
// process.exit(1) on a real (non "already exists") failure, which Railway
// will surface as a crash in the deploy logs. Until they finish the API
// will return 5xx for any endpoint that touches the DB, but /health stays
// up so the platform knows the process is alive.

process.stdout.write(`[boot] about to bind HTTP listener on 0.0.0.0:${config.PORT}\n`);

const server = serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    hostname: "0.0.0.0",
  },
  (info) => {
    process.stdout.write(`[boot] HTTP listener bound on port ${info.port} — /health is live\n`);
    logger.info("═".repeat(60));
    logger.info("  Aura Backend API");
    logger.info("═".repeat(60));
    logger.info(`  Port:      ${info.port}`);
    logger.info(`  Network:   ${config.SOLANA_NETWORK}`);
    logger.info(`  RPC:       ${config.SOLANA_RPC_URL}`);
    logger.info(`  Database:  ${config.DATABASE_URL}`);
    logger.info("═".repeat(60));
    logger.info("Endpoints:");
    logger.info("  GET  /health");
    logger.info("  POST /auth/nonce");
    logger.info("  POST /auth/verify");
    logger.info("  POST /auth/refresh");
    logger.info("  GET  /auth/me");
    logger.info("  GET  /wallet/balance/:botId");
    logger.info("  GET  /wallet/address/:botId");
    logger.info("  POST /wallet/withdraw/:botId");
    logger.info("  POST /bot/create");
    logger.info("  GET  /bot/list");
    logger.info("  GET  /bot/:botId");
    logger.info("  PUT  /bot/:botId/config");
    logger.info("  POST /bot/:botId/start");
    logger.info("  POST /bot/:botId/stop");
    logger.info("  POST /bot/:botId/emergency");
    logger.info("  DELETE /bot/:botId");
    logger.info("  GET  /strategy/presets");
    logger.info("  POST /strategy/create");
    logger.info("  GET  /ml/health");
    logger.info("  POST /ml/reload  (admin)");
    logger.info("  GET  /ml/feedback  (admin)");
    logger.info("  GET  /events/stream  (SSE)");
    logger.info("  GET  /position/active");
    logger.info("  GET  /position/history");
    logger.info("  GET  /position/bot/:botId");
    logger.info("  GET  /position/:positionId");
    logger.info("  POST /ai/chat");
    logger.info("  POST /ai/transcribe");
    logger.info("  GET  /ai/conversations");
    logger.info("  GET  /ai/conversations/:id");
    logger.info("  DELETE /ai/conversations/:id");
    logger.info("  GET  /ai/status");
    logger.info("  GET  /lp-agent/status");
    logger.info("  GET  /lp-agent/pools/discover");
    logger.info("  GET  /lp-agent/pools/:poolId/info");
    logger.info("  POST /lp-agent/pools/:poolId/add-tx");
    logger.info("  POST /lp-agent/pools/landing-add-tx");
    logger.info("  GET  /lp-agent/positions/opening");
    logger.info("  POST /lp-agent/position/decrease-quotes");
    logger.info("  POST /lp-agent/position/decrease-tx");
    logger.info("  POST /lp-agent/position/landing-decrease-tx");
    logger.info("");

    // S2: Recover any bots that were running before server restart
    orchestrator.recoverRunningBots().then((count) => {
      if (count > 0) {
        logger.info({ recovered: count }, "Bot recovery complete");
      }
    }).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Bot recovery failed");
    });

    // Push notifications: subscribe FCM dispatcher to bot lifecycle events,
    // then schedule the daily PnL digest. Both are no-ops if FCM env unset.
    startNotificationDispatcher();
    startDigestCron();
  }
);

// Run DB migrations in the background after the listener is bound. /health
// stays available throughout so the platform's healthcheck succeeds even if
// the DB is briefly unreachable during cold start.
runMigrations().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    "Background migration run failed"
  );
});

// Graceful shutdown with timeout
const SHUTDOWN_TIMEOUT_MS = 30_000; // 30s max to stop bots and close
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) {
    logger.warn({ signal }, "Shutdown already in progress, ignoring");
    return;
  }
  isShuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated...");

  // Force exit if shutdown takes too long
  const forceTimer = setTimeout(() => {
    logger.error("Shutdown timed out after %dms — forcing exit", SHUTDOWN_TIMEOUT_MS);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref(); // Don't prevent exit

  // Phase 1: Stop accepting new connections
  if (server.listening) {
    server.close((err) => {
      if (err) {
        logger.error(err, "Error closing HTTP server");
      } else {
        logger.info("HTTP server closed — no longer accepting connections");
      }
    });
  } else {
    logger.info("HTTP server was not listening at shutdown");
  }

  // Phase 2: Stop all running bots (waits for active trades to complete)
  try {
    stopDigestCron();
    await orchestrator.stopAll();
    logger.info("All bots stopped cleanly");
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Error stopping bots during shutdown"
    );
  }

  clearTimeout(forceTimer);
  logger.info("Shutdown complete");

  // Phase 3: Close database (connection pool)
  try {
    await closeDatabase();
    logger.info("Database connection closed");
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Error closing database"
    );
  }

  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Process-level error handlers — catch unhandled errors ──
process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined },
    "Unhandled promise rejection"
  );
  // Don't exit — a trading system should stay running.
  // The error is logged and can be investigated.
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "Uncaught exception — shutting down");
  // Uncaught exceptions leave the process in an unknown state.
  // Gracefully shut down to protect open positions.
  shutdown("uncaughtException").catch(() => process.exit(1));
});

export default app;
