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
import { bots, positions, tradeLog, users } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { eventBus } from "./event-bus.js";
import { TradingEngine, type EngineEvent, type EngineStats } from "./trading-engine.js";
import { SimulationExecutor } from "./simulation-executor.js";
import { SealExecutor } from "./seal-executor.js";
import { SealSession } from "./seal-session.js";
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
    const needsML = strategyMode === "sage-ai" || strategyMode === "both";
    const mlPredictor = needsML ? this.sharedMLPredictor : null;

    if (needsML) {
      const health = await this.sharedMLPredictor.checkHealth();
      if (!health) {
        throw new Error(
          `ML service is unavailable but strategyMode="${strategyMode}" requires it. ` +
          `Ensure the ML service is running at ${config.ML_SERVICE_URL ?? "http://127.0.0.1:8100"} ` +
          `or change strategyMode to "rule-based".`
        );
      }
      log.info(
        { botId, model: health.model, threshold: health.threshold },
        "ML service connected"
      );
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
    let walletManager: WalletManager | undefined;

    if (isLiveMode) {
      // LIVE MODE — Seal session-key execution
      // The bot's agent + session keypairs are generated at setup-live time
      // and stored (encrypted) in the DB. The session keypair signs all
      // executeViaSession TXs — no user private key on the server.

      // ── Verify Seal program exists on-chain ──
      const { SEAL_PROGRAM_ID } = await import("../services/solana.js");
      const programInfo = await this.connection.getAccountInfo(SEAL_PROGRAM_ID);
      if (!programInfo) {
        throw new Error(
          `Seal wallet program (${SEAL_PROGRAM_ID.toBase58()}) not found on ${config.SOLANA_NETWORK}. ` +
          `Deploy the Seal program to ${config.SOLANA_NETWORK} before starting live mode.`
        );
      }

      if (!botRow.sessionSecretKey || !botRow.agentSecretKey) {
        throw new Error(
          "Live mode requires Seal agent + session setup. " +
          "Complete the live setup flow in the app first."
        );
      }

      // Look up the user's main wallet address (to derive wallet PDA)
      const [user] = await db
        .select({
          walletAddress: users.walletAddress,
          sealWalletAddress: users.sealWalletAddress,
        })
        .from(users)
        .where(eq(users.id, userId));

      if (!user?.walletAddress) {
        throw new Error("User wallet address not found");
      }

      const canonicalWalletAddress = user.sealWalletAddress ?? user.walletAddress;

      const sealSession = SealSession.fromDb(
        canonicalWalletAddress,
        botRow.agentSecretKey,
        botRow.sessionSecretKey,
        this.connection
      );

      executor = new SealExecutor(
        this.connection,
        sealSession,
        marketData,
        botConfig,
        emergencyStop,
        circuitBreaker
      );

      log.warn(
        {
          botId,
          walletPda: sealSession.getWalletPda().toBase58().slice(0, 8) + "…",
          sessionPubkey: sealSession.sessionPubkey.toBase58().slice(0, 8) + "…",
        },
        "Sage live executor created — delegated wallet execution"
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
      // Update position in DB
      await db.update(positions)
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
      const isWin = pnlLamports.gtn(0);
      const [botRow] = await db.select().from(bots).where(eq(bots.botId, botId));
      if (botRow) {
        await db.update(bots)
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
      await db.insert(tradeLog)
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
        });

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
    entered: number
  ): Promise<void> {
    // Only emit events for scans that resulted in entries
    if (entered > 0) {
      eventBus.emitBotEvent("scan:completed", botId, userId, {
        eligible,
        entered,
      });
    }

    // Update activity timestamp
    await db.update(bots)
      .set({
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bots.botId, botId));
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
