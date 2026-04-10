/**
 * Bot lifecycle integration tests — simulation mode.
 *
 * Validates the create → start → stop contract that the Flutter app depends on.
 * Mocks DB and orchestrator to avoid external dependencies; exercises real
 * Hono route handling, Zod validation, and auth middleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mock DB ────────────────────────────────────────────
// Must be declared before the route module is imported.
//
// Drizzle query builder chains: db.select(...).from(...).where(...)
// Each chain method returns `this`, and the final object is awaitable.
// We queue results so sequential awaits in the same handler resolve correctly.

/** Queued results for `db.select()...` chains. Each `await` shifts one. */
let selectQueue: unknown[] = [];

/** Build a thenable chain stub that resolves to the next queued value. */
function makeChain(queue: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.from = self;
    chain.where = self;
    chain.set = self;
    chain.values = self;
    chain.returning = self;
    chain.on = self;
    // Make it a proper thenable for `await`
    chain.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) => {
        try {
            return Promise.resolve(resolve(queue.shift() ?? []));
        } catch (e) {
            return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
    };
    return chain;
}

vi.mock("../db/index.js", () => ({
    default: {
        select: () => makeChain(selectQueue),
        insert: () => makeChain([]),
        update: () => makeChain([]),
        delete: () => makeChain([]),
    },
}));

// ── Mock Orchestrator ──────────────────────────────────

const mockStartBot = vi.fn();
const mockStopBot = vi.fn();
const mockIsRunning = vi.fn().mockReturnValue(false);
const mockGetEngineStats = vi.fn().mockReturnValue(null);
const mockGetPerformanceSummary = vi.fn().mockReturnValue(null);
const mockGetActivePositions = vi.fn().mockReturnValue([]);

vi.mock("../engine/orchestrator.js", () => ({
    orchestrator: {
        startBot: (...args: unknown[]) => mockStartBot(...args),
        stopBot: (...args: unknown[]) => mockStopBot(...args),
        isRunning: (...args: unknown[]) => mockIsRunning(...args),
        getEngineStats: (...args: unknown[]) => mockGetEngineStats(...args),
        getPerformanceSummary: (...args: unknown[]) =>
            mockGetPerformanceSummary(...args),
        getActivePositions: (...args: unknown[]) =>
            mockGetActivePositions(...args),
    },
}));

// ── Mock Auth Middleware ────────────────────────────────
// Bypass JWT verification; inject a fixed test user.

const TEST_USER_ID = 42;
const TEST_WALLET = "TestWa11etAddress1111111111111111111111111111";

vi.mock("../middleware/auth.js", () => ({
    requireAuth: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set("userId", TEST_USER_ID);
        c.set("walletAddress", TEST_WALLET);
        await next();
    }),
}));

// ── Mock Config ────────────────────────────────────────
// Ensure SOLANA_NETWORK is devnet so live mode is rejected.

vi.mock("../config.js", () => ({
    default: {
        SOLANA_NETWORK: "devnet",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
        MASTER_ENCRYPTION_KEY: "a".repeat(64),
        JWT_SECRET: "test-secret-that-is-at-least-32-chars-long!",
        METEORA_API_URL: "https://dlmm-api.meteora.ag",
        NODE_ENV: "test",
        PORT: 3001,
    },
}));

// ── Import route module (uses mocked deps) ─────────────

import botRoutes from "./bot.js";
import { errorHandler } from "../middleware/error.js";

// ── Helpers ────────────────────────────────────────────

function createApp() {
    const app = new Hono();
    app.route("/bot", botRoutes);
    app.onError(errorHandler);
    return app;
}

/** A minimal bot row as Drizzle select would return. */
function makeBotRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        botId: "abcd1234",
        userId: TEST_USER_ID,
        name: "Test Bot",
        mode: "simulation",
        status: "stopped",
        strategyMode: "rule-based",
        entryScoreThreshold: 150,
        mlThreshold: null,
        minVolume24h: 1000,
        minLiquidity: 100,
        maxLiquidity: 1_000_000,
        positionSizeSOL: 1,
        maxConcurrentPositions: 5,
        defaultBinRange: 10,
        profitTargetPercent: 8,
        stopLossPercent: 12,
        maxHoldTimeMinutes: 240,
        maxDailyLossSOL: 2,
        cooldownMinutes: 79,
        cronIntervalSeconds: 30,
        simulationBalanceSOL: 10,
        currentVirtualBalanceLamports: null,
        totalTrades: 0,
        winningTrades: 0,
        totalPnlLamports: 0,
        lastError: null,
        lastActivityAt: null,
        isPublic: false,
        emergencyStopState: null,
        walletAddress: null,
        encryptedPrivateKey: null,
        ownerWallet: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("POST /bot/create", () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
        app = createApp();
        vi.clearAllMocks();
        selectQueue = [];
    });

    it("creates a simulation bot with default config", async () => {
        // 1st select: count existing bots → 0
        // 2nd select: getUserBot after insert → the new bot row
        selectQueue = [[{ count: 0 }], [makeBotRow()]];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "simulation" }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.bot).toBeDefined();
        expect(body.bot.mode).toBe("simulation");
        // Encrypted key must never be exposed to the client
        expect(body.bot.encryptedPrivateKey).toBeUndefined();
    });

    it("rejects live mode on devnet", async () => {
        // 1st select: count existing bots → 0
        selectQueue = [[{ count: 0 }]];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "live" }),
        });

        // Should be 400 because SOLANA_NETWORK is devnet
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/mainnet/i);
    });

    it("rejects when user has 10 bots", async () => {
        selectQueue = [[{ count: 10 }]];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "simulation" }),
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/maximum/i);
    });

    it("accepts custom simulation balance", async () => {
        selectQueue = [
            [{ count: 0 }],
            [makeBotRow({ simulationBalanceSOL: 5 })],
        ];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                simulationBalanceSOL: 5,
            }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.bot.simulationBalanceSOL).toBe(5);
    });

    it("rejects negative position size", async () => {
        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                positionSizeSOL: -1,
            }),
        });

        // Zod validation should reject
        expect(res.status).toBe(400);
    });

    // ── Capital-coherence auto-clamping (defense-in-depth) ──

    it("auto-clamps position size >= simulation bankroll", async () => {
        selectQueue = [
            [{ count: 0 }],
            [makeBotRow({
                simulationBalanceSOL: 10,
                positionSizeSOL: 4, // clamped from 10 to 10*0.4=4
                maxConcurrentPositions: 5,
            })],
        ];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                positionSizeSOL: 10,
                simulationBalanceSOL: 10,
            }),
        });

        // Should succeed with auto-clamped values, not reject
        expect(res.status).toBe(201);
    });

    it("auto-clamps daily loss > simulation bankroll", async () => {
        selectQueue = [
            [{ count: 0 }],
            [makeBotRow({
                simulationBalanceSOL: 10,
                positionSizeSOL: 1,
                maxDailyLossSOL: 10, // clamped from 15 to bankroll
            })],
        ];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                positionSizeSOL: 1,
                maxDailyLossSOL: 15,
                simulationBalanceSOL: 10,
            }),
        });

        expect(res.status).toBe(201);
    });

    it("auto-clamps max exposure > 2x bankroll", async () => {
        selectQueue = [
            [{ count: 0 }],
            [makeBotRow({
                simulationBalanceSOL: 20,
                positionSizeSOL: 5,
                maxConcurrentPositions: 8, // clamped from 10 to floor(40/5)=8
            })],
        ];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                positionSizeSOL: 5,
                maxConcurrentPositions: 10,
                simulationBalanceSOL: 20,
            }),
        });

        expect(res.status).toBe(201);
    });

    it("allows capital-coherent config for small bankroll", async () => {
        selectQueue = [
            [{ count: 0 }],
            [makeBotRow({
                simulationBalanceSOL: 2,
                positionSizeSOL: 0.1,
                maxDailyLossSOL: 0.3,
                maxConcurrentPositions: 5,
            })],
        ];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                simulationBalanceSOL: 2,
                positionSizeSOL: 0.1,
                maxDailyLossSOL: 0.3,
                maxConcurrentPositions: 5,
            }),
        });

        expect(res.status).toBe(201);
    });

    it("skips capital checks for live mode", async () => {
        // Live mode on devnet will fail for a different reason (not mainnet),
        // but it should NOT fail with capital-coherence errors.
        selectQueue = [[{ count: 0 }]];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "live",
                positionSizeSOL: 50,
                simulationBalanceSOL: 10,
            }),
        });

        // Should fail because devnet, not because of capital-coherence
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/mainnet/i);
    });
});

describe("POST /bot/:botId/start", () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
        app = createApp();
        vi.clearAllMocks();
        selectQueue = [];
        mockStartBot.mockResolvedValue(undefined);
    });

    it("starts a stopped simulation bot", async () => {
        selectQueue = [[makeBotRow({ status: "stopped" })]];

        const res = await app.request("/bot/abcd1234/start", {
            method: "POST",
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.status).toBe("running");
        expect(mockStartBot).toHaveBeenCalledWith("abcd1234", TEST_USER_ID);
    });

    it("rejects starting an already-running bot", async () => {
        selectQueue = [[makeBotRow({ status: "running" })]];

        const res = await app.request("/bot/abcd1234/start", {
            method: "POST",
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/already running/i);
    });

    it("returns 404 for non-existent bot", async () => {
        selectQueue = [[]];

        const res = await app.request("/bot/abcd1234/start", {
            method: "POST",
        });

        expect(res.status).toBe(404);
    });

    it("reverts to error status if orchestrator throws", async () => {
        selectQueue = [[makeBotRow({ status: "stopped" })]];
        mockStartBot.mockRejectedValue(new Error("ML model not loaded"));

        const res = await app.request("/bot/abcd1234/start", {
            method: "POST",
        });

        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.message).toMatch(/ML model/i);
    });

    it("rejects invalid bot ID format", async () => {
        const res = await app.request("/bot/INVALID!!/start", {
            method: "POST",
        });

        expect(res.status).toBe(400);
    });
});

describe("POST /bot/:botId/stop", () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
        app = createApp();
        vi.clearAllMocks();
        selectQueue = [];
        mockStopBot.mockResolvedValue(undefined);
    });

    it("stops a running bot", async () => {
        selectQueue = [[makeBotRow({ status: "running" })]];

        const res = await app.request("/bot/abcd1234/stop", {
            method: "POST",
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
    });

    it("rejects stopping an already-stopped bot", async () => {
        selectQueue = [[makeBotRow({ status: "stopped" })]];

        const res = await app.request("/bot/abcd1234/stop", {
            method: "POST",
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.message).toMatch(/already stopped/i);
    });
});
