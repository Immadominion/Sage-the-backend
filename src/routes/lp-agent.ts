import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import { lpAgentService } from "../services/lp-agent.js";

const lpAgent = new Hono<{ Variables: AuthVariables }>();

lpAgent.use("/*", requireAuth);

const discoverQuerySchema = z.object({
  chain: z.string().default("SOL"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  protocol: z.string().optional(),
  min_market_cap: z.coerce.number().optional(),
  min_liquidity: z.coerce.number().optional(),
  min_volume_24h: z.coerce.number().optional(),
  search: z.string().optional(),
});

const ownerQuerySchema = z.object({
  owner: z.string().min(32).max(50),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const addTxSchema = z.object({
  stratergy: z.enum(["Spot", "Curve", "BidAsk"]),
  owner: z.string().min(32).max(50),
  mode: z.enum(["zap-in", "normal"]).default("zap-in"),
  inputSOL: z.number().positive().optional(),
  amountX: z.number().positive().optional(),
  amountY: z.number().positive().optional(),
  percentX: z.number().min(0).max(1).optional(),
  fromBinId: z.number().int(),
  toBinId: z.number().int(),
  slippage_bps: z.number().int().min(1).max(5000).default(500),
}).superRefine((data, ctx) => {
  if (data.mode === "zap-in" && !data.inputSOL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inputSOL"],
      message: "inputSOL is required in zap-in mode",
    });
  }
  if (data.mode === "normal" && (!data.amountX || !data.amountY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["amountX"],
      message: "amountX and amountY are required in normal mode",
    });
  }
});

const landingAddSchema = z.object({
  lastValidBlockHeight: z.number().int(),
  swapTxsWithJito: z.array(z.string()).default([]),
  addLiquidityTxsWithJito: z.array(z.string()).default([]),
  meta: z.record(z.any()).optional(),
});

const decreaseQuotesSchema = z.object({
  id: z.string().min(1),
  bps: z.number().int().min(1).max(10000).default(10000),
});

const decreaseTxSchema = z.object({
  position_id: z.string().min(1),
  owner: z.string().min(32).max(50),
  bps: z.number().int().min(1).max(10000).default(10000),
  slippage_bps: z.number().int().min(1).max(5000).default(500),
  output: z.enum(["allBaseToken", "both", "allToken0", "allToken1"]).default("allBaseToken"),
  provider: z.string().default("JUPITER_ULTRA"),
});

const landingDecreaseSchema = z.object({
  lastValidBlockHeight: z.number().int(),
  closeTxs: z.array(z.string()).default([]),
  swapTxs: z.array(z.string()).default([]),
  closeTxsWithJito: z.array(z.string()).default([]),
  swapTxsWithJito: z.array(z.string()).default([]),
});

function requireLpAgentConfigured() {
  if (!lpAgentService.isConfigured) {
    throw createApiError("LP Agent integration is not configured", 503);
  }
}

function enforceOwnerMatchesUserWallet(owner: string, walletAddress: string) {
  if (owner !== walletAddress) {
    throw createApiError("Owner must match authenticated wallet", 403);
  }
}

lpAgent.get("/status", async (c) => {
  return c.json({
    success: true,
    configured: lpAgentService.isConfigured,
  });
});

lpAgent.get("/pools/discover", zValidator("query", discoverQuerySchema), async (c) => {
  requireLpAgentConfigured();
  const query = c.req.valid("query");
  const data = await lpAgentService.discoverPools(query);
  return c.json({ success: true, data });
});

lpAgent.get("/pools/:poolId/info", async (c) => {
  requireLpAgentConfigured();
  const poolId = c.req.param("poolId");
  const data = await lpAgentService.getPoolInfo(poolId);
  return c.json({ success: true, data });
});

lpAgent.post("/pools/:poolId/add-tx", zValidator("json", addTxSchema), async (c) => {
  requireLpAgentConfigured();
  const poolId = c.req.param("poolId");
  const body = c.req.valid("json");
  enforceOwnerMatchesUserWallet(body.owner, c.var.walletAddress);
  const data = await lpAgentService.generateAddTx(poolId, body as Record<string, unknown>);
  return c.json({ success: true, data });
});

lpAgent.post("/pools/landing-add-tx", zValidator("json", landingAddSchema), async (c) => {
  requireLpAgentConfigured();
  const body = c.req.valid("json");
  const data = await lpAgentService.landingAddTx(body as Record<string, unknown>);
  return c.json({ success: true, data });
});

lpAgent.get("/positions/opening", zValidator("query", ownerQuerySchema), async (c) => {
  requireLpAgentConfigured();
  const { owner, pageSize } = c.req.valid("query");
  enforceOwnerMatchesUserWallet(owner, c.var.walletAddress);
  const data = await lpAgentService.getOpeningPositions(owner, pageSize);
  return c.json({ success: true, data });
});

lpAgent.post("/position/decrease-quotes", zValidator("json", decreaseQuotesSchema), async (c) => {
  requireLpAgentConfigured();
  const body = c.req.valid("json");
  const data = await lpAgentService.decreaseQuotes(body as Record<string, unknown>);
  return c.json({ success: true, data });
});

lpAgent.post("/position/decrease-tx", zValidator("json", decreaseTxSchema), async (c) => {
  requireLpAgentConfigured();
  const body = c.req.valid("json");
  enforceOwnerMatchesUserWallet(body.owner, c.var.walletAddress);
  const data = await lpAgentService.decreaseTx(body as Record<string, unknown>);
  return c.json({ success: true, data });
});

lpAgent.post("/position/landing-decrease-tx", zValidator("json", landingDecreaseSchema), async (c) => {
  requireLpAgentConfigured();
  const body = c.req.valid("json");
  const data = await lpAgentService.landingDecreaseTx(body as Record<string, unknown>);
  return c.json({ success: true, data });
});

export default lpAgent;
