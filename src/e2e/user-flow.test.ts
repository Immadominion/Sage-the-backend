/**
 * End-to-end simulated-user test — sign-in → create → start → events.
 *
 * Validates the full new-user flow as described in the audit document:
 *  1. Auth middleware sets user context (mocked — real SIWS requires wallet signing)
 *  2. Create bot with small-capital config
 *  3. Start bot in simulation mode
 *  4. SSE stream returns "connected" event
 *
 * This is an integration-level test — all route modules are wired together
 * in a single Hono app. External I/O (DB, Solana, ML) is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ═══════════════════════════════════════════════════════════════
// Mocks (must be declared before imports)
// ═══════════════════════════════════════════════════════════════

let selectQueue: unknown[] = [];

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

// ── Orchestrator ──

const mockStartBot = vi.fn().mockResolvedValue(undefined);
const mockStopBot = vi.fn().mockResolvedValue(undefined);
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

// ── EventBus ──

const subscriptions = new Map<number, (event: unknown) => void>();

vi.mock("../engine/event-bus.js", () => ({
    eventBus: {
        emitBotEvent: vi.fn(),
        subscribeUser: (userId: number, cb: (event: unknown) => void) => {
            subscriptions.set(userId, cb);
            return () => { subscriptions.delete(userId); };
        },
    },
}));

// ── Auth middleware ──

const TEST_USER_ID = 42;
const TEST_WALLET = "11111111111111111111111111111111";

vi.mock("../middleware/auth.js", () => ({
    requireAuth: vi.fn(
        async (
            c: { set: (k: string, v: unknown) => void },
            next: () => Promise<void>
        ) => {
            c.set("userId", TEST_USER_ID);
            c.set("walletAddress", TEST_WALLET);
            await next();
        }
    ),
}));

// ── Config ──

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

// ═══════════════════════════════════════════════════════════════
// Import route modules (uses mocked deps)
// ═══════════════════════════════════════════════════════════════

import botRoutes from "../routes/bot.js";
import eventRoutes from "../routes/events.js";
import { errorHandler } from "../middleware/error.js";

// ═══════════════════════════════════════════════════════════════
// Test app
// ═══════════════════════════════════════════════════════════════

function makeBotRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        botId: "a1b2c3d4",
        userId: TEST_USER_ID,
        name: "E2E Bot",
        mode: "simulation",
        status: "stopped",
        strategyMode: "rule-based",
        entryScoreThreshold: 150,
        mlThreshold: null,
        minVolume24h: 1000,
        minLiquidity: 100,
        maxLiquidity: 1_000_000,
        positionSizeSOL: 0.1,
        maxConcurrentPositions: 5,
        defaultBinRange: 10,
        profitTargetPercent: 8,
        stopLossPercent: 12,
        maxHoldTimeMinutes: 240,
        maxDailyLossSOL: 0.3,
        cooldownMinutes: 79,
        cronIntervalSeconds: 30,
        simulationBalanceSOL: 2,
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

describe("E2E: simulated-user activation flow", () => {
    let app: Hono;

    beforeEach(() => {
        app = new Hono();
        app.route("/bot", botRoutes);
        app.route("/events", eventRoutes);
        app.onError(errorHandler);
        vi.clearAllMocks();
        selectQueue = [];
        subscriptions.clear();
    });

    it("create → start → SSE connect (small-capital simulation)", async () => {
        // ── Step 1: Create a bot with small-capital config ──
        selectQueue = [
            [{ count: 0 }],           // bot count check
            [],                        // duplicate name check → no match
            [makeBotRow()],            // getUserBot after insert
        ];

        const createRes = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "E2E Bot",
                mode: "simulation",
                simulationBalanceSOL: 2,
                positionSizeSOL: 0.1,
                maxDailyLossSOL: 0.3,
                maxConcurrentPositions: 5,
            }),
        });

        expect(createRes.status).toBe(201);
        const createBody = await createRes.json();
        expect(createBody.success).toBe(true);
        expect(createBody.bot.mode).toBe("simulation");
        expect(createBody.bot.simulationBalanceSOL).toBe(2);
        expect(createBody.bot.positionSizeSOL).toBe(0.1);
        const botId = createBody.bot.botId;

        // ── Step 2: Start the bot ──
        selectQueue = [[makeBotRow({ botId, status: "stopped" })]];

        const startRes = await app.request(`/bot/${botId}/start`, {
            method: "POST",
        });

        expect(startRes.status).toBe(200);
        const startBody = await startRes.json();
        expect(startBody.success).toBe(true);
        expect(startBody.status).toBe("running");
        expect(mockStartBot).toHaveBeenCalledWith(botId, TEST_USER_ID);

        // ── Step 3: Connect to SSE stream ──
        const sseRes = await app.request("/events/stream", {
            method: "GET",
        });

        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

        // The SSE stream stays open indefinitely. Read first chunk which
        // should contain the "connected" event written immediately on connect.
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        const { value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("SSE timeout — no data within 3s")), 3000)
            ),
        ]);
        const sseText = decoder.decode(value);
        await reader.cancel();

        expect(sseText).toContain("event: connected");
        expect(sseText).toContain(`"userId":${TEST_USER_ID}`);
        expect(sseText).toContain("Connected to Aura event stream");
    });

    it("auto-clamps impossible small-capital configs", async () => {
        // Position size > bankroll — backend should auto-clamp, not reject
        selectQueue = [
            [{ count: 0 }],
            [makeBotRow({
                simulationBalanceSOL: 0.5,
                positionSizeSOL: 0.2,  // clamped from 1.0 to 0.5*0.4=0.2
                maxDailyLossSOL: 0.3,
            })],
        ];

        const res = await app.request("/bot/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: "simulation",
                simulationBalanceSOL: 0.5,
                positionSizeSOL: 1.0,   // > bankroll, will be auto-clamped
                maxDailyLossSOL: 0.3,
            }),
        });

        expect(res.status).toBe(201);
    });

    it("bot list enriches balance from simulation config", async () => {
        selectQueue = [[makeBotRow({ simulationBalanceSOL: 2 })]];

        const listRes = await app.request("/bot/list");
        expect(listRes.status).toBe(200);
        const listBody = await listRes.json();
        expect(listBody.bots).toBeDefined();
        expect(listBody.bots[0].currentBalanceSol).toBe(2);
    });
});
