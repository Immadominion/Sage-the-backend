/**
 * CircuitBreaker — Rate limiting and exposure control.
 *
 * Ported and enhanced from lp-bot/src/safety/circuit-breaker.ts.
 * Prevents over-allocation, rate-limit violations, and runaway position opening.
 * Sits between the TradingEngine and the Executor as a gate.
 *
 * Unlike EmergencyStop (which is a HALT), CircuitBreaker is a THROTTLE —
 * it rejects individual operations without stopping the whole engine.
 */

import BN from "bn.js";
import { LAMPORTS_PER_SOL } from "./types.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "circuit-breaker" });

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

export interface CircuitBreakerConfig {
  /** Maximum total number of open positions across all pools (default: 5) */
  maxPositionCount: number;
  /** Maximum positions per individual pool (default: 1) */
  maxPositionsPerPool: number;
  /** Maximum SOL in a single position (default: 2) */
  maxSinglePositionSOL: number;
  /** Maximum total SOL exposure across all open positions (default: 10) */
  maxTotalExposureSOL: number;
  /** Maximum transactions per minute (default: 10) */
  maxTxPerMinute: number;
  /** Minimum time between any two trades in ms (default: 5000) */
  minTimeBetweenTradesMs: number;
  /** Maximum API calls per minute (default: 60) */
  maxApiCallsPerMinute: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxPositionCount: 5,
  maxPositionsPerPool: 1,
  maxSinglePositionSOL: 2,
  maxTotalExposureSOL: 10,
  maxTxPerMinute: 10,
  minTimeBetweenTradesMs: 5000,
  maxApiCallsPerMinute: 60,
};

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

interface CircuitBreakerState {
  totalPositionCount: number;
  positionsByPool: Map<string, number>;
  currentExposureLamports: BN;
  lastTradeTime: number;
  recentTxTimestamps: number[];
  recentApiTimestamps: number[];
}

// ═══════════════════════════════════════════════════════════════
// CircuitBreaker
// ═══════════════════════════════════════════════════════════════

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;
  private label: string;

  constructor(label: string, config?: Partial<CircuitBreakerConfig>) {
    this.label = label;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      totalPositionCount: 0,
      positionsByPool: new Map(),
      currentExposureLamports: new BN(0),
      lastTradeTime: 0,
      recentTxTimestamps: [],
      recentApiTimestamps: [],
    };

    log.info(
      {
        label,
        maxPositions: this.config.maxPositionCount,
        maxExposure: this.config.maxTotalExposureSOL,
        maxSinglePos: this.config.maxSinglePositionSOL,
      },
      "CircuitBreaker initialized"
    );
  }

  // ── Primary Gate ──

  /**
   * Check if a new position can be opened.
   * Called BEFORE every openPosition() attempt.
   */
  canOpenPosition(
    poolAddress: string,
    positionAmountLamports: BN
  ): { allowed: boolean; reason?: string } {
    this.pruneOldTimestamps();

    // 1. Total position count
    if (this.state.totalPositionCount >= this.config.maxPositionCount) {
      return {
        allowed: false,
        reason: `Max positions reached: ${this.state.totalPositionCount}/${this.config.maxPositionCount}`,
      };
    }

    // 2. Per-pool limit
    const poolPositions = this.state.positionsByPool.get(poolAddress) ?? 0;
    if (poolPositions >= this.config.maxPositionsPerPool) {
      return {
        allowed: false,
        reason: `Max positions for pool ${poolAddress.slice(0, 8)}: ${poolPositions}/${this.config.maxPositionsPerPool}`,
      };
    }

    // 3. Single position size
    const positionSOL = positionAmountLamports.toNumber() / LAMPORTS_PER_SOL;
    if (positionSOL > this.config.maxSinglePositionSOL) {
      return {
        allowed: false,
        reason: `Position size ${positionSOL.toFixed(2)} SOL exceeds max ${this.config.maxSinglePositionSOL} SOL`,
      };
    }

    // 4. Total exposure (including proposed position)
    const newExposure = this.state.currentExposureLamports.add(positionAmountLamports);
    const newExposureSOL = newExposure.toNumber() / LAMPORTS_PER_SOL;
    if (newExposureSOL > this.config.maxTotalExposureSOL) {
      return {
        allowed: false,
        reason: `Total exposure would be ${newExposureSOL.toFixed(2)} SOL (max: ${this.config.maxTotalExposureSOL} SOL)`,
      };
    }

    // 5. Transaction rate limit
    if (this.state.recentTxTimestamps.length >= this.config.maxTxPerMinute) {
      return {
        allowed: false,
        reason: `TX rate limit: ${this.state.recentTxTimestamps.length}/${this.config.maxTxPerMinute} per minute`,
      };
    }

    // 6. Trade cooldown
    const timeSinceLastTrade = Date.now() - this.state.lastTradeTime;
    if (timeSinceLastTrade < this.config.minTimeBetweenTradesMs) {
      const waitSec = ((this.config.minTimeBetweenTradesMs - timeSinceLastTrade) / 1000).toFixed(1);
      return {
        allowed: false,
        reason: `Trade cooldown: wait ${waitSec}s`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if an API call should be allowed (rate limiting).
   */
  canMakeApiCall(): boolean {
    this.pruneOldTimestamps();
    return this.state.recentApiTimestamps.length < this.config.maxApiCallsPerMinute;
  }

  // ── Recording Events ──

  /**
   * Record that a position was opened.
   */
  recordPositionOpened(poolAddress: string, amountLamports: BN): void {
    this.state.totalPositionCount++;
    const poolCount = this.state.positionsByPool.get(poolAddress) ?? 0;
    this.state.positionsByPool.set(poolAddress, poolCount + 1);
    this.state.currentExposureLamports = this.state.currentExposureLamports.add(amountLamports);
    this.state.lastTradeTime = Date.now();
    this.state.recentTxTimestamps.push(Date.now());

    log.debug(
      {
        label: this.label,
        pool: poolAddress.slice(0, 8),
        totalPositions: this.state.totalPositionCount,
        exposureSOL: (this.state.currentExposureLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
      },
      "Position opened recorded"
    );
  }

  /**
   * Record that a position was closed.
   */
  recordPositionClosed(poolAddress: string, amountLamports: BN): void {
    this.state.totalPositionCount = Math.max(0, this.state.totalPositionCount - 1);

    const poolCount = this.state.positionsByPool.get(poolAddress) ?? 0;
    if (poolCount <= 1) {
      this.state.positionsByPool.delete(poolAddress);
    } else {
      this.state.positionsByPool.set(poolAddress, poolCount - 1);
    }

    this.state.currentExposureLamports = this.state.currentExposureLamports.sub(amountLamports);
    // Guard against negative (can happen if amounts don't match exactly)
    if (this.state.currentExposureLamports.isNeg()) {
      this.state.currentExposureLamports = new BN(0);
    }

    this.state.lastTradeTime = Date.now();
    this.state.recentTxTimestamps.push(Date.now());

    log.debug(
      {
        label: this.label,
        pool: poolAddress.slice(0, 8),
        totalPositions: this.state.totalPositionCount,
        exposureSOL: (this.state.currentExposureLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
      },
      "Position closed recorded"
    );
  }

  /**
   * Record an API call (for rate limiting tracking).
   */
  recordApiCall(): void {
    this.state.recentApiTimestamps.push(Date.now());
  }

  // ── State Sync ──

  /**
   * Sync the circuit breaker state with actual position data.
   * Used on startup/recovery to reconcile in-memory state with reality.
   */
  syncWithPositions(
    positions: { poolAddress: string; entryAmountLamports: number }[]
  ): void {
    this.state.totalPositionCount = positions.length;
    this.state.positionsByPool.clear();
    this.state.currentExposureLamports = new BN(0);

    for (const pos of positions) {
      const count = this.state.positionsByPool.get(pos.poolAddress) ?? 0;
      this.state.positionsByPool.set(pos.poolAddress, count + 1);
      this.state.currentExposureLamports = this.state.currentExposureLamports.add(
        new BN(pos.entryAmountLamports)
      );
    }

    log.info(
      {
        label: this.label,
        positions: positions.length,
        pools: this.state.positionsByPool.size,
        exposureSOL: (this.state.currentExposureLamports.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
      },
      "Circuit breaker synced with positions"
    );
  }

  // ── Query ──

  getSummary(): {
    totalPositions: number;
    uniquePools: number;
    exposureSOL: number;
    txRateLastMinute: number;
    apiRateLastMinute: number;
    lastTradeSecondsAgo: number;
  } {
    this.pruneOldTimestamps();
    return {
      totalPositions: this.state.totalPositionCount,
      uniquePools: this.state.positionsByPool.size,
      exposureSOL: this.state.currentExposureLamports.toNumber() / LAMPORTS_PER_SOL,
      txRateLastMinute: this.state.recentTxTimestamps.length,
      apiRateLastMinute: this.state.recentApiTimestamps.length,
      lastTradeSecondsAgo: this.state.lastTradeTime > 0
        ? (Date.now() - this.state.lastTradeTime) / 1000
        : -1,
    };
  }

  // ── Private ──

  /**
   * Remove timestamps older than 1 minute from rolling windows.
   */
  private pruneOldTimestamps(): void {
    const oneMinuteAgo = Date.now() - 60 * 1000;
    this.state.recentTxTimestamps = this.state.recentTxTimestamps.filter(
      (t) => t > oneMinuteAgo
    );
    this.state.recentApiTimestamps = this.state.recentApiTimestamps.filter(
      (t) => t > oneMinuteAgo
    );
  }
}
