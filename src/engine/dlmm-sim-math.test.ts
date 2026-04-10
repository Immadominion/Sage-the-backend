/**
 * Unit tests for DLMMSimulationMath — the pure math engine driving simulation.
 *
 * Tests are grouped by function. All functions are pure (no I/O),
 * so tests are fast, deterministic, and require no mocks.
 */

import { describe, it, expect } from "vitest";
import {
    computeBinPrice,
    binIdFromPrice,
    computeCompositionFactor,
    distributeAcrossBins,
    computePositionValue,
    recomputeBinComposition,
    computeLPValueInY,
    computeHodlValue,
    computeImpermanentLoss,
    estimateFeeAccrual,
    computeBaseFeeRate,
    isPositionInRange,
    computeBinBounds,
    estimatePerBinLiquidity,
} from "./dlmm-sim-math.js";

// ═══════════════════════════════════════════════════════════════
// computeBinPrice
// ═══════════════════════════════════════════════════════════════

describe("computeBinPrice", () => {
    it("returns 1 at bin 0 for any bin step", () => {
        expect(computeBinPrice(0, 10)).toBe(1);
        expect(computeBinPrice(0, 100)).toBe(1);
    });

    it("positive bin ID gives price > 1", () => {
        expect(computeBinPrice(100, 10)).toBeGreaterThan(1);
    });

    it("negative bin ID gives price < 1", () => {
        expect(computeBinPrice(-100, 10)).toBeLessThan(1);
    });

    it("matches expected value for binStep=1, binId=1000", () => {
        // (1 + 1/10000)^1000 ≈ e^0.1 ≈ 1.10517
        const price = computeBinPrice(1000, 1);
        expect(price).toBeCloseTo(1.10517, 3);
    });

    it("matches expected value for binStep=10, binId=100", () => {
        // (1.001)^100 ≈ 1.10512
        const price = computeBinPrice(100, 10);
        expect(price).toBeCloseTo(1.10512, 3);
    });

    it("larger bin step produces larger price per bin", () => {
        const p10 = computeBinPrice(50, 10);
        const p100 = computeBinPrice(50, 100);
        expect(p100).toBeGreaterThan(p10);
    });
});

// ═══════════════════════════════════════════════════════════════
// binIdFromPrice
// ═══════════════════════════════════════════════════════════════

describe("binIdFromPrice", () => {
    it("inverse of computeBinPrice", () => {
        const binStep = 10;
        for (const binId of [-100, 0, 50, 200]) {
            const price = computeBinPrice(binId, binStep);
            expect(binIdFromPrice(price, binStep)).toBe(binId);
        }
    });

    it("returns 0 for price <= 0", () => {
        expect(binIdFromPrice(0, 10)).toBe(0);
        expect(binIdFromPrice(-1, 10)).toBe(0);
    });

    it("returns 0 for price = 1", () => {
        expect(binIdFromPrice(1, 10)).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// computeCompositionFactor
// ═══════════════════════════════════════════════════════════════

describe("computeCompositionFactor", () => {
    it("bins below active → 1 (100% token Y)", () => {
        expect(computeCompositionFactor(99, 100, 10)).toBe(1);
        expect(computeCompositionFactor(50, 100, 10)).toBe(1);
    });

    it("bins above active → 0 (100% token X)", () => {
        expect(computeCompositionFactor(101, 100, 10)).toBe(0);
        expect(computeCompositionFactor(200, 100, 10)).toBe(0);
    });

    it("active bin → 0.5", () => {
        expect(computeCompositionFactor(100, 100, 10)).toBe(0.5);
    });
});

// ═══════════════════════════════════════════════════════════════
// distributeAcrossBins
// ═══════════════════════════════════════════════════════════════

describe("distributeAcrossBins", () => {
    const totalAmount = 1_000_000_000; // 1 SOL
    const activeBin = 100;
    const binStep = 10;
    const perBinLiq = 500_000_000;

    it("returns empty array if lowerBinId > upperBinId", () => {
        const bins = distributeAcrossBins(totalAmount, 110, 90, activeBin, binStep, 0, perBinLiq);
        expect(bins).toHaveLength(0);
    });

    it("Spot strategy distributes uniformly", () => {
        const bins = distributeAcrossBins(totalAmount, 95, 105, activeBin, binStep, 0, perBinLiq);
        expect(bins).toHaveLength(11);

        // All bins should have ~ equal liquidity
        const liquidities = bins.map((b) => b.liquidity);
        const avg = totalAmount / 11;
        for (const liq of liquidities) {
            expect(liq).toBeGreaterThan(avg * 0.9);
            expect(liq).toBeLessThan(avg * 1.1);
        }
    });

    it("Curve strategy concentrates liquidity around active bin", () => {
        const bins = distributeAcrossBins(totalAmount, 90, 110, activeBin, binStep, 1, perBinLiq);
        expect(bins).toHaveLength(21);

        // Active bin should have most liquidity
        const activeBinData = bins.find((b) => b.binId === activeBin)!;
        const edgeBin = bins.find((b) => b.binId === 90)!;
        expect(activeBinData.liquidity).toBeGreaterThan(edgeBin.liquidity);
    });

    it("BidAsk strategy puts more at edges", () => {
        const bins = distributeAcrossBins(totalAmount, 90, 110, activeBin, binStep, 2, perBinLiq);
        expect(bins).toHaveLength(21);

        const activeBinData = bins.find((b) => b.binId === activeBin)!;
        const edgeBin = bins.find((b) => b.binId === 90)!;
        expect(edgeBin.liquidity).toBeGreaterThan(activeBinData.liquidity);
    });

    it("composition is correct: bins below active have more Y", () => {
        const bins = distributeAcrossBins(totalAmount, 95, 105, activeBin, binStep, 0, perBinLiq);

        // Bin below active: c=1 → all Y, no X
        const belowBin = bins.find((b) => b.binId === 95)!;
        expect(belowBin.yAmount).toBe(belowBin.liquidity);
        expect(belowBin.xAmount).toBe(0);

        // Bin above active: c=0 → all X, no Y
        const aboveBin = bins.find((b) => b.binId === 105)!;
        expect(aboveBin.yAmount).toBe(0);
        expect(aboveBin.xAmount).toBe(aboveBin.liquidity);

        // Active bin: c=0.5 → split
        const active = bins.find((b) => b.binId === activeBin)!;
        expect(active.yAmount).toBeGreaterThan(0);
        expect(active.xAmount).toBeGreaterThan(0);
    });

    it("total liquidity approximately equals input", () => {
        const bins = distributeAcrossBins(totalAmount, 95, 105, activeBin, binStep, 0, perBinLiq);
        const totalLiq = bins.reduce((sum, b) => sum + b.liquidity, 0);
        // Floor rounding can lose a few lamports per bin
        expect(totalLiq).toBeGreaterThan(totalAmount * 0.99);
        expect(totalLiq).toBeLessThanOrEqual(totalAmount);
    });

    it("each bin has valid price", () => {
        const bins = distributeAcrossBins(totalAmount, 95, 105, activeBin, binStep, 0, perBinLiq);
        for (const bin of bins) {
            expect(bin.price).toBeGreaterThan(0);
            expect(bin.price).toBeCloseTo(computeBinPrice(bin.binId, binStep), 6);
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// recomputeBinComposition
// ═══════════════════════════════════════════════════════════════

describe("recomputeBinComposition", () => {
    it("does not mutate input bins", () => {
        const bins = [
            { binId: 99, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
            { binId: 100, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        const original = JSON.parse(JSON.stringify(bins));
        recomputeBinComposition(bins, 100, 10);
        expect(bins).toEqual(original);
    });

    it("bins below new active become 100% Y", () => {
        const bins = [
            { binId: 99, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
            { binId: 100, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
            { binId: 101, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        // Active bin moves up to 101 → bins 99 and 100 become below active
        const updated = recomputeBinComposition(bins, 101, 10);
        expect(updated[0].yAmount).toBe(1000); // bin 99: 100% Y
        expect(updated[0].xAmount).toBe(0);
        expect(updated[1].yAmount).toBe(1000); // bin 100: 100% Y
        expect(updated[1].xAmount).toBe(0);
    });

    it("bins above new active become 100% X", () => {
        const bins = [
            { binId: 99, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
            { binId: 100, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
            { binId: 101, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        // Active bin moves down to 99 → bins 100 and 101 become above active
        const updated = recomputeBinComposition(bins, 99, 10);
        expect(updated[1].xAmount).toBe(1000); // bin 100: 100% X
        expect(updated[1].yAmount).toBe(0);
        expect(updated[2].xAmount).toBe(1000); // bin 101: 100% X
        expect(updated[2].yAmount).toBe(0);
    });

    it("active bin is 50/50", () => {
        const bins = [
            { binId: 100, price: 1, xAmount: 0, yAmount: 1000, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        const updated = recomputeBinComposition(bins, 100, 10);
        expect(updated[0].yAmount).toBe(500);
        expect(updated[0].xAmount).toBe(500);
    });
});

// ═══════════════════════════════════════════════════════════════
// computeLPValueInY
// ═══════════════════════════════════════════════════════════════

describe("computeLPValueInY", () => {
    it("all-Y bins return Y amount directly", () => {
        const bins = [
            { binId: 99, price: 1, xAmount: 0, yAmount: 1000, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        expect(computeLPValueInY(bins, 100, 10, 2.0)).toBe(1000);
    });

    it("all-X bins convert at current price", () => {
        const bins = [
            { binId: 101, price: 1, xAmount: 1000, yAmount: 0, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        // X=1000, price=2.0 → value = 1000 * 2.0 = 2000
        expect(computeLPValueInY(bins, 100, 10, 2.0)).toBe(2000);
    });

    it("mixed bins sum correctly", () => {
        const bins = [
            { binId: 100, price: 1, xAmount: 500, yAmount: 500, liquidity: 1000, totalBinLiquidity: 5000 },
        ];
        // price=1.5 → value = 500 + 500*1.5 = 1250
        expect(computeLPValueInY(bins, 100, 10, 1.5)).toBe(1250);
    });
});

// ═══════════════════════════════════════════════════════════════
// computeImpermanentLoss & computeHodlValue
// ═══════════════════════════════════════════════════════════════

describe("computeImpermanentLoss", () => {
    it("returns 0 when LP matches HODL", () => {
        expect(computeImpermanentLoss(1000, 1000)).toBe(0);
    });

    it("returns negative when LP < HODL (IL hurts)", () => {
        expect(computeImpermanentLoss(950, 1000)).toBeLessThan(0);
    });

    it("returns positive when LP > HODL (fees outperform)", () => {
        expect(computeImpermanentLoss(1050, 1000)).toBeGreaterThan(0);
    });

    it("returns 0 for zero HODL value", () => {
        expect(computeImpermanentLoss(1000, 0)).toBe(0);
    });
});

describe("computeHodlValue", () => {
    it("returns just Y when no X tokens", () => {
        expect(computeHodlValue(0, 1000, 1.0, 2.0)).toBe(1000);
    });

    it("accounts for price change on X tokens", () => {
        // 1000 lamports of X at entry price 1.0 → 1000 X tokens
        // Current price 2.0 → 1000 * 2.0 = 2000 Y + 500 Y = 2500
        expect(computeHodlValue(1000, 500, 1.0, 2.0)).toBe(2500);
    });

    it("handles price decrease", () => {
        // 1000 lamports of X at price 2.0 → 500 X tokens
        // Current price 1.0 → 500 * 1.0 = 500 Y + 500 Y = 1000
        expect(computeHodlValue(1000, 500, 2.0, 1.0)).toBe(1000);
    });

    it("returns Y amount when entry price is 0", () => {
        expect(computeHodlValue(1000, 500, 0, 2.0)).toBe(500);
    });
});

// ═══════════════════════════════════════════════════════════════
// estimateFeeAccrual
// ═══════════════════════════════════════════════════════════════

describe("estimateFeeAccrual", () => {
    it("returns 0 if out of range", () => {
        expect(estimateFeeAccrual(10000, 500, 5000, 1, false)).toBe(0);
    });

    it("returns 0 if time <= 0", () => {
        expect(estimateFeeAccrual(10000, 500, 5000, 0, true)).toBe(0);
    });

    it("proportional to LP share", () => {
        const halfShare = estimateFeeAccrual(10000, 500, 1000, 1, true);
        const fullShare = estimateFeeAccrual(10000, 1000, 1000, 1, true);
        expect(fullShare).toBeGreaterThan(halfShare);
        // Half share should be ~50% of full
        expect(halfShare / fullShare).toBeCloseTo(0.5, 1);
    });

    it("proportional to time", () => {
        const oneHour = estimateFeeAccrual(10000, 500, 5000, 1, true);
        const twoHours = estimateFeeAccrual(10000, 500, 5000, 2, true);
        expect(twoHours).toBe(oneHour * 2);
    });

    it("clamps share to max 1", () => {
        // Position liquidity > total (shouldn't happen but handle gracefully)
        const result = estimateFeeAccrual(10000, 10000, 5000, 1, true);
        expect(result).toBe(10000); // 100% share, not 200%
    });

    it("returns 0 if total liquidity is 0", () => {
        expect(estimateFeeAccrual(10000, 500, 0, 1, true)).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// computeBaseFeeRate
// ═══════════════════════════════════════════════════════════════

describe("computeBaseFeeRate", () => {
    it("parses percentage string correctly", () => {
        expect(computeBaseFeeRate("0.25")).toBeCloseTo(0.0025, 6);
        expect(computeBaseFeeRate("2.5")).toBeCloseTo(0.025, 6);
        expect(computeBaseFeeRate("0.1")).toBeCloseTo(0.001, 6);
    });

    it("returns 0 for invalid input", () => {
        expect(computeBaseFeeRate("")).toBe(0);
        expect(computeBaseFeeRate("abc")).toBe(0);
        expect(computeBaseFeeRate("-1")).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// isPositionInRange
// ═══════════════════════════════════════════════════════════════

describe("isPositionInRange", () => {
    it("returns true when active bin is within bounds", () => {
        expect(isPositionInRange(100, 95, 105)).toBe(true);
    });

    it("returns true at lower boundary", () => {
        expect(isPositionInRange(95, 95, 105)).toBe(true);
    });

    it("returns true at upper boundary", () => {
        expect(isPositionInRange(105, 95, 105)).toBe(true);
    });

    it("returns false when below range", () => {
        expect(isPositionInRange(94, 95, 105)).toBe(false);
    });

    it("returns false when above range", () => {
        expect(isPositionInRange(106, 95, 105)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// computeBinBounds
// ═══════════════════════════════════════════════════════════════

describe("computeBinBounds", () => {
    it("centers around active bin", () => {
        const [lower, upper] = computeBinBounds(100, 10);
        expect(lower).toBe(95);
        expect(upper).toBe(104);
        expect(upper - lower + 1).toBe(10);
    });

    it("works with odd range", () => {
        const [lower, upper] = computeBinBounds(100, 11);
        expect(upper - lower + 1).toBe(11);
    });

    it("range of 1 returns same bin", () => {
        const [lower, upper] = computeBinBounds(100, 1);
        expect(lower).toBe(100);
        expect(upper).toBe(100);
    });
});

// ═══════════════════════════════════════════════════════════════
// estimatePerBinLiquidity
// ═══════════════════════════════════════════════════════════════

describe("estimatePerBinLiquidity", () => {
    it("divides total by estimated bin count", () => {
        expect(estimatePerBinLiquidity(30_000_000_000, 30)).toBe(1_000_000_000);
    });

    it("uses default of 30 bins", () => {
        expect(estimatePerBinLiquidity(30_000_000_000)).toBe(1_000_000_000);
    });

    it("returns 0 for zero bin count", () => {
        expect(estimatePerBinLiquidity(1000, 0)).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// Integration: IL scenario
// ═══════════════════════════════════════════════════════════════

describe("IL integration scenario", () => {
    it("2x price increase shows IL vs HODL", () => {
        const binStep = 10;
        const activeBin = 100;
        const totalDeposit = 1_000_000_000; // 1 SOL

        // Open position centered on active bin
        const bins = distributeAcrossBins(
            totalDeposit, 95, 105, activeBin, binStep, 0, 100_000_000,
        );

        // Entry price
        const entryPrice = computeBinPrice(activeBin, binStep);

        // Price doubles → active bin moves up significantly
        const newPrice = entryPrice * 2;
        const newActiveBin = binIdFromPrice(newPrice, binStep);

        // Most bins are now below active → converted to Y
        const updatedBins = recomputeBinComposition(bins, newActiveBin, binStep);
        const lpValue = computeLPValueInY(updatedBins, newActiveBin, binStep, newPrice);

        // HODL value
        const entryX = bins.reduce((s, b) => s + b.xAmount, 0);
        const entryY = bins.reduce((s, b) => s + b.yAmount, 0);
        const hodlValue = computeHodlValue(entryX, entryY, entryPrice, newPrice);

        // IL should be negative (LP underperforms HODL)
        const il = computeImpermanentLoss(lpValue, hodlValue);
        expect(il).toBeLessThan(0);
    });
});
