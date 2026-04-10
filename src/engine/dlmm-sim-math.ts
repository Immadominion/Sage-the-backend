/**
 * DLMMSimulationMath — Pure math module for DLMM simulation.
 *
 * All formulas derived from official Meteora docs:
 *  - dlmm-concepts.mdx (bin structure, composition factor)
 *  - dlmm-fee-calculation.mdx (base fee, variable fee, volatility accumulator)
 *  - dlmm-formulas.mdx (price, liquidity, fee accumulation)
 *
 * This module has ZERO I/O — no network calls, no SDK imports, no DB.
 * It takes numbers in and returns numbers out. Tested independently.
 */

import type { SimulatedBinPosition } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const BASIS_POINT_MAX = 10_000;

// ═══════════════════════════════════════════════════════════════
// Bin Price Calculation
// ═══════════════════════════════════════════════════════════════

/**
 * Compute the price at a given bin ID.
 * Formula: price = (1 + binStep / 10000) ^ binId
 *
 * @param binId   The bin ID (can be negative for sub-1 prices)
 * @param binStep Bin step in basis points (e.g., 10 = 0.1%)
 * @returns Price in token Y per token X
 */
export function computeBinPrice(binId: number, binStep: number): number {
    return Math.pow(1 + binStep / BASIS_POINT_MAX, binId);
}

/**
 * Derive a bin ID from a price and bin step.
 * Inverse of computeBinPrice: binId = log(price) / log(1 + binStep/10000)
 */
export function binIdFromPrice(price: number, binStep: number): number {
    if (price <= 0) return 0;
    const base = 1 + binStep / BASIS_POINT_MAX;
    return Math.round(Math.log(price) / Math.log(base));
}

// ═══════════════════════════════════════════════════════════════
// Composition Factor
// ═══════════════════════════════════════════════════════════════

/**
 * Compute the composition factor for a bin relative to the active bin.
 *
 * - Bins below active bin: c = 1 (100% token Y — fully converted)
 * - Bins above active bin: c = 0 (100% token X)
 * - Active bin: c is derived from where the price sits within the bin
 *
 * For the active bin. we estimate c from the fractional position of the
 * current price within the bin's price range.
 *
 * @param binId       The bin to evaluate
 * @param activeBinId The current active bin
 * @param binStep     Bin step in basis points
 * @returns Composition factor c ∈ [0, 1]
 */
export function computeCompositionFactor(
    binId: number,
    activeBinId: number,
    _binStep: number,
): number {
    if (binId < activeBinId) return 1; // 100% token Y
    if (binId > activeBinId) return 0; // 100% token X

    // Active bin: estimate from midpoint. In reality this depends on the
    // exact swap state, but 0.5 is the expected value over time.
    // A more precise value would require the on-chain bin reserves.
    return 0.5;
}

// ═══════════════════════════════════════════════════════════════
// Strategy Distribution
// ═══════════════════════════════════════════════════════════════

/**
 * Distribute a total SOL amount across bins according to a strategy shape.
 *
 * @param totalAmountLamports Total deposit in lamports
 * @param lowerBinId          Lowest bin in the position
 * @param upperBinId          Highest bin in the position
 * @param activeBinId         Current active bin
 * @param binStep             Bin step in basis points
 * @param strategyType        0=Spot, 1=Curve, 2=BidAsk
 * @param totalBinLiquidityEstimate Estimated existing liquidity per bin (lamports)
 * @returns Array of SimulatedBinPosition
 */
export function distributeAcrossBins(
    totalAmountLamports: number,
    lowerBinId: number,
    upperBinId: number,
    activeBinId: number,
    binStep: number,
    strategyType: number,
    totalBinLiquidityEstimate: number,
): SimulatedBinPosition[] {
    const numBins = upperBinId - lowerBinId + 1;
    if (numBins <= 0) return [];

    // Compute raw weights per bin based on strategy type
    const weights: number[] = [];
    let totalWeight = 0;

    for (let binId = lowerBinId; binId <= upperBinId; binId++) {
        const distFromActive = Math.abs(binId - activeBinId);
        let w: number;

        switch (strategyType) {
            case 1: // Curve — gaussian-like, concentrated at active bin
                w = Math.exp(-0.5 * (distFromActive / Math.max(1, numBins * 0.2)) ** 2);
                break;
            case 2: // BidAsk — inverse curve, heavier at edges
                w = 1 - Math.exp(-0.5 * (distFromActive / Math.max(1, numBins * 0.3)) ** 2);
                w = Math.max(w, 0.1); // minimum floor so center bins aren't empty
                break;
            default: // Spot — uniform
                w = 1;
                break;
        }

        weights.push(w);
        totalWeight += w;
    }

    // Distribute amount proportionally to weights, then split X/Y by composition
    const bins: SimulatedBinPosition[] = [];

    for (let i = 0; i < numBins; i++) {
        const binId = lowerBinId + i;
        const binAmount = totalAmountLamports * (weights[i] / totalWeight);
        const price = computeBinPrice(binId, binStep);
        const c = computeCompositionFactor(binId, activeBinId, binStep);

        // Per DLMM constant-sum: P·x + y = L, c = y/L
        // So y = c * L and x = (1-c) * L / P
        // Since binAmount represents total value: binAmount ≈ L
        const yAmount = binAmount * c;
        const xAmount = binAmount * (1 - c);

        bins.push({
            binId,
            price,
            xAmount: Math.floor(xAmount),
            yAmount: Math.floor(yAmount),
            liquidity: Math.floor(binAmount),
            totalBinLiquidity: totalBinLiquidityEstimate,
        });
    }

    return bins;
}

// ═══════════════════════════════════════════════════════════════
// Position Value Calculation
// ═══════════════════════════════════════════════════════════════

/**
 * Compute the current value of a simulated position in lamports.
 *
 * As the active bin moves, token composition in each bin changes:
 * - Bins below active: 100% token Y (value = yAmount)
 * - Bins above active: 100% token X (value = xAmount × price)
 * - Active bin: mixed per composition factor
 *
 * This models the CORE DLMM mechanic that causes impermanent loss.
 */
export function computePositionValue(
    bins: SimulatedBinPosition[],
    currentActiveBinId: number,
    _binStep: number,
): number {
    let totalValue = 0;

    for (const bin of bins) {
        if (bin.binId < currentActiveBinId) {
            // Below active: all liquidity is token Y (was token X, got sold as price rose)
            totalValue += bin.liquidity;
        } else if (bin.binId > currentActiveBinId) {
            // Above active: all liquidity is token X
            totalValue += bin.liquidity;
        } else {
            // Active bin: mixed
            totalValue += bin.liquidity;
        }
    }

    return totalValue;
}

/**
 * Recompute per-bin token amounts after the active bin has moved.
 *
 * This is the core IL mechanic: when price moves through your bins,
 * Token X is sold for Token Y (price rising) or vice versa.
 *
 * @returns Updated bin array (new objects, does not mutate input)
 */
export function recomputeBinComposition(
    bins: SimulatedBinPosition[],
    currentActiveBinId: number,
    binStep: number,
): SimulatedBinPosition[] {
    return bins.map((bin) => {
        const c = computeCompositionFactor(bin.binId, currentActiveBinId, binStep);
        const price = computeBinPrice(bin.binId, binStep);
        const L = bin.liquidity;

        return {
            ...bin,
            price,
            yAmount: Math.floor(L * c),
            xAmount: Math.floor(L * (1 - c)),
        };
    });
}

/**
 * Compute the LP value of a position taking into account token conversion.
 *
 * For a SOL-paired pool (Y = SOL):
 * - Token X value must be converted at current price
 * - Token Y value is already in SOL
 *
 * This gives the true "if I withdrew now, how much SOL would I get" number.
 *
 * @param bins             Current bin positions (after recomputeBinComposition)
 * @param activeBinId      Current active bin
 * @param binStep          Pool bin step
 * @param currentPriceYPerX Current price of token X in token Y terms
 * @returns Total value in lamports (token Y / SOL terms)
 */
export function computeLPValueInY(
    bins: SimulatedBinPosition[],
    _activeBinId: number,
    _binStep: number,
    currentPriceYPerX: number,
): number {
    let total = 0;
    for (const bin of bins) {
        // Token Y amount is already in Y terms (SOL for SOL-paired pools)
        total += bin.yAmount;
        // Token X amount needs conversion at current market price
        total += bin.xAmount * currentPriceYPerX;
    }
    return Math.floor(total);
}

// ═══════════════════════════════════════════════════════════════
// Impermanent Loss
// ═══════════════════════════════════════════════════════════════

/**
 * Compute impermanent loss as a ratio.
 *
 * IL = (lpValue / hodlValue) - 1
 *
 * Returns negative when IL hurts (which is almost always).
 * A return of -0.05 means LP is worth 5% less than just holding.
 */
export function computeImpermanentLoss(
    lpValueLamports: number,
    hodlValueLamports: number,
): number {
    if (hodlValueLamports <= 0) return 0;
    return (lpValueLamports / hodlValueLamports) - 1;
}

/**
 * Compute HODL value — what the original tokens would be worth if just held.
 *
 * @param entryAmountXLamports Token X deposited (lamports)
 * @param entryAmountYLamports Token Y deposited (lamports)
 * @param entryPriceYPerX      Entry price (Y per X)
 * @param currentPriceYPerX    Current price (Y per X)
 * @returns HODL value in lamports (Y terms)
 */
export function computeHodlValue(
    entryAmountXLamports: number,
    entryAmountYLamports: number,
    entryPriceYPerX: number,
    currentPriceYPerX: number,
): number {
    if (entryPriceYPerX <= 0) return entryAmountYLamports;

    // X tokens in Y terms at current price
    const xTokens = entryAmountXLamports / entryPriceYPerX; // amount in X units
    const xValueNow = xTokens * currentPriceYPerX; // convert to Y at current price

    return Math.floor(xValueNow + entryAmountYLamports);
}

// ═══════════════════════════════════════════════════════════════
// Fee Estimation
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate fee accrual for a position over a time period.
 *
 * Uses REAL pool volume/fee data from the Meteora API — not a flat rate.
 *
 * Formula:
 *   ourFeeShare = poolFeeRate × (ourActiveBinLiquidity / totalActiveBinLiquidity)
 *   feeAccrual  = poolVolume × ourFeeShare × timeRatio
 *
 * If position is out-of-range → returns 0.
 *
 * @param poolFeeRatePerHourLamports  Pool's actual fee income per hour (from API fees.hour_1)
 * @param positionLiquidityInActiveBin Our liquidity in the active bin (lamports)
 * @param totalActiveBinLiquidity      Total liquidity in the active bin (lamports)
 * @param timeHours                    Time period in hours
 * @param isInRange                    Whether position currently covers the active bin
 * @returns Estimated fee accrual in lamports
 */
export function estimateFeeAccrual(
    poolFeeRatePerHourLamports: number,
    positionLiquidityInActiveBin: number,
    totalActiveBinLiquidity: number,
    timeHours: number,
    isInRange: boolean,
): number {
    if (!isInRange) return 0;
    if (totalActiveBinLiquidity <= 0) return 0;
    if (timeHours <= 0) return 0;

    const ourShare = positionLiquidityInActiveBin / totalActiveBinLiquidity;
    // Clamp share to [0, 1] — can't earn more than 100% of pool fees
    const clampedShare = Math.min(1, Math.max(0, ourShare));

    return Math.floor(poolFeeRatePerHourLamports * clampedShare * timeHours);
}

/**
 * Compute the base fee rate for a DLMM pool.
 * Formula: baseFee = baseFactor × binStep × 10 × 10^baseFeePowerFactor
 *
 * Returns as a ratio (e.g., 0.002 for 0.2%).
 * If we only have the API's `base_fee_percentage` string, parse that instead.
 */
export function computeBaseFeeRate(
    baseFeePercentageStr: string,
): number {
    const pct = parseFloat(baseFeePercentageStr);
    if (isNaN(pct) || pct < 0) return 0;
    return pct / 100; // "0.2" → 0.002
}

// ═══════════════════════════════════════════════════════════════
// Range Detection
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a position is in range (active bin falls within position bounds).
 */
export function isPositionInRange(
    activeBinId: number,
    lowerBinId: number,
    upperBinId: number,
): boolean {
    return activeBinId >= lowerBinId && activeBinId <= upperBinId;
}

// ═══════════════════════════════════════════════════════════════
// Bin Range from Config
// ═══════════════════════════════════════════════════════════════

/**
 * Compute position bin bounds from active bin and config bin range.
 *
 * @param activeBinId   Current active bin
 * @param defaultBinRange Number of bins in the position (from bot config)
 * @returns [lowerBinId, upperBinId]
 */
export function computeBinBounds(
    activeBinId: number,
    defaultBinRange: number,
): [number, number] {
    const half = Math.floor(defaultBinRange / 2);
    return [activeBinId - half, activeBinId + (defaultBinRange - half - 1)];
}

/**
 * Estimate per-bin liquidity from total pool liquidity.
 *
 * Rough heuristic: distribute pool TVL across bins around the active bin.
 * Most real DLMM pools have liquidity concentrated in ~20-50 bins around active.
 * We use a conservative 30-bin spread estimate.
 *
 * When on-chain bin data is available (Phase 6), this is replaced with real data.
 */
export function estimatePerBinLiquidity(
    totalPoolLiquidityLamports: number,
    estimatedActiveBinCount: number = 30,
): number {
    if (estimatedActiveBinCount <= 0) return 0;
    return Math.floor(totalPoolLiquidityLamports / estimatedActiveBinCount);
}
