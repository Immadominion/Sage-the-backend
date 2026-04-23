/**
 * ML routes — In-process XGBoost model status, ops, and feedback export.
 *
 * GET  /ml/health    — model status (public, used by mobile status badge)
 * POST /ml/reload    — admin-only hot-reload (x-admin-token)
 * GET  /ml/feedback  — admin-only export for active learning pipeline
 *
 * The bulk-prediction endpoint (POST /ml/predict) was removed 2026-04-23 —
 * the engine calls MLPredictor in-process and there was never a non-debug
 * client. See tmp/aura-backend-mobile-coupling-audit-2026-04-23.md.
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/admin.js";
import { createApiError } from "../middleware/error.js";
import { logger } from "../middleware/logger.js";
import { MLPredictor } from "../engine/ml-predictor.js";
import { V3_FEATURE_NAMES } from "../engine/ml-features.js";
import db from "../db/index.js";
import { positions } from "../db/schema.js";
import { eq, and, isNotNull } from "drizzle-orm";
import { LAMPORTS_PER_SOL } from "../engine/types.js";

const ml = new Hono();

// Shared ML predictor instance (in-process, no HTTP)
const mlPredictor = new MLPredictor({ enabled: true });

// ═══════════════════════════════════════════════════════════════
// Public: Health Check
// ═══════════════════════════════════════════════════════════════

ml.get("/health", async (c) => {
  const health = await mlPredictor.checkHealth();

  if (!health) {
    return c.json(
      {
        status: "unavailable",
        message: "ML model not loaded — ensure models/lp_predictor_v3_latest.json exists",
        featureNames: V3_FEATURE_NAMES,
      },
      503
    );
  }

  return c.json(health);
});

// ═══════════════════════════════════════════════════════════════
// Admin: Reload Model
// ═══════════════════════════════════════════════════════════════

ml.post("/reload", requireAdmin, async (c) => {
  const result = mlPredictor.reloadModel();
  if (!result.success) {
    // Do not leak filesystem paths or library internals to the client.
    logger.error({ err: result.error }, "ml.reload failed");
    throw createApiError("ML model reload failed", 500);
  }
  return c.json({ status: "reloaded", model: result.model });
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
ml.get("/feedback", requireAdmin, async (c) => {
  const since = Number(c.req.query("since") || "0");
  const limit = Math.min(Number(c.req.query("limit") || "1000"), 5000);

  // Query closed positions that have entry features
  const allClosedPositions = (await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.status, "closed"),
        isNotNull(positions.entryFeatures),
        isNotNull(positions.realizedPnlLamports)
      )
    ));
  const filteredPositions = allClosedPositions
    .filter((p) => {
      if (since > 0 && p.exitTimestamp) {
        return p.exitTimestamp > since;
      }
      return true;
    })
    .slice(0, limit);

  // Transform into feedback format matching online_learning.py expectations
  const feedback = filteredPositions.map((p) => {
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
