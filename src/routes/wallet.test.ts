/**
 * Wallet route contract tests — app/backend wallet API compatibility.
 *
 * Validates the contract the Flutter app depends on:
 *  - Correct HTTP status codes for auth, not-found, validation errors
 *  - Response shape for balance, address, withdraw, prepare-deposit
 *  - Bot mode checks (only live-mode bots have wallets)
 *
 * Mocks DB and Solana dependencies to run without network access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mock DB ────────────────────────────────────────────

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

// ── Mock Solana ────────────────────────────────────────

const mockGetBalance = vi.fn().mockResolvedValue(5_000_000_000); // 5 SOL
const mockGetLatestBlockhash = vi.fn().mockResolvedValue({
  blockhash: "GHtXQBt1AC5VXdzGK1afXe3CkCDWm3Nb7xzBFdBMEyn6",
  lastValidBlockHeight: 100,
});

vi.mock("../services/solana.js", () => ({
  getConnection: () => ({
    getBalance: mockGetBalance,
    getLatestBlockhash: mockGetLatestBlockhash,
  }),
}));

// ── Mock Crypto Utils ──────────────────────────────────

vi.mock("../engine/crypto-utils.js", () => ({
  decryptKeypair: () => {
    // Return a fake keypair-like object
    return {
      publicKey: { toBase58: () => "FakeKeypairPubkey111111111111111111111111111" },
      secretKey: new Uint8Array(64),
    };
  },
  generateEncryptedKeypair: () => ({
    publicKey: "FakeEncryptedPubkey11111111111111111111111111",
    encryptedSecret: "encrypted-data",
  }),
}));

// ── Mock Transaction Sender ────────────────────────────

vi.mock("../engine/transaction-sender.js", () => ({
  TransactionSender: class MockTransactionSender {
    addPriorityFee(tx: unknown) { return tx; }
    async sendTransaction() {
      return {
        success: true,
        signature: "5wHu1qwD7q1FFud5JCpBMVK6JhkHQbnCHwHBc5gLEQrmnoVYEPk4HCbRzHqi3oA",
      };
    }
  },
}));

// ── Mock Auth ──────────────────────────────────────────

const TEST_USER_ID = 42;
const TEST_WALLET = "11111111111111111111111111111112";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("userId", TEST_USER_ID);
    c.set("walletAddress", TEST_WALLET);
    await next();
  }),
}));

// ── Mock Config ────────────────────────────────────────

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

// ── Import route module ────────────────────────────────

import walletRoutes from "./wallet.js";
import { errorHandler } from "../middleware/error.js";

// ── Helpers ────────────────────────────────────────────

function createApp() {
  const app = new Hono();
  app.route("/wallet", walletRoutes);
  app.onError(errorHandler);
  return app;
}

function makeLiveBot(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    botId: "abcd1234",
    userId: TEST_USER_ID,
    name: "Live Bot",
    mode: "live",
    status: "running",
    walletAddress: "11111111111111111111111111111111",
    encryptedPrivateKey: "encrypted-key-data",
    ownerWallet: TEST_WALLET,
    ...overrides,
  };
}

function makeSimBot(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    botId: "ef125678",
    userId: TEST_USER_ID,
    name: "Sim Bot",
    mode: "simulation",
    status: "running",
    walletAddress: null,
    encryptedPrivateKey: null,
    ownerWallet: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("GET /wallet/balance/:botId", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
    selectQueue = [];
    mockGetBalance.mockResolvedValue(5_000_000_000);
  });

  it("returns balance for a live bot", async () => {
    selectQueue = [[makeLiveBot()]];

    const res = await app.request("/wallet/balance/abcd1234");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.botId).toBe("abcd1234");
    expect(body.walletAddress).toBeDefined();
    expect(body.balanceLamports).toBe(5_000_000_000);
    expect(body.balanceSOL).toBe(5);
  });

  it("rejects simulation bot", async () => {
    selectQueue = [[makeSimBot({ botId: "ef125678" })]];

    const res = await app.request("/wallet/balance/ef125678");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.message).toMatch(/live-mode/i);
  });

  it("returns 404 for unknown bot", async () => {
    selectQueue = [[]];

    const res = await app.request("/wallet/balance/abcd1234");
    expect(res.status).toBe(404);
  });

  it("rejects invalid bot ID format", async () => {
    const res = await app.request("/wallet/balance/INVALID!!");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.message).toMatch(/invalid bot id/i);
  });
});

describe("GET /wallet/address/:botId", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
    selectQueue = [];
  });

  it("returns wallet address for a live bot", async () => {
    selectQueue = [[makeLiveBot()]];

    const res = await app.request("/wallet/address/abcd1234");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.botId).toBe("abcd1234");
    expect(body.walletAddress).toBe("11111111111111111111111111111111");
    expect(body.ownerWallet).toBe(TEST_WALLET);
  });

  it("rejects simulation bot", async () => {
    selectQueue = [[makeSimBot({ botId: "ef125678" })]];

    const res = await app.request("/wallet/address/ef125678");
    expect(res.status).toBe(400);
  });
});

describe("POST /wallet/withdraw/:botId", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
    selectQueue = [];
    mockGetBalance.mockResolvedValue(5_000_000_000);
  });

  it("withdraws SOL from live bot wallet", async () => {
    selectQueue = [[makeLiveBot()]];

    const res = await app.request("/wallet/withdraw/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: 1.5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.signature).toBeDefined();
    expect(body.amountSOL).toBe(1.5);
    expect(body.from).toBeDefined();
    expect(body.to).toBe(TEST_WALLET);
  });

  it("rejects insufficient balance", async () => {
    mockGetBalance.mockResolvedValue(100_000); // 0.0001 SOL
    selectQueue = [[makeLiveBot()]];

    const res = await app.request("/wallet/withdraw/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: 1 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/insufficient balance/i);
  });

  it("rejects non-positive amount", async () => {
    const res = await app.request("/wallet/withdraw/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: 0 }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects missing amount", async () => {
    const res = await app.request("/wallet/withdraw/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("rejects simulation bot withdrawal", async () => {
    selectQueue = [[makeSimBot({ botId: "ef125678" })]];

    const res = await app.request("/wallet/withdraw/ef125678", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: 1 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/live-mode/i);
  });
});

describe("POST /wallet/prepare-deposit/:botId", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
    selectQueue = [];
  });

  it("returns a serialized transaction for MWA signing", async () => {
    selectQueue = [[makeLiveBot()]];

    const res = await app.request("/wallet/prepare-deposit/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountSOL: 2,
        feePayer: TEST_WALLET,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction).toBeDefined();
    // Transaction should be a base64 string
    expect(typeof body.transaction).toBe("string");
    expect(body.transaction.length).toBeGreaterThan(0);
    expect(body.botId).toBe("abcd1234");
    expect(body.amountSOL).toBe(2);
    expect(body.depositAddress).toBe("11111111111111111111111111111111");
    expect(body.network).toBeDefined();
  });

  it("rejects missing feePayer", async () => {
    const res = await app.request("/wallet/prepare-deposit/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: 1 }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects non-positive amount", async () => {
    const res = await app.request("/wallet/prepare-deposit/abcd1234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: -1, feePayer: TEST_WALLET }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects simulation bot", async () => {
    selectQueue = [[makeSimBot({ botId: "ef125678" })]];

    const res = await app.request("/wallet/prepare-deposit/ef125678", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSOL: 1, feePayer: TEST_WALLET }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/live-mode/i);
  });
});
