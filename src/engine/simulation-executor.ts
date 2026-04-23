/**
 * SimulationExecutor — Simulates LP positions using real DLMM math and market data.
 *
 * Implements bin-level position tracking, real fee estimation from pool volume,
 * impermanent loss modeling, and out-of-range detection.
 *
 * Math is sourced from official Meteora DLMM docs:
 *  - Bin pricing: price = (1 + binStep/10000)^binId
 *  - Constant-sum per bin: P·x + y = L, composition factor c = y/L
 *  - Fee estimation: pool volume × LP share of active bin × fee rate
 *  - IL: LP value vs HODL value divergence as price moves through bins
 *
 * All computation is local — no on-chain transactions. Market data (prices,
 * volumes, fees) comes from the live Meteora REST API via MarketDataProvider.
 */

import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { v4 as uuidv4 } from "uuid";
import type {
  ITradingExecutor,
  TrackedPosition,
  StrategyParameters,
  OpenPositionResult,
  ClosePositionResult,
  BotConfig,
  IMarketDataProvider,
} from "./types.js";
import { LAMPORTS_PER_SOL, SOL_MINT } from "./types.js";
import { getSolPriceUsd, getSolPriceUsdSync } from "./sol-price.js";
import {
  computeBinBounds,
  distributeAcrossBins,
  recomputeBinComposition,
  computeLPValueInY,
  computeHodlValue,
  computeImpermanentLoss,
  isPositionInRange,
  estimatePerBinLiquidity,
} from "./dlmm-sim-math.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "simulation-executor" });

export class SimulationExecutor implements ITradingExecutor {
  private marketData: IMarketDataProvider;
  private config: BotConfig;
  private positions: Map<string, TrackedPosition> = new Map();
  private virtualBalanceLamports: BN;
  private initialBalanceSol: number;

  constructor(
    config: BotConfig,
    marketData: IMarketDataProvider,
    initialBalanceSol?: number
  ) {
    this.config = config;
    this.marketData = marketData;
    this.initialBalanceSol =
      initialBalanceSol ?? config.simulation?.initialBalanceSOL ?? 10;
    this.virtualBalanceLamports = new BN(
      this.initialBalanceSol * LAMPORTS_PER_SOL
    );

    log.info(
      { mode: "SIMULATION", initialBalance: `${this.initialBalanceSol} SOL` },
      "Simulation executor initialized"
    );
  }

  // ── Open Position ──

  async openPosition(
    poolAddress: string,
    strategy: StrategyParameters,
    amountX: BN,
    amountY: BN,
    options?: {
      maxHoldTimeMinutes?: number;
    }
  ): Promise<OpenPositionResult> {
    try {
      const totalAmount = amountX.add(amountY);
      if (totalAmount.gt(this.virtualBalanceLamports)) {
        return {
          success: false,
          error: `Insufficient balance. Have ${this.virtualBalanceLamports.toString()}, need ${totalAmount.toString()}`,
        };
      }

      const poolData = await this.marketData.getPoolData(poolAddress);
      if (!poolData) {
        return { success: false, error: "Pool not found" };
      }

      // Sim only supports SOL-quoted pools (Y = WSOL). Cross-quoted pools
      // would silently be denominated as SOL — the root cause of inflated
      // P&L numbers seen on the dashboard. Refuse instead.
      if (poolData.mint_y !== SOL_MINT) {
        return {
          success: false,
          error: `SIM_NON_SOL_QUOTE: ${poolData.name} mint_y=${poolData.mint_y}`,
        };
      }

      const activeBin = await this.marketData.getActiveBin(poolAddress);
      const positionKeypair = Keypair.generate();
      const positionId = uuidv4();

      // Deduct from virtual balance (include simulated tx fee + rent)
      const txFeeLamports = new BN(5000);
      this.virtualBalanceLamports = this.virtualBalanceLamports
        .sub(totalAmount)
        .sub(txFeeLamports);

      // ── Bin-level position allocation ──
      const binStep = poolData.bin_step;
      const binRange = strategy.maxBinId && strategy.minBinId
        ? strategy.maxBinId - strategy.minBinId + 1
        : this.config.defaultBinRange;

      const [lowerBinId, upperBinId] = strategy.minBinId != null && strategy.maxBinId != null
        ? [strategy.minBinId, strategy.maxBinId]
        : computeBinBounds(activeBin.binId, binRange);

      // Estimate existing per-bin liquidity from pool TVL
      const poolLiquidity = parseFloat(poolData.liquidity) || 0;
      const poolLiquidityLamports = poolLiquidity * LAMPORTS_PER_SOL;
      const perBinLiquidity = estimatePerBinLiquidity(poolLiquidityLamports);

      // Distribute our deposit across bins using the strategy shape
      const simulatedBins = distributeAcrossBins(
        totalAmount.toNumber(),
        lowerBinId,
        upperBinId,
        activeBin.binId,
        binStep,
        strategy.strategyType,
        perBinLiquidity,
      );

      const inRange = isPositionInRange(activeBin.binId, lowerBinId, upperBinId);

      const position: TrackedPosition = {
        id: positionId,
        mode: "SIMULATION",
        status: "ACTIVE",

        poolAddress,
        poolName: poolData.name,
        tokenXMint: poolData.mint_x,
        tokenYMint: poolData.mint_y,
        binStep,

        positionKeypair,
        positionPubkey: positionKeypair.publicKey,

        entryActiveBinId: activeBin.binId,
        entryPricePerToken: activeBin.pricePerToken,
        entryTimestamp: Date.now(),
        entryAmountX: amountX,
        entryAmountY: amountY,

        strategy,

        feesEarnedX: new BN(0),
        feesEarnedY: new BN(0),

        profitTargetPercent: this.config.profitTargetPercent,
        stopLossPercent: this.config.stopLossPercent,
        maxHoldTimeMinutes:
          options?.maxHoldTimeMinutes ?? this.config.maxHoldTimeMinutes,

        trailingStopEnabled: this.config.trailingStopEnabled ?? false,
        trailingStopPercent: this.config.trailingStopPercent,
        highWaterMarkPercent: 0,

        // ── Bin-level simulation data ──
        lowerBinId,
        upperBinId,
        simulatedBins,
        isInRange: inRange,
        compositionFactor: 0.5,
        accumulatedFeeLamports: 0,
        lastFeeUpdateTimestamp: Date.now(),
      };

      this.positions.set(positionId, position);

      log.info(
        {
          positionId,
          pool: poolData.name,
          activeBin: activeBin.binId,
          price: activeBin.pricePerToken,
          binRange: `${lowerBinId}..${upperBinId}`,
          numBins: simulatedBins.length,
          inRange,
          amountX: amountX.toString(),
          amountY: amountY.toString(),
        },
        "[SIM] Position opened with bin-level tracking"
      );

      return {
        success: true,
        positionId,
        positionPubkey: positionKeypair.publicKey,
        txSignature: `sim_${positionId}`,
      };
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error), poolAddress },
        "Failed to open simulated position"
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ── Close Position ──

  async closePosition(
    positionId: string,
    reason: string
  ): Promise<ClosePositionResult> {
    try {
      const position = this.positions.get(positionId);
      if (!position) {
        return { success: false, error: `Position ${positionId} not found` };
      }

      const activeBin = await this.marketData.getActiveBin(
        position.poolAddress
      );
      const currentPrice = parseFloat(activeBin.pricePerToken);
      const entryPrice = parseFloat(position.entryPricePerToken);
      const entryValueLamports = position.entryAmountX.add(
        position.entryAmountY
      );

      // ── Compute real LP value using bin-level composition ──
      let lpValueLamports: number;
      let ilPercent = 0;

      if (position.simulatedBins && position.simulatedBins.length > 0) {
        // Recompute bin composition based on current active bin
        const updatedBins = recomputeBinComposition(
          position.simulatedBins,
          activeBin.binId,
          position.binStep,
        );

        // LP value accounts for token conversion through bins
        lpValueLamports = computeLPValueInY(
          updatedBins,
          activeBin.binId,
          position.binStep,
          currentPrice,
        );

        // Compute IL
        const hodlValue = computeHodlValue(
          position.entryAmountX.toNumber(),
          position.entryAmountY.toNumber(),
          entryPrice,
          currentPrice,
        );
        ilPercent = computeImpermanentLoss(lpValueLamports, hodlValue) * 100;
      } else {
        // Fallback for legacy positions without bin data
        const priceChange = (currentPrice - entryPrice) / entryPrice;
        lpValueLamports = Math.floor(
          entryValueLamports.toNumber() * (1 + priceChange)
        );
      }

      // ── Fee accrual (accumulated during updatePositionData cycles) ──
      const accumulatedFees = position.accumulatedFeeLamports ?? 0;
      // Do one final fee update for the time since last update
      const finalFees = this.computeCurrentFeeAccrual(position);
      const totalFeeLamports = accumulatedFees + finalFees;

      // ── Realized P&L = (LP value + fees) - entry value ──
      const totalReturn = lpValueLamports + totalFeeLamports;
      const realizedPnlLamports = new BN(
        totalReturn - entryValueLamports.toNumber()
      );

      // Credit back to virtual balance
      const txFeeLamports = new BN(5000);
      this.virtualBalanceLamports = this.virtualBalanceLamports
        .add(new BN(totalReturn))
        .sub(txFeeLamports);

      // Update position
      position.status = "CLOSED";
      position.exitPricePerToken = activeBin.pricePerToken;
      position.exitTimestamp = Date.now();
      position.exitReason = reason;
      position.realizedPnlLamports = realizedPnlLamports;
      position.feesEarnedX = new BN(0);
      position.feesEarnedY = new BN(totalFeeLamports);

      const pnlSol = realizedPnlLamports.toNumber() / LAMPORTS_PER_SOL;
      const pnlPercent =
        (realizedPnlLamports.toNumber() / entryValueLamports.toNumber()) * 100;
      const hoursHeld =
        (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);

      log.info(
        {
          positionId,
          pool: position.poolName,
          entryPrice,
          exitPrice: currentPrice,
          pnlSol: pnlSol.toFixed(6),
          pnlPercent: pnlPercent.toFixed(2),
          ilPercent: ilPercent.toFixed(2),
          feesSol: (totalFeeLamports / LAMPORTS_PER_SOL).toFixed(6),
          inRange: position.isInRange ?? "unknown",
          reason,
          hoursHeld: hoursHeld.toFixed(2),
        },
        `[SIM] Position closed (${pnlSol >= 0 ? "WIN" : "LOSS"})`
      );

      return {
        success: true,
        txSignature: `sim_close_${positionId}`,
        realizedPnlLamports,
        feesClaimedY: new BN(totalFeeLamports),
      };
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error), positionId },
        "Failed to close simulated position"
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ── Update Position Data ──

  async updatePositionData(
    positionId: string
  ): Promise<TrackedPosition | null> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== "ACTIVE") return null;

    try {
      const activeBin = await this.marketData.getActiveBin(
        position.poolAddress
      );
      position.currentPricePerToken = activeBin.pricePerToken;

      const currentPrice = parseFloat(activeBin.pricePerToken);
      const entryPrice = parseFloat(position.entryPricePerToken);
      const entryValueLamports = position.entryAmountX.add(
        position.entryAmountY
      );

      // ── Recompute bin composition if we have bin-level data ──
      let currentPnlPercent: number;

      if (position.simulatedBins && position.simulatedBins.length > 0) {
        // Update bin composition based on price movement
        position.simulatedBins = recomputeBinComposition(
          position.simulatedBins,
          activeBin.binId,
          position.binStep,
        );

        // Check if position is still in range
        const wasInRange = position.isInRange;
        position.isInRange = isPositionInRange(
          activeBin.binId,
          position.lowerBinId!,
          position.upperBinId!,
        );

        if (wasInRange && !position.isInRange) {
          log.warn(
            {
              positionId,
              pool: position.poolName,
              activeBin: activeBin.binId,
              range: `[${position.lowerBinId}, ${position.upperBinId}]`,
            },
            "[SIM] Position went OUT OF RANGE — no fee accrual"
          );
        }

        // ── Accrue fees from real pool volume data ──
        const newFees = this.computeCurrentFeeAccrual(position);
        position.accumulatedFeeLamports =
          (position.accumulatedFeeLamports ?? 0) + newFees;
        position.lastFeeUpdateTimestamp = Date.now();
        position.feesEarnedY = new BN(position.accumulatedFeeLamports);

        // Compute LP value for P&L tracking
        const lpValue = computeLPValueInY(
          position.simulatedBins,
          activeBin.binId,
          position.binStep,
          currentPrice,
        );
        const totalValue = lpValue + (position.accumulatedFeeLamports ?? 0);
        currentPnlPercent =
          ((totalValue - entryValueLamports.toNumber()) /
            entryValueLamports.toNumber()) *
          100;
      } else {
        // Fallback for legacy positions without bin data
        currentPnlPercent =
          ((currentPrice - entryPrice) / entryPrice) * 100;
      }

      // Update high water mark (for trailing stop)
      if (currentPnlPercent > (position.highWaterMarkPercent || 0)) {
        position.highWaterMarkPercent = currentPnlPercent;
      }

      return position;
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error), positionId },
        "Failed to update position data"
      );
      return position;
    }
  }

  // ── Fee Accrual Helper ──

  /**
   * Estimate fee accrual for a position since the last update.
   * Uses real pool volume and fee data from the Meteora API via
   * the hourly fee/volume windows — NOT a flat percentage.
   *
   * Returns fee in lamports for the period since lastFeeUpdateTimestamp.
   * Returns 0 if position is out of range.
   */
  private computeCurrentFeeAccrual(position: TrackedPosition): number {
    // Out-of-range positions earn zero fees in DLMM
    if (position.isInRange === false) return 0;

    const now = Date.now();
    const lastUpdate =
      position.lastFeeUpdateTimestamp ?? position.entryTimestamp;
    const hoursSinceLastUpdate = (now - lastUpdate) / (1000 * 60 * 60);
    if (hoursSinceLastUpdate <= 0) return 0;

    // Use entry features for pool fee rate (from the scan that triggered entry)
    const feeRate = position.entryFeatures
      ? this.deriveFeeRateFromFeatures(position.entryFeatures)
      : 0.001;

    // LP share. `liquidity` from the Meteora API is **USD TVL** and
    // entryValueSol is in SOL — so we must convert one to the other before
    // dividing. Use live SOL price (cached 60s); falls back to env or 150
    // if the price feed is unreachable. Clamp share to ≤1% to prevent
    // runaway credits when pool TVL is stale or zero.
    void getSolPriceUsd(); // fire-and-forget refresh of the cache
    const solPriceUsd = getSolPriceUsdSync();
    const MAX_LP_SHARE = 0.01;
    const poolLiquidityUsd = position.entryFeatures?.liquidity ?? 0;
    const poolLiquiditySol = poolLiquidityUsd > 0
      ? poolLiquidityUsd / solPriceUsd
      : 0;
    const entryValueSol =
      position.entryAmountX.add(position.entryAmountY).toNumber() /
      LAMPORTS_PER_SOL;
    const lpShare = poolLiquiditySol > 0
      ? Math.min(MAX_LP_SHARE, entryValueSol / poolLiquiditySol)
      : 0;

    // Volume-based fee estimation: USD volume × feeRate × lpShare × hours
    // gives **USD fees**; convert to SOL lamports via SOL price.
    const volumePerHourUsd = position.entryFeatures?.volume_1h ?? 0;
    const feesUsd = volumePerHourUsd * feeRate * lpShare * hoursSinceLastUpdate;
    const feesSol = feesUsd / solPriceUsd;
    const feesLamports = Math.floor(feesSol * LAMPORTS_PER_SOL);

    return Math.max(0, feesLamports);
  }

  /**
   * Derive effective fee rate from pool features.
   * Uses fee_efficiency = fees / volume ratio when available,
   * otherwise falls back to fee/volume from 1h window.
   */
  private deriveFeeRateFromFeatures(features: NonNullable<TrackedPosition["entryFeatures"]>): number {
    // Direct fee efficiency if available
    if (features.fee_efficiency_1h > 0) {
      return features.fee_efficiency_1h;
    }
    // Derive from fees and volume
    if (features.volume_1h > 0 && features.fees_1h > 0) {
      return features.fees_1h / features.volume_1h;
    }
    // Last resort: 24h data
    if (features.volume_24h > 0 && features.fees_24h > 0) {
      return features.fees_24h / features.volume_24h;
    }
    return 0.001; // Conservative 0.1% default
  }

  // ── Getters ──

  getActivePositions(): TrackedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "ACTIVE"
    );
  }

  getAllPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  async getBalance(): Promise<BN> {
    return this.virtualBalanceLamports;
  }

  getBalanceLamports(): BN {
    return this.virtualBalanceLamports;
  }

  /**
   * Charge a platform fee from the virtual balance.
   *
   * In simulation mode this is a pure book-keeping operation — no Solana
   * transaction is emitted. The fee comes out of the same virtual balance
   * the bot trades from, so it shows up in the dashboard as a balance drop.
   *
   * Returns success=false if the bot can't afford the fee. Caller decides
   * whether to skip the fee silently or block the trade — current policy is
   * to skip silently and log a ledger row with txSignature=null.
   */
  async chargeFee(
    feeLamports: number,
    _collectorWallet: string
  ): Promise<{ success: boolean; txSignature: string | null; error?: string }> {
    if (feeLamports <= 0) {
      return { success: true, txSignature: null };
    }
    const fee = new BN(feeLamports);
    if (fee.gt(this.virtualBalanceLamports)) {
      return {
        success: false,
        txSignature: null,
        error: `Insufficient virtual balance for fee (${feeLamports} lamports)`,
      };
    }
    this.virtualBalanceLamports = this.virtualBalanceLamports.sub(fee);
    return { success: true, txSignature: null };
  }

  // ── Performance Summary ──

  getPerformanceSummary() {
    const closed = Array.from(this.positions.values()).filter(
      (p) => p.status === "CLOSED"
    );
    const wins = closed.filter(
      (p) => p.realizedPnlLamports && p.realizedPnlLamports.gtn(0)
    );
    const losses = closed.filter(
      (p) => p.realizedPnlLamports && p.realizedPnlLamports.lten(0)
    );
    const totalPnl = closed.reduce(
      (sum, p) => sum.add(p.realizedPnlLamports || new BN(0)),
      new BN(0)
    );

    return {
      totalPositions: closed.length,
      wins: wins.length,
      losses: losses.length,
      totalPnlSol: totalPnl.toNumber() / LAMPORTS_PER_SOL,
      currentBalanceSol:
        this.virtualBalanceLamports.toNumber() / LAMPORTS_PER_SOL,
      winRate:
        closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    };
  }

  // ── State Recovery ──

  loadPositions(positions: TrackedPosition[], balanceLamports: BN): void {
    this.positions.clear();
    for (const pos of positions) {
      this.positions.set(pos.id, pos);
    }
    this.virtualBalanceLamports = balanceLamports;

    const active = positions.filter((p) => p.status === "ACTIVE").length;
    log.info(
      {
        loaded: positions.length,
        active,
        balance: balanceLamports.toNumber() / LAMPORTS_PER_SOL,
      },
      "Positions restored from persistence"
    );
  }
}
