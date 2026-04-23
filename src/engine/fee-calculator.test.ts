/**
 * Fee Calculator unit tests.
 *
 * Pure-function tests — no DB, no network. Verifies the per-trade fee
 * schedule used by the platform's billing system.
 *
 * Mocks the `config` module so we can pin every env var and exercise the
 * calculator deterministically without touching process.env.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock config BEFORE importing the calculator ───────────────
// vi.hoisted ensures `mockConfig` exists before the (also hoisted) vi.mock
// factory below references it. Mutating the same object lets each test pin
// custom values without re-mocking.
const mockConfig = vi.hoisted(() => ({
  FEE_COLLECTOR_WALLET: "FEE1111111111111111111111111111111111111111" as string | undefined,
  FEE_BPS_BASE: 9,
  FEE_BPS_AURA_AI_SURCHARGE: 0,
  FEE_BPS_LLM_SURCHARGE: 15,
  FEE_MIN_LAMPORTS: 3000,
  FEE_MAX_LAMPORTS: 15_000_000,
}));

vi.mock("../config.js", () => ({
  default: mockConfig,
  config: mockConfig,
}));

// Import AFTER the mock is registered
import { calculateTradeFee, getStrategySurchargeBps } from "./fee-calculator.js";

const ONE_SOL = 1_000_000_000;

describe("fee-calculator", () => {
  beforeEach(() => {
    // Reset to defaults each test
    mockConfig.FEE_COLLECTOR_WALLET = "FEE1111111111111111111111111111111111111111";
    mockConfig.FEE_BPS_BASE = 9;
    mockConfig.FEE_BPS_AURA_AI_SURCHARGE = 0;
    mockConfig.FEE_BPS_LLM_SURCHARGE = 15;
    mockConfig.FEE_MIN_LAMPORTS = 3000;
    mockConfig.FEE_MAX_LAMPORTS = 15_000_000;
  });

  describe("getStrategySurchargeBps", () => {
    it("returns 0 for rule-based", () => {
      expect(getStrategySurchargeBps("rule-based")).toBe(0);
    });
    it("returns aura-ai surcharge for aura-ai and both", () => {
      mockConfig.FEE_BPS_AURA_AI_SURCHARGE = 2;
      expect(getStrategySurchargeBps("aura-ai")).toBe(2);
      expect(getStrategySurchargeBps("both")).toBe(2);
    });
    it("returns llm surcharge for llm", () => {
      mockConfig.FEE_BPS_LLM_SURCHARGE = 7;
      expect(getStrategySurchargeBps("llm")).toBe(7);
    });
  });

  describe("calculateTradeFee — disabled paths", () => {
    it("disables collection when FEE_COLLECTOR_WALLET is unset", () => {
      mockConfig.FEE_COLLECTOR_WALLET = undefined;
      const fee = calculateTradeFee(ONE_SOL, "rule-based");
      expect(fee.enabled).toBe(false);
      expect(fee.feeLamports).toBe(0);
      expect(fee.feeBps).toBe(0);
      expect(fee.collectorWallet).toBeNull();
    });

    it("disables collection on zero/negative position size", () => {
      const fee0 = calculateTradeFee(0, "rule-based");
      expect(fee0.enabled).toBe(false);
      expect(fee0.feeLamports).toBe(0);

      const feeNeg = calculateTradeFee(-100, "rule-based");
      expect(feeNeg.enabled).toBe(false);
    });

    it("returns 0 fee but still 'enabled' when bps is zero", () => {
      mockConfig.FEE_BPS_BASE = 0;
      mockConfig.FEE_BPS_LLM_SURCHARGE = 0;
      const fee = calculateTradeFee(ONE_SOL, "llm");
      expect(fee.enabled).toBe(true);
      expect(fee.feeLamports).toBe(0);
      expect(fee.feeBps).toBe(0);
      expect(fee.collectorWallet).toBe("FEE1111111111111111111111111111111111111111");
    });
  });

  describe("calculateTradeFee — bps math", () => {
    it("computes 9 bps on 1 SOL = 900_000 lamports for rule-based", () => {
      const fee = calculateTradeFee(ONE_SOL, "rule-based");
      // 1_000_000_000 * 9 / 10_000 = 900_000
      expect(fee.feeBps).toBe(9);
      expect(fee.feeLamports).toBe(900_000);
    });

    it("computes 24 bps on 1 SOL = 2_400_000 lamports for llm (9 base + 15 surcharge)", () => {
      const fee = calculateTradeFee(ONE_SOL, "llm");
      expect(fee.feeBps).toBe(24);
      expect(fee.feeLamports).toBe(2_400_000);
    });

    it("aura-ai surcharge is additive to base", () => {
      mockConfig.FEE_BPS_AURA_AI_SURCHARGE = 2;
      const fee = calculateTradeFee(ONE_SOL, "aura-ai");
      expect(fee.feeBps).toBe(11);
      expect(fee.feeLamports).toBe(1_100_000);
    });

    it("rounds DOWN (Math.floor) to never overcharge", () => {
      // position = 333 lamports, 9 bps = 0.2997 → floor = 0 → clamped to MIN
      const fee = calculateTradeFee(333, "rule-based");
      expect(fee.feeLamports).toBe(3000); // hits MIN floor
    });
  });

  describe("calculateTradeFee — clamps", () => {
    it("clamps small fees up to FEE_MIN_LAMPORTS", () => {
      // 1000 lamports * 9 bps = 0.9 → floor=0 → clamped to 3000
      const fee = calculateTradeFee(1000, "rule-based");
      expect(fee.feeLamports).toBe(3000);
    });

    it("clamps huge fees down to FEE_MAX_LAMPORTS", () => {
      // 1000 SOL * 9 bps = 900_000_000 → clamped to 15_000_000
      const fee = calculateTradeFee(1000 * ONE_SOL, "rule-based");
      expect(fee.feeLamports).toBe(15_000_000);
    });

    it("respects custom min/max overrides", () => {
      mockConfig.FEE_MIN_LAMPORTS = 50_000;
      mockConfig.FEE_MAX_LAMPORTS = 100_000;
      const small = calculateTradeFee(100, "rule-based");
      expect(small.feeLamports).toBe(50_000);
      const large = calculateTradeFee(1000 * ONE_SOL, "rule-based");
      expect(large.feeLamports).toBe(100_000);
    });
  });

  describe("calculateTradeFee — output shape", () => {
    it("always returns the collector wallet when enabled", () => {
      const fee = calculateTradeFee(ONE_SOL, "rule-based");
      expect(fee.collectorWallet).toBe("FEE1111111111111111111111111111111111111111");
    });
  });
});
