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
import { bots, positions, tradeLog, botDecisions, feeLedger } from "../db/schema.js";
import { eq, and, lt, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { eventBus } from "./event-bus.js";
import { TradingEngine, type EngineEvent, type EngineStats, type ScanDecision } from "./trading-engine.js";
import { SimulationExecutor } from "./simulation-executor.js";
import { BotKeypairExecutor } from "./bot-keypair-executor.js";
import { MarketDataProvider } from "./market-data.js";
import { MLPredictor } from "./ml-predictor.js";
import { EmergencyStop } from "./emergency-stop.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { getSharedCache } from "./shared-cache.js";
import { LlmTrader } from "./llm-trader.js";
import { decryptString } from "./crypto-utils.js";
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
  llmTrader: LlmTrader | null;
  emergencyStop: EmergencyStop;
  circuitBreaker: CircuitBreaker;
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
    this.sharedMLPredictor = new MLPredictor({ enabled: true });
    log.info(
      { rpc: config.SOLANA_RPC_URL, mlLoaded: this.sharedMLPredictor.isHealthy },
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

    const botRow = await this.getBotRow(botId, userId);
    if (!botRow) {
      throw new Error(`Bot ${botId} not found for user ${userId}`);
    }

    const botConfig = this.botRowToConfig(botRow);
    const isLiveMode = botRow.mode === "live";

    // ── CRITICAL: Block live mode on devnet ──
    // DLMM pools only exist on mainnet. Live trading on devnet is impossible.
    if (isLiveMode && config.SOLANA_NETWORK !== "mainnet-beta") {
      throw new Error(
        `Live trading requires SOLANA_NETWORK=mainnet-beta (current: ${config.SOLANA_NETWORK}). ` +
        `Meteora DLMM pools only exist on mainnet. Use simulation mode for testing.`
      );
    }

    // Create per-bot MarketDataProvider (shares SharedAPICache singleton)
    const marketData = new MarketDataProvider(this.connection, botConfig);

    // Create MLPredictor if bot uses AI mode
    const strategyMode = (botRow.strategyMode ?? "rule-based") as StrategyMode;
    const needsML = strategyMode === "aura-ai" || strategyMode === "both";
    const mlPredictor = needsML ? this.sharedMLPredictor : null;

    if (needsML) {
      const health = await this.sharedMLPredictor.checkHealth();
      if (!health) {
        throw new Error(
          `ML model could not be loaded but strategyMode="${strategyMode}" requires it. ` +
          `Ensure models/lp_predictor_v3_latest.json exists in the project root, ` +
          `or change strategyMode to "rule-based".`
        );
      }
      log.info(
        { botId, model: health.model, threshold: health.threshold },
        "ML model ready (in-process)"
      );
    }

    // Create LlmTrader if bot uses LLM mode
    let llmTrader: LlmTrader | null = null;
    if (strategyMode === "llm") {
      if (!botRow.encryptedLlmApiKey) {
        throw new Error(
          `LLM mode requires an Anthropic API key — encryptedLlmApiKey is not set on bot ${botId}. ` +
          `Set the key via the bot settings API before starting in llm mode.`
        );
      }
      try {
        const apiKey = decryptString(botRow.encryptedLlmApiKey, config.MASTER_ENCRYPTION_KEY);
        llmTrader = new LlmTrader({
          apiKey,
          model: botRow.llmModel ?? undefined,
          maxPoolsPerCall: botRow.llmMaxPoolsPerCall ?? undefined,
          maxUsdPerDay: botRow.llmMaxUsdPerDay ?? undefined,
        });
        log.info(
          { botId, model: botRow.llmModel ?? "claude-haiku-4-5-20251001", maxUsdPerDay: botRow.llmMaxUsdPerDay },
          "LLM trader created"
        );
      } catch (err) {
        throw new Error(
          `Failed to decrypt LLM API key for bot ${botId}: ${err instanceof Error ? err.message : String(err)}`
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

    // If the emergency stop was triggered in a previous session, reset the
    // trigger flag so the bot can trade again. The user explicitly chose to
    // restart, so honour that intent. Loss counters are preserved — if the
    // bot immediately hits the same limit it will re-trigger.
    if (savedEmergencyState?.isTriggered) {
      emergencyStop.reset();
      // Also reset consecutive losses so the bot gets a fresh chance
      emergencyStop.fullReset();
      log.info(
        { botId },
        "Emergency stop was previously triggered — full reset for fresh start"
      );
    }

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
          // Persist virtual balance before emergency shutdown
          await this.persistVirtualBalance(botId);
          await running.engine.emergencyCloseAll();
          await running.engine.stop();
        }
        await db.update(bots)
          .set({
            status: "error",
            lastError: `Emergency stop: ${reason}`,
            updatedAt: new Date(),
          })
          .where(eq(bots.botId, botId));
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

    if (isLiveMode) {
      // LIVE MODE — Server-side encrypted keypair execution.
      // Each bot has its own Solana keypair, encrypted at rest with
      // AES-256-GCM. The keypair is decrypted in-memory only while running.

      if (!botRow.encryptedPrivateKey) {
        throw new Error(
          "Live mode requires a wallet keypair — encryptedPrivateKey is missing. " +
          "Delete this bot and create a new one."
        );
      }

      executor = new BotKeypairExecutor(
        this.connection,
        botRow.encryptedPrivateKey,
        config.MASTER_ENCRYPTION_KEY,
        marketData,
        botConfig,
        emergencyStop,
        circuitBreaker
      );

      log.info(
        {
          botId,
          walletAddress: botRow.walletAddress?.slice(0, 8) + "…",
        },
        "Live executor created — server-side keypair"
      );
    } else {
      // SIMULATION MODE — virtual balance, real market data
      // Restore persisted balance if available (survives restarts / stops)
      const restoredBalanceSol = botRow.currentVirtualBalanceLamports != null
        ? botRow.currentVirtualBalanceLamports / LAMPORTS_PER_SOL
        : botRow.simulationBalanceSOL;

      executor = new SimulationExecutor(
        botConfig,
        marketData,
        restoredBalanceSol
      );
      log.info(
        {
          botId,
          balanceSol: restoredBalanceSol.toFixed(4),
          restored: botRow.currentVirtualBalanceLamports != null,
        },
        "Simulation executor created"
      );
    }

    // Create TradingEngine with event callback, ML predictor, LLM trader, and safety systems
    const engine = new TradingEngine(
      botConfig,
      executor,
      marketData,
      (event) => this.handleEngineEvent(botId, userId, event),
      botId,
      mlPredictor,
      emergencyStop,
      circuitBreaker,
      llmTrader
    );

    const running: RunningBot = {
      botId,
      userId,
      engine,
      executor,
      marketData,
      mlPredictor,
      llmTrader,
      emergencyStop,
      circuitBreaker,
      startedAt: Date.now(),
    };

    this.runningBots.set(botId, running);

    // Start the engine (async — begins scanning)
    await engine.start();

    log.info({ botId, userId, mode: botRow.mode }, "Bot started");
  }

  /**
   * Stop a bot gracefully. Engine stops scanning but doesn't close positions.
   * Any active positions that were being tracked become orphans — they still
   * exist on-chain but no bot is monitoring them. We mark them in the DB so
   * the reconciliation endpoint (and the UI) can surface them.
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

      // Persist virtual balance before engine is destroyed
      await this.persistVirtualBalance(botId);

      // Mark any active positions as orphaned before removing the engine
      const activePositions = running.engine.getActivePositions();
      if (activePositions.length > 0) {
        log.info(
          { botId, count: activePositions.length },
          "Marking active positions as orphaned before bot stop"
        );
        for (const pos of activePositions) {
          await db
            .update(positions)
            .set({ status: "orphaned", updatedAt: new Date() })
            .where(eq(positions.positionId, pos.id));
        }
      }

      await running.engine.stop();

      // Zeroize decrypted keypair material (live mode only)
      if ('destroy' in running.executor && typeof running.executor.destroy === 'function') {
        running.executor.destroy();
      }

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

    // Zeroize keypair material
    if ('destroy' in running.executor && typeof running.executor.destroy === 'function') {
      running.executor.destroy();
    }

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
  private async persistEmergencyStopState(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) return;

    try {
      const stateJson = running.emergencyStop.serializeState();
      await db.update(bots)
        .set({ emergencyStopState: stateJson })
        .where(eq(bots.botId, botId));
    } catch (err) {
      log.error(
        { botId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist EmergencyStop state"
      );
    }
  }

  /**
   * Persist the simulation executor's virtual balance to DB.
   * Called on position open/close and bot stop so the balance
   * survives restarts and is visible via API when the bot is stopped.
   */
  private async persistVirtualBalance(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) return;

    try {
      const balance = await running.executor.getBalance();
      await db.update(bots)
        .set({
          currentVirtualBalanceLamports: balance.toNumber(),
          updatedAt: new Date(),
        })
        .where(eq(bots.botId, botId));
    } catch (err) {
      log.error(
        { botId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist virtual balance"
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
    const runningBots = await db
      .select()
      .from(bots)
      .where(eq(bots.status, "running"));

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
        await db.update(bots)
          .set({
            status: "error",
            lastError: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
            updatedAt: new Date(),
          })
          .where(eq(bots.botId, bot.botId));

        // Mark any active positions from this failed bot as orphaned
        await db
          .update(positions)
          .set({ status: "orphaned", updatedAt: new Date() })
          .where(
            and(
              eq(positions.botId, bot.botId),
              eq(positions.status, "active")
            )
          );
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
      case "fee:charged":
        this.onFeeCharged(botId, userId, event);
        break;
      case "scan:completed":
        this.onScanCompleted(botId, userId, event.eligible, event.entered, event.scanId, event.decisions);
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
      case "engine:warning":
        eventBus.emitBotEvent("engine:warning", botId, userId, {
          message: event.message,
        });
        break;
    }
  }

  // ── Position Opened ──

  private async onPositionOpened(
    botId: string,
    userId: number,
    position: TrackedPosition,
    score: MarketScore
  ): Promise<void> {
    try {
      // Insert into positions table
      await db.insert(positions)
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
          onChainPositionKey: position.positionPubkey?.toBase58() ?? null,
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
        });

      // Log to trade_log
      await db.insert(tradeLog)
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
        });

      // Update bot activity
      await db.update(bots)
        .set({
          lastError: null,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bots.botId, botId));

      // Persist virtual balance after deduction (simulation mode)
      this.persistVirtualBalance(botId);

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

  private async onPositionClosed(
    botId: string,
    userId: number,
    position: TrackedPosition,
    pnlLamports: BN
  ): Promise<void> {
    try {
      const isWin = pnlLamports.gtn(0);
      const pnlSol = pnlLamports.toNumber() / LAMPORTS_PER_SOL;

      // Wrap all DB mutations in a transaction for atomicity:
      // position update + bot stats + trade log must all succeed or all roll back.
      await db.transaction(async (tx) => {
        // Update position in DB
        await tx.update(positions)
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
            updatedAt: new Date(),
          })
          .where(eq(positions.positionId, position.id));

        // Update bot stats
        const [botRow] = await tx.select().from(bots).where(eq(bots.botId, botId));
        if (botRow) {
          await tx.update(bots)
            .set({
              totalTrades: botRow.totalTrades + 1,
              winningTrades: botRow.winningTrades + (isWin ? 1 : 0),
              totalPnlLamports:
                botRow.totalPnlLamports + pnlLamports.toNumber(),
              lastActivityAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(bots.botId, botId));
        }

        // Log to trade_log
        await tx.insert(tradeLog)
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
              pnlSol: pnlSol.toFixed(6),
              result: isWin ? "WIN" : "LOSS",
            }),
          });
      });

      // Emit event (outside transaction — UI notification is best-effort)
      eventBus.emitBotEvent("position:closed", botId, userId, {
        positionId: position.id,
        pool: position.poolName,
        exitPrice: position.exitPricePerToken,
        reason: position.exitReason,
        pnlSol,
        result: isWin ? "WIN" : "LOSS",
      });

      // Persist EmergencyStop state after trade result is recorded
      this.persistEmergencyStopState(botId);

      // Persist virtual balance after PnL credit (simulation mode)
      this.persistVirtualBalance(botId);
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

  // ── Fee Charged ──

  private async onFeeCharged(
    botId: string,
    userId: number,
    event: Extract<EngineEvent, { type: "fee:charged" }>
  ): Promise<void> {
    try {
      // Always write the ledger row, even on failure — operator visibility.
      await db.insert(feeLedger).values({
        botId,
        userId,
        positionId: event.positionId,
        mode: event.mode,
        strategyMode: event.strategyMode as "rule-based" | "aura-ai" | "both" | "llm",
        feeType: event.feeType,
        positionSizeLamports: event.positionSizeLamports,
        feeBps: event.feeBps,
        feeLamports: event.feeLamports,
        collectorWallet: event.collectorWallet,
        txSignature: event.txSignature,
      });

      // Only increment the cumulative counter for successful charges.
      if (event.success) {
        await db.update(bots)
          .set({
            totalFeesPaidLamports: sql`${bots.totalFeesPaidLamports} + ${event.feeLamports}`,
            updatedAt: new Date(),
          })
          .where(eq(bots.botId, botId));
      }

      eventBus.emitBotEvent("fee:charged", botId, userId, {
        positionId: event.positionId,
        feeBps: event.feeBps,
        feeLamports: event.feeLamports,
        feeSol: event.feeLamports / LAMPORTS_PER_SOL,
        success: event.success,
        txSignature: event.txSignature,
      });
    } catch (err) {
      log.error(
        {
          botId,
          err: err instanceof Error ? err.message : String(err),
          feeLamports: event.feeLamports,
        },
        "Failed to persist fee ledger row"
      );
    }
  }

  // ── Position Updated ──

  private async onPositionUpdated(
    botId: string,
    _userId: number,
    position: TrackedPosition
  ): Promise<void> {
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

      await db.update(positions)
        .set({
          currentPricePerToken: currentPrice,
          unrealizedPnlLamports,
          updatedAt: new Date(),
        })
        .where(eq(positions.positionId, position.id));
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

  private async onScanCompleted(
    botId: string,
    userId: number,
    eligible: number,
    entered: number,
    scanId: string,
    decisions: ScanDecision[]
  ): Promise<void> {
    // Always emit scan events so the app can update stats in real time
    eventBus.emitBotEvent("scan:completed", botId, userId, {
      eligible,
      entered,
    });

    // Update activity timestamp
    await db.update(bots)
      .set({
        lastError: null,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bots.botId, botId));

    // Persist per-pool decisions to bot_decisions table (cap at top 20 per scan)
    if (decisions.length > 0) {
      try {
        // Keep the most relevant: all entered + watched + top skipped by score
        const entered = decisions.filter((d) => d.decision === "entered");
        const watched = decisions.filter((d) => d.decision === "watched");
        const skipped = decisions
          .filter((d) => d.decision === "skipped" && d.ruleScore != null)
          .sort((a, b) => (b.ruleScore ?? 0) - (a.ruleScore ?? 0))
          .slice(0, 10);
        const toInsert = [...entered, ...watched, ...skipped].slice(0, 20);

        if (toInsert.length > 0) {
          await db.insert(botDecisions).values(
            toInsert.map((d) => ({
              botId,
              userId,
              scanId,
              poolAddress: d.poolAddress,
              poolName: d.poolName,
              decision: d.decision,
              reason: d.reason,
              ruleScore: d.ruleScore ?? null,
              mlProbability: d.mlProbability ?? null,
              scoreBreakdown: d.scoreBreakdown ?? null,
              features: d.features ?? null,
              positionId: d.positionId ?? null,
            }))
          );
        }

        // Prune old decisions — keep last 500 per bot
        const countResult = await db
          .select({ id: botDecisions.id })
          .from(botDecisions)
          .where(eq(botDecisions.botId, botId))
          .orderBy(botDecisions.id)
          .limit(1)
          .offset(500);

        if (countResult.length > 0) {
          await db
            .delete(botDecisions)
            .where(
              and(
                eq(botDecisions.botId, botId),
                lt(botDecisions.id, countResult[0].id)
              )
            );
        }
      } catch (err) {
        log.error(
          { botId, err: err instanceof Error ? err.message : String(err) },
          "Failed to persist scan decisions"
        );
      }
    }
  }

  // ── Engine Error ──

  private async onEngineError(
    botId: string,
    userId: number,
    error: string
  ): Promise<void> {
    log.error({ botId, error }, "Engine error");

    await db.update(bots)
      .set({
        lastError: error,
        updatedAt: new Date(),
      })
      .where(eq(bots.botId, botId));

    eventBus.emitBotEvent("engine:error", botId, userId, { error });

    // Auto-stop on insufficient balance when no active positions.
    // Without capital the engine would just retry every scan cycle forever.
    if (error.startsWith("insufficient_balance")) {
      const running = this.runningBots.get(botId);
      if (running) {
        const active = running.engine.getActivePositions();
        if (active.length === 0) {
          log.warn(
            { botId },
            "Auto-stopping bot: insufficient balance with no active positions"
          );
          try {
            await this.stopBot(botId);
          } catch (stopErr) {
            log.error({ botId, stopErr }, "Failed to auto-stop bot");
            return;
          }
          await db.update(bots)
            .set({
              status: "stopped",
              lastError: `Auto-stopped: ${error}`,
              updatedAt: new Date(),
            })
            .where(eq(bots.botId, botId));
          eventBus.emitBotEvent("engine:stopped", botId, userId, {
            reason: "insufficient_balance",
          });
        }
      }
    }
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
      mlThreshold: row.mlThreshold ?? undefined,
      minVolume24h: row.minVolume24h,
      minLiquidity: row.minLiquidity,
      maxLiquidity: row.maxLiquidity,

      // Token filtering
      solPairsOnly: true,
      requireSolQuote: row.mode !== "live", // sim math requires mint_y === WSOL
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
      // llmConfig is intentionally omitted here — the LlmTrader instance is
      // created separately in _startBot() with the decrypted key, and injected
      // directly into TradingEngine. BotConfig.llmConfig is reserved for
      // read-only metadata if needed in future.
    };
  }

  /**
   * Fetch a bot row from DB.
   */
  private async getBotRow(
    botId: string,
    userId: number
  ): Promise<BotRow | undefined> {
    const [row] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));
    return row;
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
