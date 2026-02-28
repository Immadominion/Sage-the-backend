/**
 * BotOrchestrator — Multi-tenant bot lifecycle manager.
 *
 * Responsibilities:
 *  1. Convert DB bot row → BotConfig → TradingEngine
 *  2. Manage running engine instances (start/stop/emergency)
 *  3. Persist position open/close events to `positions` table
 *  4. Update bot stats in `bots` table
 *  5. Emit events via EventBus for real-time push (WebSocket in S3)
 *  6. Recover running bots on server restart
 *
 * Design:
 *  - Singleton (one per backend process)
 *  - All bots share a single SharedAPICache (prevents rate limiting)
 *  - All bots share a single Solana Connection
 *  - SimulationExecutor per bot instance (virtual balance isolation)
 */

import { Connection } from "@solana/web3.js";
import BN from "bn.js";
import config from "../config.js";
import db from "../db/index.js";
import { bots, positions, tradeLog } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { eventBus } from "./event-bus.js";
import { TradingEngine, type EngineEvent, type EngineStats } from "./trading-engine.js";
import { SimulationExecutor } from "./simulation-executor.js";
import { LiveExecutor } from "./live-executor.js";
import { WalletManager } from "./wallet-manager.js";
import { MarketDataProvider } from "./market-data.js";
import { MLPredictor } from "./ml-predictor.js";
import { EmergencyStop } from "./emergency-stop.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { getSharedCache } from "./shared-cache.js";
import type { BotConfig, TrackedPosition, MarketScore, StrategyMode, ITradingExecutor } from "./types.js";
import { LAMPORTS_PER_SOL } from "./types.js";

const log = logger.child({ module: "orchestrator" });

// ═══════════════════════════════════════════════════════════════
// Running bot instance
// ═══════════════════════════════════════════════════════════════

interface RunningBot {
  botId: string;
  userId: number;
  engine: TradingEngine;
  executor: ITradingExecutor;
  marketData: MarketDataProvider;
  mlPredictor: MLPredictor | null;
  emergencyStop: EmergencyStop;
  circuitBreaker: CircuitBreaker;
  walletManager?: WalletManager;
  startedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// DB bot row type (inferred from Drizzle select)
// ═══════════════════════════════════════════════════════════════

type BotRow = typeof bots.$inferSelect;

// ═══════════════════════════════════════════════════════════════
// BotOrchestrator
// ═══════════════════════════════════════════════════════════════

export class BotOrchestrator {
  private static instance: BotOrchestrator | null = null;

  private connection: Connection;
  private runningBots = new Map<string, RunningBot>();
  private sharedMLPredictor: MLPredictor;
  /** Lock set to prevent concurrent start/stop operations on the same bot */
  private botLocks = new Set<string>();

  private constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
    this.sharedMLPredictor = new MLPredictor({
      baseUrl: config.ML_SERVICE_URL ?? "http://127.0.0.1:8100",
      timeoutMs: 5000,
      enabled: true,
      apiKey: config.ML_API_KEY,
    });
    log.info(
      { rpc: config.SOLANA_RPC_URL, mlUrl: config.ML_SERVICE_URL ?? "http://127.0.0.1:8100" },
      "BotOrchestrator initialized"
    );
  }

  static getInstance(): BotOrchestrator {
    if (!BotOrchestrator.instance) {
      BotOrchestrator.instance = new BotOrchestrator();
    }
    return BotOrchestrator.instance;
  }

  // ═══════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start a bot by ID. Creates TradingEngine + executor (Simulation or Live),
   * begins the scan/entry/exit loop.
   */
  async startBot(botId: string, userId: number): Promise<void> {
    // Prevent concurrent start/stop on the same bot
    if (this.botLocks.has(botId)) {
      throw new Error(`Bot ${botId} is already being started or stopped`);
    }
    this.botLocks.add(botId);

    try {
      await this._startBot(botId, userId);
    } finally {
      this.botLocks.delete(botId);
    }
  }

  private async _startBot(botId: string, userId: number): Promise<void> {
    if (this.runningBots.has(botId)) {
      log.warn({ botId }, "Bot already running in orchestrator");
      return;
    }

    const botRow = this.getBotRow(botId, userId);
    if (!botRow) {
      throw new Error(`Bot ${botId} not found for user ${userId}`);
    }

    const botConfig = this.botRowToConfig(botRow);
    const isLiveMode = botRow.mode === "live";

    // Create per-bot MarketDataProvider (shares SharedAPICache singleton)
    const marketData = new MarketDataProvider(this.connection, botConfig);

    // Create MLPredictor if bot uses AI mode
    const strategyMode = (botRow.strategyMode ?? "rule-based") as StrategyMode;
    const needsML = strategyMode === "sage-ai" || strategyMode === "both";
    const mlPredictor = needsML ? this.sharedMLPredictor : null;

    if (needsML) {
      const health = await this.sharedMLPredictor.checkHealth();
      if (!health) {
        log.warn(
          { botId, strategyMode },
          "ML service unavailable — bot will fall back to rule-based"
        );
      } else {
        log.info(
          { botId, model: health.model, threshold: health.threshold },
          "ML service connected"
        );
      }
    }

    // Create safety systems per-bot
    // Restore saved emergency stop state if available (survives restarts)
    let savedEmergencyState: import("./emergency-stop.js").EmergencyStopState | undefined;
    if (botRow.emergencyStopState) {
      const restored = EmergencyStop.deserializeState(botRow.emergencyStopState);
      if (restored) {
        savedEmergencyState = restored;
        log.info(
          { botId, totalPnl: restored.totalPnlSOL.toFixed(4), consecutiveLosses: restored.consecutiveLosses },
          "Restored EmergencyStop state from DB"
        );
      }
    }

    const emergencyStop = new EmergencyStop(botId, {
      maxDailyLossSOL: botConfig.maxDailyLossSOL ?? 2,
      maxTotalLossSOL: (botConfig.maxDailyLossSOL ?? 2) * 3,
      maxConsecutiveLosses: 5,
      maxTxFailuresPerHour: 10,
      maxApiErrorsPerHour: 50,
    }, savedEmergencyState);

    const circuitBreaker = new CircuitBreaker(botId, {
      maxPositionCount: botConfig.maxConcurrentPositions,
      maxPositionsPerPool: 1,
      maxSinglePositionSOL: botConfig.maxPositionSOL ?? 2,
      maxTotalExposureSOL: (botConfig.maxPositionSOL ?? 2) * botConfig.maxConcurrentPositions,
    });

    // Wire emergency stop callback — auto-close positions and stop engine
    emergencyStop.onTrigger(async (reason) => {
      log.error({ botId, reason }, "Emergency stop triggered — auto-closing all positions");
      try {
        const running = this.runningBots.get(botId);
        if (running) {
          await running.engine.emergencyCloseAll();
          await running.engine.stop();
        }
        db.update(bots)
          .set({
            status: "error",
            lastError: `Emergency stop: ${reason}`,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(bots.botId, botId))
          .run();
        eventBus.emitBotEvent("engine:error", botId, userId, {
          error: `Emergency stop: ${reason}`,
          severity: "critical",
        });
      } catch (err) {
        log.error(
          { botId, err: err instanceof Error ? err.message : String(err) },
          "Error during emergency stop auto-close"
        );
      }
    });

    // ── Create executor: Live or Simulation ──
    let executor: ITradingExecutor;
    let walletManager: WalletManager | undefined;

    if (isLiveMode) {
      // LIVE MODE — real DLMM transactions
      walletManager = new WalletManager(this.connection, {
        maxExposureSOL: (botConfig.maxPositionSOL ?? 2) * botConfig.maxConcurrentPositions,
      });

      // Load wallet from file or env
      if (config.WALLET_PATH) {
        walletManager.loadFromFile(config.WALLET_PATH);
      } else if (config.WALLET_PRIVATE_KEY) {
        walletManager.loadFromEnv("WALLET_PRIVATE_KEY");
      } else {
        throw new Error(
          "Live mode requires WALLET_PATH or WALLET_PRIVATE_KEY environment variable"
        );
      }

      walletManager.confirm(); // Safety gate — we explicitly confirm

      executor = new LiveExecutor(
        this.connection,
        walletManager,
        marketData,
        botConfig,
        emergencyStop,
        circuitBreaker
      );

      log.warn(
        { botId, wallet: walletManager.getPublicKey().toBase58().slice(0, 8) + "…" },
        "LIVE executor created — REAL MONEY MODE"
      );
    } else {
      // SIMULATION MODE — virtual balance, real market data
      executor = new SimulationExecutor(
        botConfig,
        marketData,
        botRow.simulationBalanceSOL
      );
      log.info({ botId }, "Simulation executor created");
    }

    // Create TradingEngine with event callback, ML predictor, and safety systems
    const engine = new TradingEngine(
      botConfig,
      executor,
      marketData,
      (event) => this.handleEngineEvent(botId, userId, event),
      botId,
      mlPredictor,
      emergencyStop,
      circuitBreaker
    );

    const running: RunningBot = {
      botId,
      userId,
      engine,
      executor,
      marketData,
      mlPredictor,
      emergencyStop,
      circuitBreaker,
      walletManager,
      startedAt: Date.now(),
    };

    this.runningBots.set(botId, running);

    // Start the engine (async — begins scanning)
    await engine.start();

    log.info({ botId, userId, mode: botRow.mode }, "Bot started");
  }

  /**
   * Stop a bot gracefully. Engine stops scanning but doesn't close positions.
   */
  async stopBot(botId: string): Promise<void> {
    // Prevent concurrent start/stop on the same bot
    if (this.botLocks.has(botId)) {
      throw new Error(`Bot ${botId} is already being started or stopped`);
    }
    this.botLocks.add(botId);

    try {
      const running = this.runningBots.get(botId);
      if (!running) {
        log.warn({ botId }, "Bot not running in orchestrator");
        return;
      }

      // Persist EmergencyStop state before stopping
      this.persistEmergencyStopState(botId);

      await running.engine.stop();
      this.runningBots.delete(botId);

      log.info({ botId }, "Bot stopped");
    } finally {
      this.botLocks.delete(botId);
    }
  }

  /**
   * Emergency stop — trigger the safety system which auto-closes positions.
   */
  async emergencyStop(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      log.warn({ botId }, "Bot not running in orchestrator for emergency");
      return;
    }

    // Trigger via safety system — this fires the onTrigger callback
    // which handles auto-close + DB update + event emission
    running.emergencyStop.manualTrigger("Manual emergency stop via API");

    // Also clean up orchestrator state
    this.runningBots.delete(botId);

    log.warn({ botId }, "Bot emergency stopped via safety system");
  }

  /**
   * Stop ALL running bots (used on server shutdown).
   */
  async stopAll(): Promise<void> {
    log.info(
      { count: this.runningBots.size },
      "Stopping all running bots"
    );

    const stopPromises: Promise<void>[] = [];
    for (const [botId] of this.runningBots) {
      stopPromises.push(this.stopBot(botId));
    }
    await Promise.allSettled(stopPromises);

    log.info("All bots stopped");
  }

  /**
   * Persist EmergencyStop state to DB for a running bot.
   * Called after every trade result to survive restarts.
   */
  private persistEmergencyStopState(botId: string): void {
    const running = this.runningBots.get(botId);
    if (!running) return;

    try {
      const stateJson = running.emergencyStop.serializeState();
      db.update(bots)
        .set({ emergencyStopState: stateJson })
        .where(eq(bots.botId, botId))
        .run();
    } catch (err) {
      log.error(
        { botId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist EmergencyStop state"
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Recovery
  // ═══════════════════════════════════════════════════════════════

  /**
   * On server startup, check for bots that were "running" in DB
   * and restart them.
   */
  async recoverRunningBots(): Promise<number> {
    const runningBots = db
      .select()
      .from(bots)
      .where(eq(bots.status, "running"))
      .all();

    if (runningBots.length === 0) {
      log.info("No bots to recover");
      return 0;
    }

    log.info(
      { count: runningBots.length },
      "Recovering running bots"
    );

    let recovered = 0;
    for (const bot of runningBots) {
      try {
        await this.startBot(bot.botId, bot.userId);
        recovered++;
      } catch (error) {
        log.error(
          {
            botId: bot.botId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Failed to recover bot"
        );

        // Mark as error in DB
        db.update(bots)
          .set({
            status: "error",
            lastError: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(bots.botId, bot.botId))
          .run();
      }
    }

    log.info({ recovered, total: runningBots.length }, "Recovery complete");
    return recovered;
  }

  // ═══════════════════════════════════════════════════════════════
  // Query
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get engine stats for a running bot.
   */
  getEngineStats(botId: string): (EngineStats & { winRate: number; runtime: string }) | null {
    const running = this.runningBots.get(botId);
    if (!running) return null;
    return running.engine.getStats();
  }

  /**
   * Get active positions for a running bot (in-memory, real-time).
   */
  getActivePositions(botId: string): TrackedPosition[] {
    const running = this.runningBots.get(botId);
    if (!running) return [];
    return running.engine.getActivePositions();
  }

  /**
   * Get all live positions across all running bots for a user.
   */
  getAllLivePositions(userId: number): TrackedPosition[] {
    const result: TrackedPosition[] = [];
    for (const [, running] of this.runningBots) {
      if (running.userId === userId) {
        result.push(...running.engine.getActivePositions());
      }
    }
    return result;
  }

  /**
   * Get performance summary for a running bot.
   */
  getPerformanceSummary(botId: string) {
    const running = this.runningBots.get(botId);
    if (!running) return null;
    return running.executor.getPerformanceSummary();
  }

  /**
   * Close a specific position by ID (user-initiated).
   * Finds the bot that owns the position and delegates to its engine.
   */
  async closePosition(
    positionId: string,
    userId: number,
    reason = "USER_CLOSE"
  ): Promise<{ success: boolean; error?: string; pnlLamports?: number }> {
    // Find which running bot has this position
    for (const [botId, running] of this.runningBots) {
      if (running.userId !== userId) continue;

      const positions = running.engine.getActivePositions();
      const hasPosition = positions.some((p) => p.id === positionId);

      if (hasPosition) {
        log.info(
          { botId, positionId, reason },
          "Closing position via orchestrator"
        );
        return running.engine.closePositionById(positionId, reason);
      }
    }

    return { success: false, error: `Position ${positionId} not found in any running bot` };
  }

  /**
   * Check if a bot is running in the orchestrator.
   */
  isRunning(botId: string): boolean {
    return this.runningBots.has(botId);
  }

  /**
   * Get count of running bots.
   */
  get runningCount(): number {
    return this.runningBots.size;
  }

  /**
   * Get shared cache stats.
   */
  getCacheStats() {
    return getSharedCache().getStats();
  }

  // ═══════════════════════════════════════════════════════════════
  // Engine Event Handler
  // ═══════════════════════════════════════════════════════════════

  private handleEngineEvent(
    botId: string,
    userId: number,
    event: EngineEvent
  ): void {
    switch (event.type) {
      case "position:opened":
        this.onPositionOpened(botId, userId, event.position, event.score);
        break;
      case "position:closed":
        this.onPositionClosed(botId, userId, event.position, event.pnlLamports);
        break;
      case "position:updated":
        this.onPositionUpdated(botId, userId, event.position);
        break;
      case "scan:completed":
        this.onScanCompleted(botId, userId, event.eligible, event.entered);
        break;
      case "engine:started":
        eventBus.emitBotEvent("engine:started", botId, userId);
        break;
      case "engine:stopped":
        eventBus.emitBotEvent("engine:stopped", botId, userId, {
          stats: this.serializeStats(event.stats),
        });
        break;
      case "engine:error":
        this.onEngineError(botId, userId, event.error);
        break;
    }
  }

  // ── Position Opened ──

  private onPositionOpened(
    botId: string,
    userId: number,
    position: TrackedPosition,
    score: MarketScore
  ): void {
    try {
      // Insert into positions table
      db.insert(positions)
        .values({
          positionId: position.id,
          botId,
          userId,
          status: "active",
          poolAddress: position.poolAddress,
          poolName: position.poolName,
          tokenXMint: position.tokenXMint,
          tokenYMint: position.tokenYMint,
          binStep: position.binStep,
          entryActiveBinId: position.entryActiveBinId,
          entryPricePerToken: position.entryPricePerToken,
          entryTimestamp: position.entryTimestamp,
          entryAmountXLamports: position.entryAmountX.toNumber(),
          entryAmountYLamports: position.entryAmountY.toNumber(),
          entryTxSignature: position.entryTxSignature,
          entryScore: score.totalScore,
          mlProbability: position.mlProbability ?? null,
          entryFeatures: position.entryFeatures
            ? JSON.stringify(position.entryFeatures)
            : null,
          profitTargetPercent: position.profitTargetPercent,
          stopLossPercent: position.stopLossPercent,
          maxHoldTimeMinutes: position.maxHoldTimeMinutes,
        })
        .run();

      // Log to trade_log
      db.insert(tradeLog)
        .values({
          botId,
          userId,
          positionId: position.id,
          event: "position_opened",
          details: JSON.stringify({
            pool: position.poolName,
            poolAddress: position.poolAddress,
            entryPrice: position.entryPricePerToken,
            score: score.totalScore,
            amountY: position.entryAmountY.toString(),
          }),
        })
        .run();

      // Update bot activity
      db.update(bots)
        .set({
          lastActivityAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bots.botId, botId))
        .run();

      // Emit event for WebSocket
      eventBus.emitBotEvent("position:opened", botId, userId, {
        positionId: position.id,
        pool: position.poolName,
        entryPrice: position.entryPricePerToken,
        score: score.totalScore,
      });
    } catch (error) {
      log.error(
        {
          botId,
          positionId: position.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist position open"
      );
    }
  }

  // ── Position Closed ──

  private onPositionClosed(
    botId: string,
    userId: number,
    position: TrackedPosition,
    pnlLamports: BN
  ): void {
    try {
      // Update position in DB
      db.update(positions)
        .set({
          status: "closed",
          exitPricePerToken: position.exitPricePerToken,
          exitTimestamp: position.exitTimestamp ?? Date.now(),
          exitReason: position.exitReason,
          realizedPnlLamports: pnlLamports.toNumber(),
          feesEarnedXLamports: position.feesEarnedX?.toNumber() ?? 0,
          feesEarnedYLamports: position.feesEarnedY?.toNumber() ?? 0,
          txCostLamports:
            (position.entryTxCostLamports ?? 0) +
            (position.exitTxCostLamports ?? 0),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(positions.positionId, position.id))
        .run();

      // Update bot stats
      const isWin = pnlLamports.gtn(0);
      const botRow = db.select().from(bots).where(eq(bots.botId, botId)).get();
      if (botRow) {
        db.update(bots)
          .set({
            totalTrades: botRow.totalTrades + 1,
            winningTrades: botRow.winningTrades + (isWin ? 1 : 0),
            totalPnlLamports:
              botRow.totalPnlLamports + pnlLamports.toNumber(),
            lastActivityAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(bots.botId, botId))
          .run();
      }

      // Log to trade_log
      db.insert(tradeLog)
        .values({
          botId,
          userId,
          positionId: position.id,
          event: "position_closed",
          details: JSON.stringify({
            pool: position.poolName,
            exitPrice: position.exitPricePerToken,
            reason: position.exitReason,
            pnlLamports: pnlLamports.toString(),
            pnlSol: (pnlLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(6),
            result: isWin ? "WIN" : "LOSS",
          }),
        })
        .run();

      // Emit event
      const pnlSol = pnlLamports.toNumber() / LAMPORTS_PER_SOL;
      eventBus.emitBotEvent("position:closed", botId, userId, {
        positionId: position.id,
        pool: position.poolName,
        exitPrice: position.exitPricePerToken,
        reason: position.exitReason,
        pnlSol,
        result: isWin ? "WIN" : "LOSS",
      });

      // Persist EmergencyStop state after trade result is recorded
      // (the TradingEngine calls emergencyStop.recordTradeResult before emitting this event)
      this.persistEmergencyStopState(botId);
    } catch (error) {
      log.error(
        {
          botId,
          positionId: position.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist position close"
      );
    }
  }

  // ── Position Updated ──

  private onPositionUpdated(
    botId: string,
    _userId: number,
    position: TrackedPosition
  ): void {
    // Checkpoint position state to DB periodically.
    // These come from the 30s checkpoint interval in TradingEngine.
    // Persist current price + unrealized PnL so data survives server restarts.
    try {
      const currentPrice = position.currentPricePerToken ?? position.entryPricePerToken;
      const entryPrice = parseFloat(position.entryPricePerToken);
      const current = parseFloat(currentPrice);
      const entryLamports = position.entryAmountY.toNumber();
      const unrealizedPnlLamports = entryPrice > 0
        ? Math.round(((current - entryPrice) / entryPrice) * entryLamports)
        : 0;

      db.update(positions)
        .set({
          currentPricePerToken: currentPrice,
          unrealizedPnlLamports,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(positions.positionId, position.id))
        .run();
    } catch (error) {
      log.error(
        {
          botId,
          positionId: position.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to checkpoint position"
      );
    }
  }

  // ── Scan Completed ──

  private onScanCompleted(
    botId: string,
    userId: number,
    eligible: number,
    entered: number
  ): void {
    // Only emit events for scans that resulted in entries
    if (entered > 0) {
      eventBus.emitBotEvent("scan:completed", botId, userId, {
        eligible,
        entered,
      });
    }

    // Update activity timestamp
    db.update(bots)
      .set({
        lastActivityAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(bots.botId, botId))
      .run();
  }

  // ── Engine Error ──

  private onEngineError(
    botId: string,
    userId: number,
    error: string
  ): void {
    log.error({ botId, error }, "Engine error");

    db.update(bots)
      .set({
        lastError: error,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(bots.botId, botId))
      .run();

    eventBus.emitBotEvent("engine:error", botId, userId, { error });
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Convert a DB bot row to BotConfig.
   */
  private botRowToConfig(row: BotRow): BotConfig {
    return {
      mode: row.mode === "live" ? "LIVE" : "SIMULATION",
      rpcEndpoint: config.SOLANA_RPC_URL,
      strategyMode: (row.strategyMode ?? "rule-based") as StrategyMode,

      // Entry criteria
      entryScoreThreshold: row.entryScoreThreshold,
      minVolume24h: row.minVolume24h,
      minLiquidity: row.minLiquidity,
      maxLiquidity: row.maxLiquidity,

      // Token filtering
      solPairsOnly: true,
      blacklist: [],

      // Position sizing
      positionSizeSOL: row.positionSizeSOL,
      maxPositionSOL: row.positionSizeSOL * 2,
      minPositionSOL: 0.05,
      defaultBinRange: row.defaultBinRange,

      // Risk management
      profitTargetPercent: row.profitTargetPercent,
      stopLossPercent: row.stopLossPercent,
      maxHoldTimeMinutes: row.maxHoldTimeMinutes,
      maxConcurrentPositions: row.maxConcurrentPositions,
      maxDailyLossSOL: row.maxDailyLossSOL,
      cooldownMinutes: row.cooldownMinutes,

      // Scheduler
      cronIntervalSeconds: row.cronIntervalSeconds,
      positionCheckIntervalSeconds: 10,

      // Simulation
      simulation: {
        initialBalanceSOL: row.simulationBalanceSOL,
      },
    };
  }

  /**
   * Fetch a bot row from DB.
   */
  private getBotRow(
    botId: string,
    userId: number
  ): BotRow | undefined {
    return db
      .select()
      .from(bots)
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)))
      .get();
  }

  /**
   * Serialize engine stats for JSON (BN → number).
   */
  private serializeStats(stats: EngineStats): Record<string, unknown> {
    return {
      totalScans: stats.totalScans,
      positionsOpened: stats.positionsOpened,
      positionsClosed: stats.positionsClosed,
      wins: stats.wins,
      losses: stats.losses,
      totalPnlLamports: stats.totalPnlLamports.toNumber(),
      totalPnlSol: stats.totalPnlLamports.toNumber() / LAMPORTS_PER_SOL,
      startTime: stats.startTime,
    };
  }

  /**
   * Reset singleton (for testing).
   */
  static async reset(): Promise<void> {
    if (BotOrchestrator.instance) {
      await BotOrchestrator.instance.stopAll();
      BotOrchestrator.instance = null;
    }
  }
}

export const orchestrator = BotOrchestrator.getInstance();
