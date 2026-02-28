/**
 * TradingEngine — Core scan/entry/exit loop.
 *
 * Adapted from lp-bot/src/engine/trading-engine.ts for ESM.
 * Key differences:
 *  - Uses pino structured logging
 *  - Emits lifecycle events via a callback (used by BotOrchestrator)
 *  - Reports position open/close for DB persistence
 */

import BN from "bn.js";
import type {
  BotConfig,
  ITradingExecutor,
  IMarketDataProvider,
  TrackedPosition,
  StrategyParameters,
  MeteoraPairData,
  MarketScore,
} from "./types.js";
import { StrategyType, LAMPORTS_PER_SOL } from "./types.js";
import { MLPredictor, type MLPrediction } from "./ml-predictor.js";
import {
  extractV3Features,
  featuresToArray,
  type V3Features,
} from "./ml-features.js";
import { EmergencyStop } from "./emergency-stop.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "trading-engine" });

// ═══════════════════════════════════════════════════════════════
// Position sizing (from lp-bot)
// ═══════════════════════════════════════════════════════════════

function calculatePositionSize(config: BotConfig, balanceLamports: BN): BN {
  const balanceSOL = balanceLamports.toNumber() / LAMPORTS_PER_SOL;
  let positionSOL: number;

  if (config.positionSizePercent && config.positionSizePercent > 0) {
    positionSOL = balanceSOL * (config.positionSizePercent / 100);
  } else if (config.positionSizeSOL && config.positionSizeSOL > 0) {
    positionSOL = config.positionSizeSOL;
  } else {
    positionSOL = balanceSOL * 0.1;
  }

  const minSOL = config.minPositionSOL ?? 0.05;
  const maxSOL = config.maxPositionSOL ?? 5;
  positionSOL = Math.max(minSOL, Math.min(maxSOL, positionSOL));

  // Never exceed balance minus rent/fee reserve
  const RESERVE_SOL = 0.03;
  const maxFromBalance = Math.max(0, balanceSOL - RESERVE_SOL);
  if (positionSOL > maxFromBalance) {
    positionSOL = maxFromBalance;
  }

  return new BN(Math.floor(positionSOL * LAMPORTS_PER_SOL));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// Engine Stats
// ═══════════════════════════════════════════════════════════════

export interface EngineStats {
  totalScans: number;
  positionsOpened: number;
  positionsClosed: number;
  wins: number;
  losses: number;
  totalPnlLamports: BN;
  startTime: number;
}

// ═══════════════════════════════════════════════════════════════
// Lifecycle callback — used by BotOrchestrator
// ═══════════════════════════════════════════════════════════════

export type EngineEvent =
  | { type: "position:opened"; position: TrackedPosition; score: MarketScore }
  | { type: "position:closed"; position: TrackedPosition; pnlLamports: BN }
  | { type: "position:updated"; position: TrackedPosition }
  | { type: "scan:completed"; eligible: number; entered: number }
  | { type: "engine:started" }
  | { type: "engine:stopped"; stats: EngineStats }
  | { type: "engine:error"; error: string };

export type EngineEventCallback = (event: EngineEvent) => void;

// ═══════════════════════════════════════════════════════════════
// TradingEngine
// ═══════════════════════════════════════════════════════════════

interface PoolCooldown {
  poolAddress: string;
  exitTimestamp: number;
}

export class TradingEngine {
  private config: BotConfig;
  private executor: ITradingExecutor;
  private marketData: IMarketDataProvider;
  private onEvent: EngineEventCallback;
  private mlPredictor: MLPredictor | null;

  // Safety systems
  readonly emergencyStop: EmergencyStop;
  readonly circuitBreaker: CircuitBreaker;

  private cooldowns = new Map<string, PoolCooldown>();
  private stats: EngineStats;
  private isRunning = false;
  private isScanning = false;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private positionCheckInterval: ReturnType<typeof setInterval> | null = null;
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;

  /** Optional label for log context (e.g. bot ID) */
  readonly label: string;

  constructor(
    config: BotConfig,
    executor: ITradingExecutor,
    marketData: IMarketDataProvider,
    onEvent: EngineEventCallback,
    label = "engine",
    mlPredictor: MLPredictor | null = null,
    emergencyStop?: EmergencyStop,
    circuitBreaker?: CircuitBreaker
  ) {
    this.config = config;
    this.executor = executor;
    this.marketData = marketData;
    this.onEvent = onEvent;
    this.mlPredictor = mlPredictor;
    this.label = label;

    // Safety systems — create defaults if not injected
    this.emergencyStop = emergencyStop ?? new EmergencyStop(label, {
      maxDailyLossSOL: config.maxDailyLossSOL ?? 2,
    });
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker(label, {
      maxPositionCount: config.maxConcurrentPositions,
      maxSinglePositionSOL: config.maxPositionSOL ?? 2,
      maxTotalExposureSOL: (config.maxPositionSOL ?? 2) * config.maxConcurrentPositions,
    });

    this.stats = {
      totalScans: 0,
      positionsOpened: 0,
      positionsClosed: 0,
      wins: 0,
      losses: 0,
      totalPnlLamports: new BN(0),
      startTime: Date.now(),
    };

    log.info({ label }, "Trading engine initialized");
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn({ label: this.label }, "Engine already running");
      return;
    }

    this.isRunning = true;
    this.stats.startTime = Date.now();
    log.info({ label: this.label }, "Starting trading engine");
    this.onEvent({ type: "engine:started" });

    // Sync circuit breaker with any existing positions (recovery scenario)
    const existingPositions = this.executor.getActivePositions();
    if (existingPositions.length > 0) {
      this.circuitBreaker.syncWithPositions(
        existingPositions.map((p) => ({
          poolAddress: p.poolAddress,
          entryAmountLamports: p.entryAmountX.add(p.entryAmountY).toNumber(),
        }))
      );
    }

    // CRON-style scanning
    this.scanInterval = setInterval(
      () => this.scanMarkets(),
      this.config.cronIntervalSeconds * 1000
    );

    // Check positions more frequently
    const checkIntervalSec = this.config.positionCheckIntervalSeconds ?? 10;
    this.positionCheckInterval = setInterval(
      () => this.checkPositions(),
      checkIntervalSec * 1000
    );

    // Periodic checkpoint (emit position:updated events for DB persistence)
    this.checkpointInterval = setInterval(
      () => this.emitPositionCheckpoints(),
      30_000 // every 30 seconds
    );

    log.info(
      { label: this.label, cronInterval: this.config.cronIntervalSeconds },
      "CRON jobs started"
    );

    // Initial scan (fire-and-forget — don't block engine startup)
    this.scanMarkets().catch((err) => {
      log.error(
        { label: this.label, err: err instanceof Error ? err.message : String(err) },
        "Initial market scan failed"
      );
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = null;
    }
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = null;
    }

    // Final position checkpoint before stopping
    this.emitPositionCheckpoints();

    log.info({ label: this.label }, "Trading engine stopped");
    this.onEvent({ type: "engine:stopped", stats: this.stats });
  }

  // ── Market Scanning ──

  private async scanMarkets(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    this.stats.totalScans++;

    try {
      // ── SAFETY CHECK 1: Emergency Stop ──
      const emergencyCheck = this.emergencyStop.canTrade();
      if (!emergencyCheck.allowed) {
        log.warn(
          { label: this.label, reason: emergencyCheck.reason },
          "Scan blocked by emergency stop"
        );
        this.onEvent({ type: "engine:error", error: `Emergency stop: ${emergencyCheck.reason}` });
        return;
      }

      const activePositions = this.executor.getActivePositions();
      if (activePositions.length >= this.config.maxConcurrentPositions) {
        log.debug(
          { label: this.label, active: activePositions.length },
          "Max positions reached, skipping scan"
        );
        return;
      }

      const balance = await this.executor.getBalance();
      const minRequired = this.config.minPositionSOL ?? 0.05;

      if (balance.toNumber() / LAMPORTS_PER_SOL < minRequired) {
        log.warn(
          {
            label: this.label,
            balance: balance.toNumber() / LAMPORTS_PER_SOL,
            minRequired,
          },
          "Insufficient balance"
        );
        return;
      }

      // Fetch and filter eligible pools
      const eligiblePools = await this.marketData.filterEligiblePools(
        this.config
      );

      // Remove pools on cooldown
      const afterCooldown = eligiblePools.filter((pool) => {
        const cooldown = this.cooldowns.get(pool.address);
        if (!cooldown) return true;
        const minutesSinceExit =
          (Date.now() - cooldown.exitTimestamp) / (1000 * 60);
        return minutesSinceExit >= this.config.cooldownMinutes;
      });

      // Remove pools where we already have an active position
      const activePoolAddresses = new Set(
        activePositions.map((p) => p.poolAddress)
      );
      const availablePools = afterCooldown.filter(
        (pool) => !activePoolAddresses.has(pool.address)
      );

      log.info(
        {
          label: this.label,
          eligible: eligiblePools.length,
          available: availablePools.length,
          scan: this.stats.totalScans,
        },
        "Pool filter results"
      );

      // Score, rank, and optionally apply ML predictions
      const strategyMode = this.config.strategyMode ?? "rule-based";
      const slotsAvailable =
        this.config.maxConcurrentPositions - activePositions.length;

      let topPools: { pool: MeteoraPairData; score: MarketScore; mlPrediction?: MLPrediction; mlFeatures?: V3Features }[] = [];

      if (strategyMode === "sage-ai" && this.mlPredictor?.isEnabled) {
        // ── Pure ML mode: use ML probability as entry criterion ──
        topPools = await this.scoreWithML(availablePools, slotsAvailable);
      } else if (strategyMode === "both" && this.mlPredictor?.isEnabled) {
        // ── Hybrid mode: rule-based filter + ML re-rank ──
        topPools = await this.scoreHybrid(availablePools, slotsAvailable);
      } else {
        // ── Rule-based mode (original) ──
        topPools = await this.scoreRuleBased(availablePools, slotsAvailable);
      }

      let entered = 0;
      for (const { pool, score, mlPrediction, mlFeatures } of topPools) {
        const ok = await this.enterPosition(pool, score, mlPrediction, mlFeatures);
        if (ok) entered++;
        await sleep(500);
      }

      this.onEvent({
        type: "scan:completed",
        eligible: eligiblePools.length,
        entered,
      });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : String(error);
      log.error({ label: this.label, err: msg }, "Error during market scan");
      this.onEvent({ type: "engine:error", error: msg });
    } finally {
      this.isScanning = false;
    }
  }

  // ── Scoring Strategies ──

  /**
   * Rule-based scoring (original FreesolGames-style).
   * Filters by entryScoreThreshold, ranks by totalScore.
   */
  private async scoreRuleBased(
    pools: MeteoraPairData[],
    slotsAvailable: number
  ): Promise<{ pool: MeteoraPairData; score: MarketScore }[]> {
    // Score ALL eligible pools — pure arithmetic, no I/O, ~400 pools is trivial
    const scoredPools = await Promise.all(
      pools.map(async (pool) => {
        const score = await this.marketData.calculateMarketScore(pool);
        return { pool, score };
      })
    );

    const qualifying = scoredPools
      .filter((p) => p.score.totalScore >= this.config.entryScoreThreshold)
      .sort((a, b) => b.score.totalScore - a.score.totalScore)
      .slice(0, slotsAvailable);

    if (qualifying.length > 0) {
      log.info(
        {
          label: this.label,
          mode: "rule-based",
          candidates: qualifying.length,
          topScore: qualifying[0].score.totalScore.toFixed(1),
          topPool: qualifying[0].pool.name,
        },
        "Entry candidates found"
      );
    } else {
      const topScored = scoredPools
        .sort((a, b) => b.score.totalScore - a.score.totalScore)
        .slice(0, 5);
      log.debug(
        {
          label: this.label,
          mode: "rule-based",
          threshold: this.config.entryScoreThreshold,
          poolsScored: scoredPools.length,
          bestScores: topScored.map((p) => ({
            name: p.pool.name,
            score: Math.round(p.score.totalScore),
          })),
        },
        "No pools met entry threshold"
      );
    }

    return qualifying;
  }

  /**
   * Pure ML scoring — uses XGBoost probability as the sole entry criterion.
   * Pools above the optimal threshold (0.8845) get entered.
   */
  private async scoreWithML(
    pools: MeteoraPairData[],
    slotsAvailable: number
  ): Promise<{ pool: MeteoraPairData; score: MarketScore; mlPrediction?: MLPrediction; mlFeatures?: V3Features }[]> {
    if (!this.mlPredictor) return [];

    // Extract features from top 30 pools (by raw volume, as a cheap pre-filter)
    const sortedByVolume = [...pools]
      .sort((a, b) => (b.volume?.hour_1 ?? 0) - (a.volume?.hour_1 ?? 0))
      .slice(0, 30);

    const featureData = sortedByVolume.map((pool) => ({
      pool,
      features: extractV3Features(pool),
      array: featuresToArray(extractV3Features(pool)),
    }));

    const predictions = await this.mlPredictor.predictBatch(
      featureData.map((d) => d.array),
      featureData.map((d) => d.pool.address)
    );

    if (!predictions) {
      log.warn({ label: this.label }, "ML prediction failed, falling back to rule-based");
      return this.scoreRuleBased(pools, slotsAvailable);
    }

    // Combine with market scores and filter by ML recommendation
    const results: { pool: MeteoraPairData; score: MarketScore; mlPrediction?: MLPrediction; mlFeatures?: V3Features }[] = [];

    for (let i = 0; i < featureData.length; i++) {
      const pred = predictions[i];
      if (pred.recommendation !== "enter") continue;

      const score = await this.marketData.calculateMarketScore(featureData[i].pool);
      results.push({
        pool: featureData[i].pool,
        score,
        mlPrediction: pred,
        mlFeatures: featureData[i].features,
      });
    }

    // Rank by ML probability (highest first)
    return results
      .sort((a, b) => (b.mlPrediction?.probability ?? 0) - (a.mlPrediction?.probability ?? 0))
      .slice(0, slotsAvailable);
  }

  /**
   * Hybrid scoring — rule-based filter + ML re-ranking.
   * First filters by entryScoreThreshold, then re-ranks by ML probability.
   * Only enters pools where BOTH rule-based AND ML agree.
   */
  private async scoreHybrid(
    pools: MeteoraPairData[],
    slotsAvailable: number
  ): Promise<{ pool: MeteoraPairData; score: MarketScore; mlPrediction?: MLPrediction; mlFeatures?: V3Features }[]> {
    if (!this.mlPredictor) return this.scoreRuleBased(pools, slotsAvailable);

    // Step 1: Score ALL eligible pools — pure arithmetic, no I/O
    const scoredPools = await Promise.all(
      pools.map(async (pool) => {
        const score = await this.marketData.calculateMarketScore(pool);
        return { pool, score };
      })
    );

    const candidates = scoredPools
      .filter((p) => p.score.totalScore >= this.config.entryScoreThreshold)
      .sort((a, b) => b.score.totalScore - a.score.totalScore)
      .slice(0, 10); // top 10 rule-based candidates

    if (candidates.length === 0) {
      const topScored = scoredPools
        .sort((a, b) => b.score.totalScore - a.score.totalScore)
        .slice(0, 5);
      log.debug(
        {
          label: this.label,
          mode: "hybrid",
          threshold: this.config.entryScoreThreshold,
          poolsScored: scoredPools.length,
          bestScores: topScored.map((p) => ({
            name: p.pool.name,
            score: Math.round(p.score.totalScore),
            volume1h: Math.round(p.score.volumeScore),
            liquidity: Math.round(p.score.liquidityScore),
            fee: Math.round(p.score.feeScore),
            momentum: Math.round(p.score.momentumScore),
          })),
        },
        "No rule-based candidates for ML re-ranking"
      );
      return [];
    }

    log.info(
      {
        label: this.label,
        mode: "hybrid",
        ruleCandidates: candidates.length,
        topScore: candidates[0].score.totalScore.toFixed(1),
        topPool: candidates[0].pool.name,
      },
      "Sending rule candidates to ML"
    );

    // Step 2: ML prediction on candidates
    const featureData = candidates.map(({ pool }) => ({
      features: extractV3Features(pool),
      array: featuresToArray(extractV3Features(pool)),
    }));

    const predictions = await this.mlPredictor.predictBatch(
      featureData.map((d) => d.array),
      candidates.map((c) => c.pool.address)
    );

    if (!predictions) {
      // ML unavailable — fall back to pure rule-based
      return candidates.slice(0, slotsAvailable);
    }

    // Step 3: Only enter where BOTH agree
    const results: { pool: MeteoraPairData; score: MarketScore; mlPrediction?: MLPrediction; mlFeatures?: V3Features }[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const pred = predictions[i];
      if (pred.recommendation !== "enter") continue;

      results.push({
        pool: candidates[i].pool,
        score: candidates[i].score,
        mlPrediction: pred,
        mlFeatures: featureData[i].features,
      });
    }

    // Rank by ML probability
    const final = results
      .sort((a, b) => (b.mlPrediction?.probability ?? 0) - (a.mlPrediction?.probability ?? 0))
      .slice(0, slotsAvailable);

    log.info(
      {
        label: this.label,
        mode: "hybrid",
        ruleCandidates: candidates.length,
        mlApproved: final.length,
        topPick: final[0] ? {
          pool: final[0].pool.name,
          ruleScore: final[0].score.totalScore.toFixed(1),
          mlProb: final[0].mlPrediction?.probability.toFixed(4),
        } : null,
      },
      "Hybrid scoring complete"
    );

    return final;
  }

  // ── Enter Position ──

  private async enterPosition(
    pool: MeteoraPairData,
    score: MarketScore,
    mlPrediction?: MLPrediction,
    mlFeatures?: V3Features
  ): Promise<boolean> {
    try {
      // ── SAFETY CHECK: Emergency Stop (re-check before each entry) ──
      const emergencyCheck = this.emergencyStop.canTrade();
      if (!emergencyCheck.allowed) {
        log.warn(
          { label: this.label, pool: pool.name, reason: emergencyCheck.reason },
          "Entry blocked by emergency stop"
        );
        return false;
      }

      const activeBin = await this.marketData.getActiveBin(pool.address);
      if (!activeBin) {
        log.warn({ pool: pool.name }, "Could not get active bin");
        this.emergencyStop.recordApiError();
        return false;
      }

      const binRange = this.config.defaultBinRange ?? 10;
      const strategy: StrategyParameters = {
        minBinId: activeBin.binId - binRange,
        maxBinId: activeBin.binId + binRange,
        strategyType: StrategyType.Spot,
      };

      const amountY = calculatePositionSize(
        this.config,
        await this.executor.getBalance()
      );
      const amountX = new BN(0); // One-sided SOL deposit

      // ── SAFETY CHECK: Circuit Breaker ──
      const totalAmount = amountX.add(amountY);
      const circuitCheck = this.circuitBreaker.canOpenPosition(pool.address, totalAmount);
      if (!circuitCheck.allowed) {
        log.info(
          { label: this.label, pool: pool.name, reason: circuitCheck.reason },
          "Entry blocked by circuit breaker"
        );
        return false;
      }

      const result = await this.executor.openPosition(
        pool.address,
        strategy,
        amountX,
        amountY
      );

      if (result.success && result.positionId) {
        this.stats.positionsOpened++;

        // Record in circuit breaker
        this.circuitBreaker.recordPositionOpened(pool.address, totalAmount);

        // Find the newly created position in the executor
        const newPos = this.executor
          .getActivePositions()
          .find((p) => p.id === result.positionId);

        if (newPos) {
          // Attach ML data to the position if available
          if (mlPrediction) {
            newPos.mlProbability = mlPrediction.probability;
          }
          if (mlFeatures) {
            newPos.entryFeatures = mlFeatures;
          }
          newPos.entryScore = score.totalScore;

          this.onEvent({
            type: "position:opened",
            position: newPos,
            score,
          });
        }

        log.info(
          {
            label: this.label,
            positionId: result.positionId,
            pool: pool.name,
            score: score.totalScore,
            mlProbability: mlPrediction?.probability,
            strategyMode: this.config.strategyMode,
          },
          "Position opened"
        );
        return true;
      }

      log.error(
        { pool: pool.name, error: result.error },
        "Failed to open position"
      );
      return false;
    } catch (error) {
      log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          pool: pool.name,
        },
        "Error entering position"
      );
      return false;
    }
  }

  // ── Check Positions ──

  private async checkPositions(): Promise<void> {
    const activePositions = this.executor.getActivePositions();
    if (activePositions.length === 0) return;

    for (const position of activePositions) {
      await this.checkExitConditions(position);
    }
  }

  private async checkExitConditions(position: TrackedPosition): Promise<void> {
    try {
      const updated = await this.executor.updatePositionData(position.id);
      if (!updated) return;

      const holdTimeMinutes =
        (Date.now() - position.entryTimestamp) / (1000 * 60);
      const entryPrice = parseFloat(position.entryPricePerToken);
      const currentPrice = updated.currentPricePerToken
        ? parseFloat(updated.currentPricePerToken)
        : entryPrice;
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

      let exitReason: string | null = null;

      // 1. Take profit
      if (
        position.profitTargetPercent &&
        pnlPercent >= position.profitTargetPercent
      ) {
        exitReason = `TAKE_PROFIT (${pnlPercent.toFixed(2)}% >= ${position.profitTargetPercent}%)`;
      }
      // 2. Trailing stop
      else if (
        position.trailingStopEnabled &&
        position.trailingStopPercent &&
        position.highWaterMarkPercent &&
        position.highWaterMarkPercent > position.trailingStopPercent
      ) {
        const trailingStopLevel =
          position.highWaterMarkPercent - position.trailingStopPercent;
        if (
          pnlPercent <= trailingStopLevel &&
          pnlPercent < position.highWaterMarkPercent
        ) {
          exitReason = `TRAILING_STOP (P&L ${pnlPercent.toFixed(2)}% from peak ${position.highWaterMarkPercent.toFixed(2)}%)`;
        }
      }
      // 3. Stop loss
      else if (
        position.stopLossPercent !== undefined &&
        pnlPercent <= -position.stopLossPercent
      ) {
        exitReason = `STOP_LOSS (${pnlPercent.toFixed(2)}% <= -${position.stopLossPercent}%)`;
      }
      // 4. Max hold time
      else if (
        position.maxHoldTimeMinutes &&
        holdTimeMinutes >= position.maxHoldTimeMinutes
      ) {
        exitReason = `MAX_HOLD_TIME (${holdTimeMinutes.toFixed(0)}m >= ${position.maxHoldTimeMinutes}m)`;
      }

      if (exitReason) {
        log.info(
          {
            label: this.label,
            positionId: position.id,
            pool: position.poolName,
            pnlPercent: pnlPercent.toFixed(2),
            reason: exitReason,
          },
          "Exiting position"
        );

        const result = await this.executor.closePosition(
          position.id,
          exitReason
        );

        if (result.success) {
          this.stats.positionsClosed++;

          if (result.realizedPnlLamports) {
            this.stats.totalPnlLamports = this.stats.totalPnlLamports.add(
              result.realizedPnlLamports
            );
            if (result.realizedPnlLamports.gtn(0)) {
              this.stats.wins++;
            } else {
              this.stats.losses++;
            }

            // Record in emergency stop (for daily/total loss tracking)
            const pnlSOL = result.realizedPnlLamports.toNumber() / LAMPORTS_PER_SOL;
            this.emergencyStop.recordTradeResult(pnlSOL);
          }

          // Record in circuit breaker
          const closedAmount = position.entryAmountX.add(position.entryAmountY);
          this.circuitBreaker.recordPositionClosed(position.poolAddress, closedAmount);

          // Set cooldown
          this.cooldowns.set(position.poolAddress, {
            poolAddress: position.poolAddress,
            exitTimestamp: Date.now(),
          });

          // Find the closed position in the executor for data
          const closedPos = this.executor
            .getActivePositions()
            .concat(
              (
                this.executor as unknown as {
                  getAllPositions?: () => TrackedPosition[];
                }
              ).getAllPositions?.() ?? []
            )
            .find((p) => p.id === position.id);

          this.onEvent({
            type: "position:closed",
            position: closedPos ?? position,
            pnlLamports: result.realizedPnlLamports ?? new BN(0),
          });
        }
      } else {
        // Emit update event
        this.onEvent({ type: "position:updated", position: updated });
      }
    } catch (error) {
      log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          positionId: position.id,
        },
        "Error checking exit conditions"
      );
      // Record API error — repeated position check failures may indicate
      // a systemic issue (RPC down, pool removed, etc.)
      this.emergencyStop.recordApiError();
    }
  }

  // ── Position Checkpointing ──

  /**
   * Emit position:updated events for all active positions.
   * Called periodically (every 30s) to flush in-memory state to orchestrator/DB.
   * Also called once on engine stop for final state capture.
   */
  private emitPositionCheckpoints(): void {
    const activePositions = this.executor.getActivePositions();
    for (const position of activePositions) {
      this.onEvent({ type: "position:updated", position });
    }
  }

  // ── Cooldown Management ──

  /**
   * Get all active cooldowns (for persistence).
   */
  getCooldowns(): Array<{ poolAddress: string; exitTimestamp: number }> {
    return Array.from(this.cooldowns.values());
  }

  /**
   * Restore cooldowns (after recovery/restart).
   */
  loadCooldowns(cooldowns: Array<{ poolAddress: string; exitTimestamp: number }>): void {
    for (const cd of cooldowns) {
      // Only load if still within cooldown window
      const minutesSinceExit = (Date.now() - cd.exitTimestamp) / (1000 * 60);
      if (minutesSinceExit < this.config.cooldownMinutes) {
        this.cooldowns.set(cd.poolAddress, cd);
      }
    }
    log.info(
      { label: this.label, loaded: this.cooldowns.size },
      "Cooldowns restored"
    );
  }

  // ── Public API ──

  getStats(): EngineStats & {
    winRate: number;
    runtime: string;
    safety: {
      emergencyStop: ReturnType<EmergencyStop["getSummary"]>;
      circuitBreaker: ReturnType<CircuitBreaker["getSummary"]>;
    };
  } {
    const winRate =
      this.stats.positionsClosed > 0
        ? (this.stats.wins / this.stats.positionsClosed) * 100
        : 0;
    const runtimeMs = Date.now() - this.stats.startTime;
    const hours = Math.floor(runtimeMs / (1000 * 60 * 60));
    const minutes = Math.floor(
      (runtimeMs % (1000 * 60 * 60)) / (1000 * 60)
    );

    return {
      ...this.stats,
      winRate,
      runtime: `${hours}h ${minutes}m`,
      safety: {
        emergencyStop: this.emergencyStop.getSummary(),
        circuitBreaker: this.circuitBreaker.getSummary(),
      },
    };
  }

  getActivePositions(): TrackedPosition[] {
    return this.executor.getActivePositions();
  }

  /**
   * Close a specific position by ID (user-initiated).
   */
  async closePositionById(
    positionId: string,
    reason = "USER_CLOSE"
  ): Promise<{ success: boolean; error?: string; pnlLamports?: number }> {
    const position = this.executor
      .getActivePositions()
      .find((p) => p.id === positionId);

    if (!position) {
      return { success: false, error: `Position ${positionId} not found` };
    }

    log.info(
      { label: this.label, positionId, pool: position.poolName, reason },
      "User-initiated position close"
    );

    const result = await this.executor.closePosition(positionId, reason);

    if (result.success) {
      this.stats.positionsClosed++;

      if (result.realizedPnlLamports) {
        this.stats.totalPnlLamports = this.stats.totalPnlLamports.add(
          result.realizedPnlLamports
        );
        if (result.realizedPnlLamports.gtn(0)) {
          this.stats.wins++;
        } else {
          this.stats.losses++;
        }

        const pnlSOL = result.realizedPnlLamports.toNumber() / LAMPORTS_PER_SOL;
        this.emergencyStop.recordTradeResult(pnlSOL);
      }

      const closedAmount = position.entryAmountX.add(position.entryAmountY);
      this.circuitBreaker.recordPositionClosed(position.poolAddress, closedAmount);

      this.cooldowns.set(position.poolAddress, {
        poolAddress: position.poolAddress,
        exitTimestamp: Date.now(),
      });

      this.onEvent({
        type: "position:closed",
        position,
        pnlLamports: result.realizedPnlLamports ?? new BN(0),
      });

      return {
        success: true,
        pnlLamports: result.realizedPnlLamports?.toNumber(),
      };
    }

    return { success: false, error: result.error };
  }

  async emergencyCloseAll(): Promise<void> {
    log.warn({ label: this.label }, "EMERGENCY: Closing all positions");

    const positions = this.executor.getActivePositions();
    for (const position of positions) {
      await this.executor.closePosition(position.id, "EMERGENCY_CLOSE");
      await sleep(500);
    }

    log.info({ label: this.label }, "All positions closed");
  }

  get running(): boolean {
    return this.isRunning;
  }
}
