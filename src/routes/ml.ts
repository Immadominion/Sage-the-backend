/**
 * ML routes — Proxy to the Python ML prediction service.
 *
 * GET  /ml/health    — check ML service status + model info
 * POST /ml/predict   — direct prediction from features (for testing/debugging)
 * POST /ml/reload    — hot-reload the model without restarting ML service
 * GET  /ml/feedback  — export closed positions with V3 features for online learning
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import { MLPredictor } from "../engine/ml-predictor.js";
import { V3_FEATURE_NAMES } from "../engine/ml-features.js";
import config from "../config.js";
import db from "../db/index.js";
import { positions } from "../db/schema.js";
import { eq, and, isNotNull } from "drizzle-orm";
import { LAMPORTS_PER_SOL } from "../engine/types.js";

const ml = new Hono<{ Variables: AuthVariables }>();

// Shared ML predictor instance
const mlPredictor = new MLPredictor({
  baseUrl: config.ML_SERVICE_URL,
  timeoutMs: 5000,
  enabled: true,
  apiKey: config.ML_API_KEY,
});

// ═══════════════════════════════════════════════════════════════
// Public: Health Check
// ═══════════════════════════════════════════════════════════════

ml.get("/health", async (c) => {
  const health = await mlPredictor.checkHealth();

  if (!health) {
    return c.json(
      {
        status: "unavailable",
        message: "ML service is not running or unreachable",
        expectedUrl: config.ML_SERVICE_URL,
        featureNames: V3_FEATURE_NAMES,
      },
      503
    );
  }

  return c.json(health);
});

// ═══════════════════════════════════════════════════════════════
// Auth-protected: Direct Prediction
// ═══════════════════════════════════════════════════════════════

const predictSchema = z.object({
  features: z
    .array(z.array(z.number()).length(12))
    .min(1)
    .max(100)
    .describe("2D array: each row is 12 V3 features in order"),
  poolAddresses: z
    .array(z.string())
    .optional()
    .describe("Optional pool addresses for labeling"),
});

ml.post(
  "/predict",
  requireAuth,
  zValidator("json", predictSchema),
  async (c) => {
    const body = c.req.valid("json");

    const predictions = await mlPredictor.predictBatch(
      body.features,
      body.poolAddresses
    );

    if (!predictions) {
      throw createApiError("Could not reach the ML prediction service", 503);
    }

    return c.json({
      predictions,
      featureOrder: V3_FEATURE_NAMES,
      count: predictions.length,
    });
  }
);

// ═══════════════════════════════════════════════════════════════
// Auth-protected: Reload Model
// ═══════════════════════════════════════════════════════════════

ml.post("/reload", requireAuth, async (c) => {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.ML_API_KEY) {
      headers["X-ML-API-Key"] = config.ML_API_KEY;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(`${config.ML_SERVICE_URL}/reload`, {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      throw createApiError(`Reload failed: ${text}`, response.status);
    }

    const result = await response.json();
    return c.json(result);
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    throw createApiError(
      `ML service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      503
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// Feedback: Export closed positions with V3 features for ML retraining
// ═══════════════════════════════════════════════════════════════

/**
 * GET /ml/feedback
 *
 * Returns closed positions that have entryFeatures (V3 feature vectors),
 * formatted for the active learning pipeline.
 *
 * Query params:
 *   - since: Unix timestamp (ms) — only return positions closed after this time
 *   - limit: Max positions to return (default 1000)
 *
 * Response format matches what online_learning.py expects.
 * Requires auth — internal ML pipeline uses service token.
 */
ml.get("/feedback", requireAuth, async (c) => {
  const since = Number(c.req.query("since") || "0");
  const limit = Math.min(Number(c.req.query("limit") || "1000"), 5000);

  // Query closed positions that have entry features
  const closedPositions = db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.status, "closed"),
        isNotNull(positions.entryFeatures),
        isNotNull(positions.realizedPnlLamports)
      )
    )
    .all()
    .filter((p) => {
      if (since > 0 && p.exitTimestamp) {
        return p.exitTimestamp > since;
      }
      return true;
    })
    .slice(0, limit);

  // Transform into feedback format matching online_learning.py expectations
  const feedback = closedPositions.map((p) => {
    let features: Record<string, number> = {};
    try {
      features = JSON.parse(p.entryFeatures!);
    } catch {
      features = {};
    }

    const pnlLamports = p.realizedPnlLamports ?? 0;
    const feesX = p.feesEarnedXLamports ?? 0;
    const feesY = p.feesEarnedYLamports ?? 0;
    const txCost = p.txCostLamports ?? 0;
    const netPnlSol = pnlLamports / LAMPORTS_PER_SOL;

    return {
      // V3 feature columns
      volume_30m: features.volume_30m ?? 0,
      volume_1h: features.volume_1h ?? 0,
      volume_2h: features.volume_2h ?? 0,
      volume_4h: features.volume_4h ?? 0,
      volume_24h: features.volume_24h ?? 0,
      fees_30m: features.fees_30m ?? 0,
      fees_1h: features.fees_1h ?? 0,
      fees_24h: features.fees_24h ?? 0,
      fee_efficiency_1h: features.fee_efficiency_1h ?? 0,
      liquidity: features.liquidity ?? 0,
      apr: features.apr ?? 0,
      volume_to_liquidity: features.volume_to_liquidity ?? 0,

      // Metadata
      position_id: p.positionId,
      pool_address: p.poolAddress,
      pool_name: p.poolName,
      entry_timestamp: p.entryTimestamp,
      exit_timestamp: p.exitTimestamp ?? 0,
      exit_reason: p.exitReason ?? "",
      entry_score: p.entryScore ?? 0,
      ml_probability: p.mlProbability ?? null,

      // P&L components
      realized_pnl_lamports: pnlLamports,
      fees_earned_x_lamports: feesX,
      fees_earned_y_lamports: feesY,
      tx_cost_lamports: txCost,
      net_pnl_sol: netPnlSol,

      // Label: was this trade actually profitable?
      profitable: netPnlSol > 0 ? 1 : 0,
    };
  });

  return c.json({
    success: true,
    count: feedback.length,
    feature_columns: V3_FEATURE_NAMES,
    feedback,
  });
});

export default ml;
