/**
 * JWT authentication middleware for Hono.
 *
 * Extracts Bearer token from Authorization header,
 * verifies it, and sets userId + walletAddress on the context.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { verifyAccessToken, type SageJWTPayload } from "../services/auth.js";

export type AuthVariables = {
  userId: number;
  walletAddress: string;
  jwtPayload: SageJWTPayload;
};

/**
 * Middleware that requires a valid JWT access token.
 * Sets c.var.userId, c.var.walletAddress, c.var.jwtPayload.
 */
export const requireAuth = createMiddleware<{
  Variables: AuthVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HTTPException(401, {
      message: "Missing or invalid Authorization header",
    });
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  try {
    const payload = await verifyAccessToken(token);

    if (!payload.sub || !payload.userId) {
      throw new HTTPException(401, { message: "Invalid token payload" });
    }

    c.set("userId", payload.userId);
    c.set("walletAddress", payload.sub);
    c.set("jwtPayload", payload);
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(401, {
      message:
        err instanceof Error ? `Authentication failed: ${err.message}` : "Authentication failed",
    });
  }

  await next();
});

/**
 * Optional auth — sets userId/walletAddress if a valid token is present,
 * but does NOT block the request if missing or invalid.
 * Use for endpoints that show different data to authenticated vs anonymous users.
 */
export const optionalAuth = createMiddleware<{
  Variables: AuthVariables;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const payload = await verifyAccessToken(token);
      if (payload.sub && payload.userId) {
        c.set("userId", payload.userId);
        c.set("walletAddress", payload.sub);
        c.set("jwtPayload", payload);
      }
    } catch {
      // Silently ignore — user is treated as anonymous
    }
  }

  await next();
});
