/**
 * EmergencyStop — Financial safety kill switch.
 *
 * Ported and enhanced from lp-bot/src/safety/emergency-stop.ts.
 * Multi-trigger automatic halt system that protects capital by
 * detecting cascading failures, consecutive losses, daily drawdowns,
 * and API/transaction failure spikes.
 *
 * Every bot instance gets its own EmergencyStop.
 * State is persisted so protection survives restarts.
 */

import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "emergency-stop" });

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

export interface EmergencyStopConfig {
  /** Maximum daily net loss in SOL before halt (default: 2) */
  maxDailyLossSOL: number;
  /** Maximum total net loss in SOL before permanent halt (default: 5) */
  maxTotalLossSOL: number;
  /** Number of consecutive losses that triggers halt (default: 5) */
  maxConsecutiveLosses: number;
  /** Maximum transaction failures per rolling hour (default: 10) */
  maxTxFailuresPerHour: number;
  /** Maximum API errors per rolling hour (default: 50) */
  maxApiErrorsPerHour: number;
  /** Whether the kill switch is manually activated */
  killSwitchActive: boolean;
}

const DEFAULT_CONFIG: EmergencyStopConfig = {
  maxDailyLossSOL: 2,
  maxTotalLossSOL: 5,
  maxConsecutiveLosses: 5,
  maxTxFailuresPerHour: 10,
  maxApiErrorsPerHour: 50,
  killSwitchActive: false,
};

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

export interface EmergencyStopState {
  isTriggered: boolean;
  triggerReason: string | null;
  triggerTimestamp: number | null;

  // P&L tracking
  dailyPnlSOL: number;
  totalPnlSOL: number;
  consecutiveLosses: number;
  dailyResetDate: string; // ISO date (YYYY-MM-DD) for midnight UTC reset

  // Rolling failure windows
  txFailures: number[];   // timestamps of recent tx failures
  apiErrors: number[];     // timestamps of recent api errors

  // Counters
  totalTriggers: number;
}

function createInitialState(): EmergencyStopState {
  return {
    isTriggered: false,
    triggerReason: null,
    triggerTimestamp: null,
    dailyPnlSOL: 0,
    totalPnlSOL: 0,
    consecutiveLosses: 0,
    dailyResetDate: new Date().toISOString().slice(0, 10),
    txFailures: [],
    apiErrors: [],
    totalTriggers: 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// EmergencyStop
// ═══════════════════════════════════════════════════════════════

export type EmergencyCallback = (reason: string) => void;

export class EmergencyStop {
  private config: EmergencyStopConfig;
  private state: EmergencyStopState;
  private callbacks: EmergencyCallback[] = [];
  private label: string;

  constructor(
    label: string,
    config?: Partial<EmergencyStopConfig>,
    savedState?: EmergencyStopState
  ) {
    this.label = label;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = savedState ?? createInitialState();

    log.info(
      {
        label,
        maxDailyLoss: this.config.maxDailyLossSOL,
        maxTotalLoss: this.config.maxTotalLossSOL,
        maxConsecLosses: this.config.maxConsecutiveLosses,
      },
      "EmergencyStop initialized"
    );
  }

  // ── Primary Gate ──

  /**
   * Check if trading is allowed. Called BEFORE every entry attempt.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  canTrade(): { allowed: boolean; reason?: string } {
    // Reset daily counters if new UTC day
    this.checkDailyReset();

    // Clean stale failure timestamps
    this.pruneOldFailures();

    // 1. Kill switch
    if (this.config.killSwitchActive) {
      return { allowed: false, reason: "Kill switch activated" };
    }

    // 2. Already triggered
    if (this.state.isTriggered) {
      return {
        allowed: false,
        reason: `Emergency stop active: ${this.state.triggerReason}`,
      };
    }

    // 3. Daily loss limit
    if (this.state.dailyPnlSOL <= -this.config.maxDailyLossSOL) {
      this.trigger(
        `Daily loss limit exceeded: ${this.state.dailyPnlSOL.toFixed(4)} SOL (limit: -${this.config.maxDailyLossSOL} SOL)`
      );
      return { allowed: false, reason: this.state.triggerReason! };
    }

    // 4. Total loss limit
    if (this.state.totalPnlSOL <= -this.config.maxTotalLossSOL) {
      this.trigger(
        `Total loss limit exceeded: ${this.state.totalPnlSOL.toFixed(4)} SOL (limit: -${this.config.maxTotalLossSOL} SOL)`
      );
      return { allowed: false, reason: this.state.triggerReason! };
    }

    // 5. Consecutive losses
    if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.trigger(
        `${this.state.consecutiveLosses} consecutive losses (limit: ${this.config.maxConsecutiveLosses})`
      );
      return { allowed: false, reason: this.state.triggerReason! };
    }

    // 6. Transaction failure rate
    if (this.state.txFailures.length >= this.config.maxTxFailuresPerHour) {
      this.trigger(
        `${this.state.txFailures.length} tx failures in last hour (limit: ${this.config.maxTxFailuresPerHour})`
      );
      return { allowed: false, reason: this.state.triggerReason! };
    }

    // 7. API error rate
    if (this.state.apiErrors.length >= this.config.maxApiErrorsPerHour) {
      this.trigger(
        `${this.state.apiErrors.length} API errors in last hour (limit: ${this.config.maxApiErrorsPerHour})`
      );
      return { allowed: false, reason: this.state.triggerReason! };
    }

    return { allowed: true };
  }

  // ── Recording Events ──

  /**
   * Record a trade result (called after every position close).
   */
  recordTradeResult(pnlSOL: number): void {
    this.state.dailyPnlSOL += pnlSOL;
    this.state.totalPnlSOL += pnlSOL;

    if (pnlSOL <= 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    log.debug(
      {
        label: this.label,
        pnlSOL: pnlSOL.toFixed(6),
        dailyPnl: this.state.dailyPnlSOL.toFixed(4),
        totalPnl: this.state.totalPnlSOL.toFixed(4),
        consecutiveLosses: this.state.consecutiveLosses,
      },
      "Trade result recorded"
    );
  }

  /**
   * Record a transaction failure (send/confirm failed).
   */
  recordTxFailure(): void {
    this.state.txFailures.push(Date.now());
    log.debug(
      {
        label: this.label,
        recentFailures: this.state.txFailures.length,
      },
      "TX failure recorded"
    );
  }

  /**
   * Record an API error (market data fetch, DLMM call, etc.).
   */
  recordApiError(): void {
    this.state.apiErrors.push(Date.now());
    log.debug(
      {
        label: this.label,
        recentErrors: this.state.apiErrors.length,
      },
      "API error recorded"
    );
  }

  // ── Manual Controls ──

  /**
   * Manually trigger the emergency stop.
   */
  manualTrigger(reason: string): void {
    this.trigger(`Manual: ${reason}`);
  }

  /**
   * Activate/deactivate the kill switch.
   */
  setKillSwitch(active: boolean): void {
    this.config.killSwitchActive = active;
    if (active) {
      log.warn({ label: this.label }, "Kill switch ACTIVATED");
    } else {
      log.info({ label: this.label }, "Kill switch deactivated");
    }
  }

  /**
   * Reset the emergency stop (clears trigger, NOT accumulated loss stats).
   * Use after investigating and resolving the issue.
   */
  reset(): void {
    this.state.isTriggered = false;
    this.state.triggerReason = null;
    this.state.triggerTimestamp = null;
    this.state.txFailures = [];
    this.state.apiErrors = [];
    // Note: does NOT reset dailyPnlSOL, totalPnlSOL, or consecutiveLosses
    // Those represent real financial state and should only clear on daily reset
    log.info({ label: this.label }, "Emergency stop reset (trigger cleared)");
  }

  /**
   * Full reset including all counters (use with caution — only for new trading session).
   */
  fullReset(): void {
    this.state = createInitialState();
    log.warn({ label: this.label }, "Emergency stop FULL RESET (all counters cleared)");
  }

  // ── Callbacks ──

  /**
   * Register a callback to fire when emergency stop triggers.
   * Used by orchestrator to auto-close positions and stop the engine.
   */
  onTrigger(callback: EmergencyCallback): void {
    this.callbacks.push(callback);
  }

  // ── State Access ──

  get isTriggered(): boolean {
    return this.state.isTriggered;
  }

  get triggerReason(): string | null {
    return this.state.triggerReason;
  }

  getState(): EmergencyStopState {
    return { ...this.state };
  }

  getConfig(): EmergencyStopConfig {
    return { ...this.config };
  }

  /**
   * Get a summary for API responses / monitoring.
   */
  getSummary(): {
    isTriggered: boolean;
    triggerReason: string | null;
    dailyPnlSOL: number;
    totalPnlSOL: number;
    consecutiveLosses: number;
    txFailuresLastHour: number;
    apiErrorsLastHour: number;
    totalTriggers: number;
  } {
    this.pruneOldFailures();
    return {
      isTriggered: this.state.isTriggered,
      triggerReason: this.state.triggerReason,
      dailyPnlSOL: this.state.dailyPnlSOL,
      totalPnlSOL: this.state.totalPnlSOL,
      consecutiveLosses: this.state.consecutiveLosses,
      txFailuresLastHour: this.state.txFailures.length,
      apiErrorsLastHour: this.state.apiErrors.length,
      totalTriggers: this.state.totalTriggers,
    };
  }

  /**
   * Serialize state to JSON string for DB persistence.
   * Called after every state-changing operation to ensure crash safety.
   */
  serializeState(): string {
    return JSON.stringify(this.state);
  }

  /**
   * Restore state from a previously serialized JSON string.
   * Used on bot recovery to maintain loss tracking across restarts.
   */
  static deserializeState(json: string): EmergencyStopState | null {
    try {
      const parsed = JSON.parse(json);
      // Validate essential fields exist
      if (typeof parsed.isTriggered !== "boolean" ||
          typeof parsed.dailyPnlSOL !== "number" ||
          typeof parsed.totalPnlSOL !== "number") {
        return null;
      }
      return parsed as EmergencyStopState;
    } catch {
      return null;
    }
  }

  // ── Private ──

  private trigger(reason: string): void {
    if (this.state.isTriggered) return; // Already triggered

    this.state.isTriggered = true;
    this.state.triggerReason = reason;
    this.state.triggerTimestamp = Date.now();
    this.state.totalTriggers++;

    log.error(
      {
        label: this.label,
        reason,
        dailyPnl: this.state.dailyPnlSOL.toFixed(4),
        totalPnl: this.state.totalPnlSOL.toFixed(4),
        consecutiveLosses: this.state.consecutiveLosses,
        txFailures: this.state.txFailures.length,
        apiErrors: this.state.apiErrors.length,
      },
      "🚨 EMERGENCY STOP TRIGGERED"
    );

    // Fire all registered callbacks
    for (const callback of this.callbacks) {
      try {
        callback(reason);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Error in emergency stop callback"
        );
      }
    }
  }

  /**
   * Remove failure timestamps older than 1 hour from rolling windows.
   */
  private pruneOldFailures(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.state.txFailures = this.state.txFailures.filter((t) => t > oneHourAgo);
    this.state.apiErrors = this.state.apiErrors.filter((t) => t > oneHourAgo);
  }

  /**
   * Reset daily counters at midnight UTC.
   */
  private checkDailyReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.dailyResetDate !== today) {
      log.info(
        {
          label: this.label,
          previousDate: this.state.dailyResetDate,
          previousDailyPnl: this.state.dailyPnlSOL.toFixed(4),
        },
        "Daily P&L reset (new UTC day)"
      );
      this.state.dailyPnlSOL = 0;
      this.state.consecutiveLosses = 0;
      this.state.dailyResetDate = today;
    }
  }
}
