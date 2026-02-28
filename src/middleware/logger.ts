/**
 * Structured logger — pino
 *
 * Uses LOG_LEVEL from config (defaults: production=info, dev=debug).
 * Pretty-printing enabled in non-production environments only.
 */

import pino from "pino";

const level =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

export const logger = pino({
  level,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export default logger;
