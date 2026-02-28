/**
 * Sage Backend — Main entry point
 *
 * Hono on Node.js server providing REST API for the Sage mobile app.
 *
 * Architecture:
 *  - Auth:    SIWS (Sign-In With Solana) → JWT
 *  - Routes:  /auth, /wallet, /bot, /strategy, /health
 *  - DB:      SQLite via Drizzle ORM (production-grade with WAL mode)
 *  - Guards:  JWT validation, Zod input validation, rate limiting
 *  - Security: CORS lockdown, secure headers, body size limits, request IDs
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requestId } from "hono/request-id";
import { bodyLimit } from "hono/body-limit";
import { logger as honoLogger } from "hono/logger";

import config from "./config.js";
import { errorHandler } from "./middleware/error.js";
import { logger } from "./middleware/logger.js";
import { globalRateLimit, authRateLimit, botLifecycleRateLimit, readRateLimit, mlRateLimit } from "./middleware/rate-limit.js";

// Routes
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import walletRoutes from "./routes/wallet.js";
import botRoutes from "./routes/bot.js";
import strategyRoutes from "./routes/strategy.js";
import mlRoutes from "./routes/ml.js";
import eventsRoutes from "./routes/events.js";
import positionRoutes from "./routes/position.js";

// Engine
import { orchestrator } from "./engine/orchestrator.js";
import { closeDatabase } from "./db/index.js";

// ═══════════════════════════════════════════════════════════════
// App
// ═══════════════════════════════════════════════════════════════

const app = new Hono();

// ── Security: Request ID for tracing ──
app.use("*", requestId());

// ── Security: Secure HTTP headers ──
app.use("*", secureHeaders());

// ── Security: CORS — locked to configured origins ──
const corsOrigins = config.CORS_ORIGINS === "*"
  ? (config.NODE_ENV === "production" ? [] : "*" as const)
  : config.CORS_ORIGINS.split(",").map(s => s.trim());

if (config.NODE_ENV === "production" && config.CORS_ORIGINS === "*") {
  logger.warn("⚠️  CORS_ORIGINS is wildcard in production! Set explicit origins.");
}

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

// ── Security: Global rate limit (300 req/min per IP/user) ──
app.use("*", globalRateLimit);

// ── Logging ──
app.use("*", honoLogger());

// ── Error Handler ──
app.onError(errorHandler);

// ── Per-route rate limits ──
app.use("/auth/*", authRateLimit);
app.use("/bot/create", botLifecycleRateLimit);
app.use("/bot/*/start", botLifecycleRateLimit);
app.use("/bot/*/stop", botLifecycleRateLimit);
app.use("/bot/*/emergency", botLifecycleRateLimit);
app.use("/ml/predict", mlRateLimit);
app.use("/ml/reload", mlRateLimit);
app.use("/position/*", readRateLimit);
app.use("/bot/list", readRateLimit);
app.use("/wallet/*", readRateLimit);

// ── Routes ──
app.route("/health", healthRoutes);
app.route("/auth", authRoutes);
app.route("/wallet", walletRoutes);
app.route("/bot", botRoutes);
app.route("/strategy", strategyRoutes);
app.route("/ml", mlRoutes);
app.route("/events", eventsRoutes);
app.route("/position", positionRoutes);

// ── 404 ──
app.notFound((c) => c.json({
  error: "NOT_FOUND",
  message: `Route not found: ${c.req.method} ${c.req.path}`,
  timestamp: new Date().toISOString(),
}, 404));

// ═══════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════

const server = serve(
  {
    fetch: app.fetch,
    port: config.PORT,
  },
  (info) => {
    logger.info("═".repeat(60));
    logger.info("  Sage Backend API");
    logger.info("═".repeat(60));
    logger.info(`  Port:      ${info.port}`);
    logger.info(`  Network:   ${config.SOLANA_NETWORK}`);
    logger.info(`  RPC:       ${config.SOLANA_RPC_URL}`);
    logger.info(`  Program:   ${config.SENTINEL_PROGRAM_ID}`);
    logger.info(`  Database:  ${config.DATABASE_URL}`);
    logger.info("═".repeat(60));
    logger.info("Endpoints:");
    logger.info("  GET  /health");
    logger.info("  POST /auth/nonce");
    logger.info("  POST /auth/verify");
    logger.info("  POST /auth/refresh");
    logger.info("  GET  /auth/me");
    logger.info("  POST /wallet/prepare-create");
    logger.info("  GET  /wallet/state");
    logger.info("  GET  /wallet/balance");
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
    logger.info("  POST /ml/predict");
    logger.info("  POST /ml/reload");
    logger.info("  GET  /events/stream  (SSE)");
    logger.info("  GET  /position/active");
    logger.info("  GET  /position/history");
    logger.info("  GET  /position/bot/:botId");
    logger.info("  GET  /position/:positionId");
    logger.info("");

    // S2: Recover any bots that were running before server restart
    orchestrator.recoverRunningBots().then((count) => {
      if (count > 0) {
        logger.info({ recovered: count }, "Bot recovery complete");
      }
    }).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Bot recovery failed");
    });
  }
);

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
  server.close((err) => {
    if (err) {
      logger.error(err, "Error closing HTTP server");
    } else {
      logger.info("HTTP server closed — no longer accepting connections");
    }
  });

  // Phase 2: Stop all running bots (waits for active trades to complete)
  try {
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

  // Phase 3: Close database (flush WAL)
  try {
    closeDatabase();
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
