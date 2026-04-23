/**
 * Admin token middleware.
 *
 * Gates ops/analytics/internal endpoints behind a shared admin token
 * passed via the `x-admin-token` header. Token is read from
 * `ADMIN_TOKEN` env at module load.
 *
 * Behaviour:
 * - If `ADMIN_TOKEN` is unset → endpoint is locked (always 503).
 *   Forces operators to set a real secret rather than silently allowing.
 * - If header missing or mismatch → 401.
 * - On success → request continues. No userId is set; this is for
 *   service-to-service / ops use, not authenticated user flows.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || "";

export const requireAdmin = createMiddleware(async (c, next) => {
    if (!ADMIN_TOKEN) {
        throw new HTTPException(503, {
            message: "Admin endpoints disabled — ADMIN_TOKEN not configured",
        });
    }

    const provided = c.req.header("x-admin-token")?.trim() ?? "";

    // Constant-time-ish comparison: avoid leaking length via early-exit.
    // Node's timingSafeEqual would be ideal but requires equal-length buffers;
    // for a fixed-length secret, a length-aware compare is sufficient here.
    if (provided.length !== ADMIN_TOKEN.length) {
        throw new HTTPException(401, { message: "Invalid admin token" });
    }
    let mismatch = 0;
    for (let i = 0; i < ADMIN_TOKEN.length; i++) {
        mismatch |= provided.charCodeAt(i) ^ ADMIN_TOKEN.charCodeAt(i);
    }
    if (mismatch !== 0) {
        throw new HTTPException(401, { message: "Invalid admin token" });
    }

    await next();
});
