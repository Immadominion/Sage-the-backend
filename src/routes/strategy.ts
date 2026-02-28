/**
 * Strategy preset routes.
 *
 * GET  /strategy/presets       — list system + user presets
 * POST /strategy/create        — save custom user strategy
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { strategyPresets } from "../db/schema.js";
import { eq, or, sql } from "drizzle-orm";

const strategy = new Hono<{ Variables: AuthVariables }>();

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const createPresetSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).optional(),
  entryScoreThreshold: z.number().positive(),
  minVolume24h: z.number().nonnegative(),
  minLiquidity: z.number().nonnegative(),
  maxLiquidity: z.number().positive(),
  positionSizeSOL: z.number().positive().max(100),
  maxConcurrentPositions: z.number().int().min(1).max(20),
  profitTargetPercent: z.number().positive().max(100),
  stopLossPercent: z.number().positive().max(100),
  maxHoldTimeMinutes: z.number().int().positive().max(1440),
  cooldownMinutes: z.number().int().nonnegative().max(1440),
});

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

/**
 * GET /strategy/presets
 * List system presets + user's own custom presets.
 */
strategy.get("/presets", requireAuth, async (c) => {
  const userId = c.var.userId;

  const presets = db
    .select()
    .from(strategyPresets)
    .where(
      or(eq(strategyPresets.isSystem, true), eq(strategyPresets.userId, userId))
    )
    .all();

  return c.json({ success: true, presets });
});

/**
 * POST /strategy/create
 * Create a custom strategy preset for the authenticated user.
 */
strategy.post(
  "/create",
  requireAuth,
  zValidator("json", createPresetSchema),
  async (c) => {
    const userId = c.var.userId;
    const body = c.req.valid("json");

    // Limit custom presets per user
    const existing = db
      .select({ count: sql<number>`count(*)` })
      .from(strategyPresets)
      .where(eq(strategyPresets.userId, userId))
      .get();

    if (existing && existing.count >= 20) {
      throw createApiError("Maximum 20 custom presets per user", 400);
    }

    db.insert(strategyPresets)
      .values({
        userId,
        isSystem: false,
        ...body,
      })
      .run();

    return c.json({ success: true }, 201);
  }
);

export default strategy;
