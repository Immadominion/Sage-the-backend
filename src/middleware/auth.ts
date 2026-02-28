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
