import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockDiscoverPools = vi.fn();
const mockGetPoolInfo = vi.fn();
const mockGenerateAddTx = vi.fn();
const mockGetOpeningPositions = vi.fn();

vi.mock("../services/lp-agent.js", () => ({
  lpAgentService: {
    isConfigured: true,
    discoverPools: (...args: unknown[]) => mockDiscoverPools(...args),
    getPoolInfo: (...args: unknown[]) => mockGetPoolInfo(...args),
    generateAddTx: (...args: unknown[]) => mockGenerateAddTx(...args),
    landingAddTx: vi.fn(),
    getOpeningPositions: (...args: unknown[]) => mockGetOpeningPositions(...args),
    decreaseQuotes: vi.fn(),
    decreaseTx: vi.fn(),
    landingDecreaseTx: vi.fn(),
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("userId", 42);
    c.set("walletAddress", "AuthWallet1111111111111111111111111111111111");
    await next();
  }),
}));

import lpAgentRoutes from "./lp-agent.js";
import { errorHandler } from "../middleware/error.js";

function createApp() {
  const app = new Hono();
  app.route("/lp-agent", lpAgentRoutes);
  app.onError(errorHandler);
  return app;
}

describe("LP Agent routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  it("GET /lp-agent/pools/discover forwards query", async () => {
    mockDiscoverPools.mockResolvedValueOnce({ status: "success", data: [] });

    const res = await app.request(
      "/lp-agent/pools/discover?chain=SOL&pageSize=5&sortOrder=desc"
    );

    expect(res.status).toBe(200);
    expect(mockDiscoverPools).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "SOL", pageSize: 5, sortOrder: "desc" })
    );
  });

  it("GET /lp-agent/pools/:poolId/info forwards id", async () => {
    mockGetPoolInfo.mockResolvedValueOnce({ status: "success", data: { id: "pool1" } });

    const res = await app.request("/lp-agent/pools/pool1/info");

    expect(res.status).toBe(200);
    expect(mockGetPoolInfo).toHaveBeenCalledWith("pool1");
  });

  it("POST /lp-agent/pools/:poolId/add-tx rejects owner mismatch", async () => {
    const res = await app.request("/lp-agent/pools/pool1/add-tx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stratergy: "Spot",
        owner: "AnotherWallet1111111111111111111111111111111111",
        mode: "zap-in",
        inputSOL: 0.1,
        fromBinId: 10,
        toBinId: 20,
      }),
    });

    expect(res.status).toBe(403);
    expect(mockGenerateAddTx).not.toHaveBeenCalled();
  });

  it("GET /lp-agent/positions/opening enforces owner wallet match", async () => {
    const res = await app.request(
      "/lp-agent/positions/opening?owner=AnotherWallet1111111111111111111111111111111111"
    );

    expect(res.status).toBe(403);
    expect(mockGetOpeningPositions).not.toHaveBeenCalled();
  });
});
