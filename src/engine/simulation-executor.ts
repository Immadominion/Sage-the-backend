/**
 * SimulationExecutor — Simulates LP positions using real market data.
 *
 * Adapted from lp-bot/src/executors/simulation.ts for ESM.
 * Key differences:
 *  - Emits events via EventBus for real-time updates
 *  - Uses pino logger instead of console
 *  - Supports DB-backed state recovery via loadPositions()
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
import { LAMPORTS_PER_SOL } from "./types.js";
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
    amountY: BN
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

      const activeBin = await this.marketData.getActiveBin(poolAddress);
      const positionKeypair = Keypair.generate();
      const positionId = uuidv4();

      // Deduct from virtual balance (include simulated tx fee)
      const txFeeLamports = new BN(5000);
      this.virtualBalanceLamports = this.virtualBalanceLamports
        .sub(totalAmount)
        .sub(txFeeLamports);

      const position: TrackedPosition = {
        id: positionId,
        mode: "SIMULATION",
        status: "ACTIVE",

        poolAddress,
        poolName: poolData.name,
        tokenXMint: poolData.mint_x,
        tokenYMint: poolData.mint_y,
        binStep: poolData.bin_step,

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
        maxHoldTimeMinutes: this.config.maxHoldTimeMinutes,

        trailingStopEnabled: this.config.trailingStopEnabled ?? false,
        trailingStopPercent: this.config.trailingStopPercent,
        highWaterMarkPercent: 0,
      };

      this.positions.set(positionId, position);

      log.info(
        {
          positionId,
          pool: poolData.name,
          activeBin: activeBin.binId,
          price: activeBin.pricePerToken,
          amountX: amountX.toString(),
          amountY: amountY.toString(),
        },
        "[SIM] Position opened"
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
      const priceChange = (currentPrice - entryPrice) / entryPrice;
      const entryValueLamports = position.entryAmountX.add(
        position.entryAmountY
      );

      // Simplified P&L: price change + estimated fees
      const valueChangeLamports = new BN(
        Math.floor(entryValueLamports.toNumber() * priceChange)
      );
      const hoursHeld =
        (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);
      const estimatedFeeLamports = new BN(
        Math.floor(entryValueLamports.toNumber() * 0.001 * hoursHeld)
      );

      const realizedPnlLamports = valueChangeLamports.add(
        estimatedFeeLamports
      );

      // Credit back to virtual balance
      const returnAmount = entryValueLamports.add(realizedPnlLamports);
      const txFeeLamports = new BN(5000);
      this.virtualBalanceLamports = this.virtualBalanceLamports
        .add(returnAmount)
        .sub(txFeeLamports);

      // Update position
      position.status = "CLOSED";
      position.exitPricePerToken = activeBin.pricePerToken;
      position.exitTimestamp = Date.now();
      position.exitReason = reason;
      position.realizedPnlLamports = realizedPnlLamports;
      position.feesEarnedX = new BN(0);
      position.feesEarnedY = estimatedFeeLamports;

      const pnlSol = realizedPnlLamports.toNumber() / LAMPORTS_PER_SOL;
      const pnlPercent =
        (realizedPnlLamports.toNumber() / entryValueLamports.toNumber()) * 100;

      log.info(
        {
          positionId,
          pool: position.poolName,
          entryPrice,
          exitPrice: currentPrice,
          pnlSol: pnlSol.toFixed(6),
          pnlPercent: pnlPercent.toFixed(2),
          reason,
          hoursHeld: hoursHeld.toFixed(2),
        },
        `[SIM] Position closed (${pnlSol >= 0 ? "WIN" : "LOSS"})`
      );

      return {
        success: true,
        txSignature: `sim_close_${positionId}`,
        realizedPnlLamports,
        feesClaimedY: estimatedFeeLamports,
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
      const currentPnlPercent =
        ((currentPrice - entryPrice) / entryPrice) * 100;

      // Update estimated fees
      const hoursHeld =
        (Date.now() - position.entryTimestamp) / (1000 * 60 * 60);
      const entryValueLamports = position.entryAmountX.add(
        position.entryAmountY
      );
      position.feesEarnedY = new BN(
        Math.floor(entryValueLamports.toNumber() * 0.001 * hoursHeld)
      );

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
