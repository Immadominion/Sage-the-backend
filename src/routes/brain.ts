/**
 * Brain routes — Wallet Intelligence (analyze any wallet → behavioral fingerprint).
 *
 * POST /brain/analyze     — start an async analysis of a wallet; returns { brainId }
 * GET  /brain/list        — list the user's brains
 * GET  /brain/:brainId    — poll a brain's status + results
 *
 * Analysis is async (seconds-to-minutes). The row is created `queued` and an
 * in-process worker calls the wallet-intelligence service, advancing status and
 * emitting brain:progress / brain:completed over the existing SSE stream. The
 * client polls GET /brain/:brainId. No job queue — matches the in-process engine
 * pattern already used by the orchestrator.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import crypto from "node:crypto";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { brains, bots, tradeLog } from "../db/schema.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { eventBus } from "../engine/event-bus.js";
import { logger } from "../middleware/logger.js";
import * as walletIntel from "../services/walletIntel.js";

const log = logger.child({ module: "brain" });

const brain = new Hono<{ Variables: AuthVariables }>();
brain.use("/*", requireAuth);

// Solana base58 address: 32–44 chars, no 0/O/I/l.
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const analyzeSchema = z.object({
  wallet: z.string().regex(BASE58_ADDRESS, "invalid Solana wallet address"),
  // Defaults kept modest so a single synchronous analysis finishes well under
  // the gateway/request timeout. Deeper history needs the async job refactor.
  windowDays: z.number().int().min(1).max(365).default(30),
  maxTxs: z.number().int().min(100).max(20_000).default(1_500),
});

function generateBrainId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Background worker — calls the wallet-intelligence service and persists the
 * result. Errors are caught and recorded on the row (never throw to the caller).
 */
async function runAnalysis(
  brainId: string,
  userId: number,
  wallet: string,
  windowDays: number,
  maxTxs: number
): Promise<void> {
  const emit = (type: "brain:progress" | "brain:completed", data: Record<string, unknown>) =>
    eventBus.emitBotEvent(type, brainId, userId, data);

  try {
    await db
      .update(brains)
      .set({ status: "fetching", updatedAt: new Date() })
      .where(eq(brains.brainId, brainId));
    emit("brain:progress", { brainId, status: "fetching" });

    const r = await walletIntel.analyzeWallet(wallet, windowDays, maxTxs);
    const fp = (r.fingerprint ?? {}) as Record<string, any>;
    const ev = (fp.evidence ?? {}) as Record<string, number>;

    await db
      .update(brains)
      .set({
        status: "complete",
        txsScanned: r.txs_scanned ?? null,
        positionsTotal: ev.dlmm_positions_total ?? null,
        positionsComplete: ev.dlmm_positions_complete ?? null,
        swapsFound: ev.swaps ?? null,
        poolsResolved: ev.pools_resolved ?? null,
        confidence: (fp.confidence as string) ?? null,
        fingerprint: r.fingerprint ?? null,
        pnlSummary: r.summary ?? null,
        pricedPositions: r.priced_positions ?? null,
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(brains.brainId, brainId));

    emit("brain:completed", { brainId, status: "complete", confidence: fp.confidence ?? null });
    log.info({ brainId, wallet, confidence: fp.confidence }, "brain analysis complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ brainId, wallet, err: msg }, "brain analysis failed");
    await db
      .update(brains)
      .set({ status: "error", error: msg.slice(0, 500), updatedAt: new Date() })
      .where(eq(brains.brainId, brainId))
      .catch(() => {});
    emit("brain:progress", { brainId, status: "error", error: msg.slice(0, 200) });
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /brain/analyze — start analysis (async)
// ═══════════════════════════════════════════════════════════════
brain.post("/analyze", zValidator("json", analyzeSchema), async (c) => {
  if (!walletIntel.isConfigured()) {
    throw createApiError("Wallet intelligence service is not configured", 503);
  }
  const userId = c.var.userId;
  const { wallet, windowDays, maxTxs } = c.req.valid("json");

  const brainId = generateBrainId();
  await db.insert(brains).values({
    brainId,
    userId,
    walletAddress: wallet,
    status: "queued",
    windowDays,
    maxTxs,
  });

  // Fire-and-forget: analysis continues after the response (in-process, like the
  // orchestrator). Errors are handled inside runAnalysis.
  void runAnalysis(brainId, userId, wallet, windowDays, maxTxs);

  return c.json({ brainId, status: "queued" }, 202);
});

// ═══════════════════════════════════════════════════════════════
// GET /brain/list — user's brains
// ═══════════════════════════════════════════════════════════════
brain.get("/list", async (c) => {
  const userId = c.var.userId;
  const rows = await db
    .select()
    .from(brains)
    .where(eq(brains.userId, userId))
    .orderBy(desc(brains.createdAt))
    .limit(50);
  return c.json({ brains: rows });
});

// ═══════════════════════════════════════════════════════════════
// GET /brain/:brainId — poll status + results
// ═══════════════════════════════════════════════════════════════
brain.get("/:brainId", async (c) => {
  const userId = c.var.userId;
  const brainId = c.req.param("brainId");
  const [row] = await db
    .select()
    .from(brains)
    .where(and(eq(brains.brainId, brainId), eq(brains.userId, userId)));
  if (!row) throw createApiError("Brain not found", 404);
  return c.json({ brain: row });
});

// ═══════════════════════════════════════════════════════════════
// POST /brain/:brainId/deploy — compile fingerprint → bot config → create bot
// ═══════════════════════════════════════════════════════════════

const deploySchema = z.object({
  // v1 deploys as simulation (paper trade); convert-to-live is a separate flow.
  mode: z.enum(["simulation", "live"]).default("simulation"),
  fundingSOL: z.number().positive().max(1000).optional(),
});

const _clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const _r1 = (v: number) => Math.round(v * 10) / 10;
const _num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Inverse strategy inference: derive a rule-based bot config from a wallet's
 * behavioral fingerprint. Sizing is scaled to the user's bankroll and a
 * protective stop-loss is INJECTED regardless of source behavior. All values
 * are clamped for capital coherence (mirrors createBotSchema's clamps).
 */
function compileBrainConfig(
  fingerprint: Record<string, any>,
  pnlSummary: Record<string, any> | null,
  bankrollSOL: number
) {
  const lp = (fingerprint?.lp_behavior ?? {}) as Record<string, any>;
  const holdMedianH = _num(lp?.hold_hours?.median, 4);
  const sizeMedianSol = _num(lp?.position_size_y?.median, 0.5);
  const concurrency = _num(lp?.max_concurrency, 3);
  const avgPnl = _num(pnlSummary?.avg_pnl_ratio, 0.1);

  let positionSizeSOL = _clamp(_r1(sizeMedianSol), 0.1, _r1(bankrollSOL * 0.4));
  let maxConcurrentPositions = Math.round(_clamp(concurrency, 1, 8));
  // Exposure clamp: positionSize × concurrency ≤ 2× bankroll.
  if (positionSizeSOL * maxConcurrentPositions > bankrollSOL * 2) {
    maxConcurrentPositions = Math.max(
      1,
      Math.floor((bankrollSOL * 2) / positionSizeSOL)
    );
  }
  const maxHoldTimeMinutes = Math.round(_clamp(holdMedianH * 60, 30, 1440));
  const profitTargetPercent = _clamp(_r1(Math.abs(avgPnl) * 100) || 10, 4, 40);
  const stopLossPercent = 12; // injected — the brain adds a stop the wallet lacked
  const maxDailyLossSOL = Math.min(bankrollSOL, _r1(positionSizeSOL * 2));

  return {
    entryScoreThreshold: 150,
    minVolume24h: 1000,
    minLiquidity: 100,
    maxLiquidity: 1_000_000,
    positionSizeSOL,
    maxConcurrentPositions,
    defaultBinRange: 10,
    profitTargetPercent,
    stopLossPercent,
    maxHoldTimeMinutes,
    maxDailyLossSOL,
    cooldownMinutes: 60,
    cronIntervalSeconds: 30,
  };
}

function _shortWallet(w: string): string {
  return w.length > 8 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

brain.post("/:brainId/deploy", zValidator("json", deploySchema), async (c) => {
  const userId = c.var.userId;
  const brainId = c.req.param("brainId");
  const { fundingSOL } = c.req.valid("json");

  const [row] = await db
    .select()
    .from(brains)
    .where(and(eq(brains.brainId, brainId), eq(brains.userId, userId)));
  if (!row) throw createApiError("Brain not found", 404);

  // Idempotent: if already deployed, return the existing bot.
  if (row.botId) {
    const [existing] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.botId, row.botId), eq(bots.userId, userId)));
    if (existing) {
      const { encryptedPrivateKey: _e, ...safe } = existing;
      return c.json({ bot: safe });
    }
  }

  if (row.status !== "complete") {
    throw createApiError("Brain analysis is not complete yet", 400);
  }
  const fingerprint = row.fingerprint as Record<string, any> | null;
  if (!fingerprint) {
    throw createApiError("Brain has no fingerprint to deploy", 400);
  }

  // Per-user bot cap (exclude soft-deleted).
  const [existingBots] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bots)
    .where(and(eq(bots.userId, userId), isNull(bots.deletedAt)));
  if ((existingBots?.count ?? 0) >= 10) {
    throw createApiError("Maximum 10 bots per user", 400);
  }

  // v1: always deploy as a simulation (paper) bot; convert-to-live later.
  const bankrollSOL = fundingSOL ?? 10;
  const cfg = compileBrainConfig(
    fingerprint,
    row.pnlSummary as Record<string, any> | null,
    bankrollSOL
  );

  const botId = generateBrainId(); // 8-char hex, same format as botId
  const name = `Brain · ${_shortWallet(row.walletAddress)}`;

  await db.insert(bots).values({
    botId,
    userId,
    name,
    mode: "simulation",
    strategyMode: "rule-based",
    simulationBalanceSOL: bankrollSOL,
    ...cfg,
  });

  await db.insert(tradeLog).values({
    botId,
    userId,
    event: "bot_started",
    details: JSON.stringify({
      action: "deployed_from_brain",
      brainId,
      sourceWallet: row.walletAddress,
      config: cfg,
    }),
  });

  await db
    .update(brains)
    .set({ botId, updatedAt: new Date() })
    .where(eq(brains.brainId, brainId));

  const [created] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));
  const { encryptedPrivateKey: _e, ...safe } = created ?? {};

  log.info({ brainId, botId, sourceWallet: row.walletAddress }, "brain deployed → bot");
  return c.json({ bot: safe }, 201);
});

export default brain;
