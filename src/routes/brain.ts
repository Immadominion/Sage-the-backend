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
import { eq, and, desc } from "drizzle-orm";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { brains } from "../db/schema.js";
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
  windowDays: z.number().int().min(1).max(365).default(90),
  maxTxs: z.number().int().min(100).max(20_000).default(5_000),
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

export default brain;
