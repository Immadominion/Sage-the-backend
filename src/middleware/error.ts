/**
 * Error handling middleware for Hono.
 *
 * Consistent error envelope:
 * {
 *   error: string,         // Machine-readable error type
 *   message: string,       // Human-readable description
 *   requestId?: string,    // From Hono requestId middleware
 *   timestamp: string,     // ISO 8601
 *   details?: unknown      // Validation details (non-production only for unknown errors)
 * }
 */

import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { logger } from "./logger.js";

interface ErrorEnvelope {
  error: string;
  message: string;
  requestId?: string;
  timestamp: string;
  details?: unknown;
}

const isProduction = process.env.NODE_ENV === "production";

function buildEnvelope(
  c: Context,
  error: string,
  message: string,
  details?: unknown
): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    error,
    message,
    timestamp: new Date().toISOString(),
  };
  const reqId = c.get("requestId");
  if (reqId) envelope.requestId = reqId;
  if (details !== undefined) envelope.details = details;
  return envelope;
}

/**
 * Global error handler — registered via app.onError()
 */
export function errorHandler(err: Error, c: Context) {
  // Zod validation errors — always safe to expose field-level details
  if (err instanceof ZodError) {
    const details = err.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    }));
    return c.json(
      buildEnvelope(c, "VALIDATION_ERROR", "Validation failed", details),
      400
    );
  }

  // Hono HTTP exceptions (auth failures, not-found, etc.)
  if (err instanceof HTTPException) {
    return c.json(
      buildEnvelope(c, "HTTP_ERROR", err.message),
      err.status
    );
  }

  // Known API errors with status (from createApiError)
  if ("statusCode" in err) {
    const statusCode = (err as { statusCode: number }).statusCode;
    const details = (err as { details?: unknown }).details;
    return c.json(
      buildEnvelope(c, "API_ERROR", err.message, details),
      statusCode as 400 | 401 | 403 | 404 | 409 | 500 | 503
    );
  }

  // Unknown / unhandled errors — never leak internals in production
  logger.error({ err, requestId: c.get("requestId") }, "Unhandled error");
  return c.json(
    buildEnvelope(
      c,
      "INTERNAL_ERROR",
      isProduction ? "Internal server error" : err.message,
      isProduction ? undefined : err.stack
    ),
    500
  );
}

/**
 * Create a typed API error with status code.
 */
export function createApiError(
  message: string,
  statusCode: number = 500,
  details?: unknown
): Error & { statusCode: number; details?: unknown } {
  const err = new Error(message) as Error & {
    statusCode: number;
    details?: unknown;
  };
  err.statusCode = statusCode;
  err.details = details;
  return err;
}
