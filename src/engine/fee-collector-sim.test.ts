/**
 * SimulationExecutor.chargeFee unit tests.
 *
 * Verifies the virtual-balance debit path used by the platform fee system
 * for simulation-mode bots. No DB, no network — direct method calls only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import BN from "bn.js";

// Mock config so we don't need real env vars
vi.mock("../config.js", () => ({
  default: {},
  config: {},
}));

import { SimulationExecutor } from "./simulation-executor.js";
import { LAMPORTS_PER_SOL } from "./types.js";
import type { BotConfig, IMarketDataProvider } from "./types.js";

function makeExecutor(initialSol: number): SimulationExecutor {
  const cfg: BotConfig = {
    mode: "SIMULATION",
    rpcEndpoint: "http://localhost:8899",
    strategyMode: "rule-based",
    entryScoreThreshold: 100,
    minVolume24h: 0,
    minLiquidity: 0,
    maxLiquidity: 1e12,
    positionSizeSOL: 1,
    maxConcurrentPositions: 5,
    defaultBinRange: 10,
    profitTargetPercent: 8,
    stopLossPercent: 12,
    maxHoldTimeMinutes: 240,
    maxDailyLossSOL: 2,
    cooldownMinutes: 5,
    cronIntervalSeconds: 30,
    simulation: { initialBalanceSOL: initialSol },
  };
  // marketData is unused for chargeFee tests — pass a stub
  const marketData = {} as IMarketDataProvider;
  return new SimulationExecutor(cfg, marketData, initialSol);
}

describe("SimulationExecutor.chargeFee", () => {
  let exec: SimulationExecutor;

  beforeEach(() => {
    exec = makeExecutor(10); // 10 SOL virtual balance
  });

  it("debits the virtual balance by the fee amount", async () => {
    const before = (await exec.getBalance()).toNumber();
    const fee = 500_000;
    const result = await exec.chargeFee(fee, "FEE111111111111111111111111111111111111");
    const after = (await exec.getBalance()).toNumber();
    expect(result.success).toBe(true);
    expect(result.txSignature).toBeNull();
    expect(before - after).toBe(fee);
  });

  it("returns success with no debit when fee is zero", async () => {
    const before = (await exec.getBalance()).toNumber();
    const result = await exec.chargeFee(0, "FEE111111111111111111111111111111111111");
    const after = (await exec.getBalance()).toNumber();
    expect(result.success).toBe(true);
    expect(after).toBe(before);
  });

  it("returns success with no debit on negative fee (defensive)", async () => {
    const before = (await exec.getBalance()).toNumber();
    const result = await exec.chargeFee(-1000, "FEE111111111111111111111111111111111111");
    const after = (await exec.getBalance()).toNumber();
    expect(result.success).toBe(true);
    expect(after).toBe(before);
  });

  it("returns success=false when fee exceeds the virtual balance", async () => {
    const tooBig = 100 * LAMPORTS_PER_SOL; // 100 SOL > 10 SOL balance
    const before = (await exec.getBalance()).toNumber();
    const result = await exec.chargeFee(tooBig, "FEE111111111111111111111111111111111111");
    const after = (await exec.getBalance()).toNumber();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insufficient/i);
    expect(after).toBe(before); // balance untouched
  });

  it("allows a fee equal to the entire balance (edge case)", async () => {
    const balance = (await exec.getBalance()).toNumber();
    const result = await exec.chargeFee(balance, "FEE111111111111111111111111111111111111");
    expect(result.success).toBe(true);
    expect((await exec.getBalance()).toNumber()).toBe(0);
  });

  it("chargeFee never emits a tx signature in simulation mode", async () => {
    const result = await exec.chargeFee(1000, "FEE111111111111111111111111111111111111");
    expect(result.txSignature).toBeNull();
  });

  it("sequential charges accumulate correctly", async () => {
    const before = (await exec.getBalance()).toNumber();
    await exec.chargeFee(100_000, "FEE111111111111111111111111111111111111");
    await exec.chargeFee(250_000, "FEE111111111111111111111111111111111111");
    await exec.chargeFee(50_000, "FEE111111111111111111111111111111111111");
    const after = (await exec.getBalance()).toNumber();
    expect(before - after).toBe(400_000);
  });

  it("ignores collectorWallet (sim mode never sends a tx)", async () => {
    // Even passing a clearly invalid string shouldn't throw — collector is opaque in sim
    const result = await exec.chargeFee(1000, "not-a-real-address");
    expect(result.success).toBe(true);
  });
});

describe("SimulationExecutor.chargeFee — interaction with getBalance / loadPositions", () => {
  it("respects loadPositions balance reset", async () => {
    const exec = makeExecutor(10);
    await exec.chargeFee(LAMPORTS_PER_SOL, "FEE111111111111111111111111111111111111");
    expect((await exec.getBalance()).toNumber()).toBe(9 * LAMPORTS_PER_SOL);
    exec.loadPositions([], new BN(5 * LAMPORTS_PER_SOL));
    expect((await exec.getBalance()).toNumber()).toBe(5 * LAMPORTS_PER_SOL);
  });
});
