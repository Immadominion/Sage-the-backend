/**
 * Engine Types — Adapted from lp-bot/src/types/index.ts
 *
 * These are the core types used by the TradingEngine, executors,
 * and market data providers.  Kept in sync with lp-bot but decoupled
 * so aura-backend can evolve independently.
 */

import { PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";

// ═══════════════════════════════════════════════════════════════
// Execution Mode
// ═══════════════════════════════════════════════════════════════

export type ExecutionMode = "SIMULATION" | "LIVE";

// ═══════════════════════════════════════════════════════════════
// Meteora API Types
// ═══════════════════════════════════════════════════════════════

export interface MeteoraPairData {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  reserve_x: string;
  reserve_y: string;
  reserve_x_amount: number;
  reserve_y_amount: number;
  bin_step: number;
  base_fee_percentage: string;
  max_fee_percentage: string;
  protocol_fee_percentage: string;
  liquidity: string;
  reward_mint_x: string;
  reward_mint_y: string;
  fees_24h: number;
  today_fees: number;
  trade_volume_24h: number;
  cumulative_trade_volume: string;
  cumulative_fee_volume: string;
  current_price: number;
  apr: number;
  apy: number;
  farm_apr: number;
  farm_apy: number;
  hide: boolean;
  is_blacklisted: boolean;
  fees: {
    min_30: number;
    hour_1: number;
    hour_2: number;
    hour_4: number;
    hour_12: number;
    hour_24: number;
  };
  volume: {
    min_30: number;
    hour_1: number;
    hour_2: number;
    hour_4: number;
    hour_12: number;
    hour_24: number;
  };
  is_verified: boolean;
}

// ═══════════════════════════════════════════════════════════════
// DLMM Types
// ═══════════════════════════════════════════════════════════════

export enum StrategyType {
  Spot = 0,
  Curve = 1,
  BidAsk = 2,
}

export interface StrategyParameters {
  maxBinId: number;
  minBinId: number;
  strategyType: StrategyType;
  singleSidedX?: boolean;
}

export interface BinLiquidity {
  binId: number;
  xAmount: BN;
  yAmount: BN;
  supply: BN;
  version: number;
  price: string;
  pricePerToken: string;
}

export interface PositionBinData {
  binId: number;
  price: string;
  pricePerToken: string;
  binXAmount: string;
  binYAmount: string;
  binLiquidity: string;
  positionLiquidity: string;
  positionXAmount: string;
  positionYAmount: string;
}

export interface PositionData {
  totalXAmount: string;
  totalYAmount: string;
  positionBinData: PositionBinData[];
  lastUpdatedAt: BN;
  upperBinId: number;
  lowerBinId: number;
  feeX: BN;
  feeY: BN;
  rewardOne: BN;
  rewardTwo: BN;
}

// ═══════════════════════════════════════════════════════════════
// Position Tracking
// ═══════════════════════════════════════════════════════════════

export type PositionStatus =
  | "PENDING"
  | "ACTIVE"
  | "CLOSING"
  | "CLOSED"
  | "ERROR";

export interface TrackedPosition {
  id: string;
  mode: ExecutionMode;
  status: PositionStatus;

  // Pool info
  poolAddress: string;
  poolName: string;
  tokenXMint: string;
  tokenYMint: string;
  binStep: number;

  // Position keypair (needed to sign create tx)
  positionKeypair: Keypair;
  positionPubkey: PublicKey;

  // Entry data
  entryActiveBinId: number;
  entryPricePerToken: string;
  entryTimestamp: number;
  entryAmountX: BN;
  entryAmountY: BN;
  entryTxSignature?: string;

  // ML/Scoring data
  entryScore?: number;
  mlProbability?: number;

  // V3 market features at entry time
  entryFeatures?: {
    volume_30m: number;
    volume_1h: number;
    volume_2h: number;
    volume_4h: number;
    volume_24h: number;
    fees_30m: number;
    fees_1h: number;
    fees_24h: number;
    fee_efficiency_1h: number;
    liquidity: number;
    apr: number;
    volume_to_liquidity: number;
  };

  // Transaction cost tracking
  entryTxCostLamports?: number;
  exitTxCostLamports?: number;

  // Strategy used
  strategy: StrategyParameters;

  // Current state
  currentPositionData?: PositionData;
  currentPricePerToken?: string;
  feesEarnedX?: BN;
  feesEarnedY?: BN;

  // Exit conditions
  profitTargetPercent: number;
  stopLossPercent: number;
  maxHoldTimeMinutes: number;

  // Advanced risk management
  trailingStopEnabled?: boolean;
  trailingStopPercent?: number;
  highWaterMarkPercent?: number;

  // ── Bin-level simulation data (Phase 1-4 of simulation roadmap) ──
  lowerBinId?: number;
  upperBinId?: number;
  simulatedBins?: SimulatedBinPosition[];
  isInRange?: boolean;
  /** Percentage of position value that is token Y (0..1) */
  compositionFactor?: number;
  /** Accumulated fee estimate from real volume data (lamports) */
  accumulatedFeeLamports?: number;
  /** Timestamp of last fee accrual update */
  lastFeeUpdateTimestamp?: number;

  // Exit data
  exitPricePerToken?: string;
  exitTimestamp?: number;
  exitTxSignature?: string;
  exitReason?: string;
  realizedPnlLamports?: BN;
}

// ═══════════════════════════════════════════════════════════════
// Simulation Bin-Level Types
// ═══════════════════════════════════════════════════════════════

/** Per-bin state for a simulated DLMM position. */
export interface SimulatedBinPosition {
  binId: number;
  /** Bin price in token Y per token X */
  price: number;
  /** Our token X amount in this bin (lamports) */
  xAmount: number;
  /** Our token Y amount in this bin (lamports) */
  yAmount: number;
  /** Our liquidity share in this bin */
  liquidity: number;
  /** Total liquidity in this bin from all LPs (estimated) */
  totalBinLiquidity: number;
}

/** Fee-related data we can extract from pool API + on-chain info. */
export interface PoolFeeInfo {
  /** Base fee rate as a decimal (e.g., 0.002 = 0.2%) */
  baseFeeRate: number;
  /** Current total fee rate including dynamic component */
  totalFeeRate: number;
  /** Protocol's share of fees (0..1) */
  protocolShare: number;
}

// ═══════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════

export interface MarketScore {
  poolAddress: string;
  poolName: string;
  timestamp: number;
  volumeScore: number;
  liquidityScore: number;
  feeScore: number;
  momentumScore: number;
  totalScore: number;
  meetsThreshold: boolean;
  recommendation: "ENTER" | "WAIT" | "SKIP";
}

// ═══════════════════════════════════════════════════════════════
// Bot Configuration
// ═══════════════════════════════════════════════════════════════

export type StrategyMode = "rule-based" | "aura-ai" | "both" | "llm";

export interface LlmConfig {
  /** Anthropic API key stored encrypted in DB — decrypted in-memory only */
  anthropicApiKey: string;
  /** Model ID. Defaults to claude-haiku-4-5-20251001 */
  model?: string;
  /** Hard daily USD spend cap. Undefined = unlimited */
  maxUsdPerDay?: number;
  /** Max pools to include in a single prompt. Defaults to 10 */
  maxPoolsPerCall?: number;
}

export interface BotConfig {
  mode: ExecutionMode;
  rpcEndpoint: string;
  walletPath?: string;

  // Strategy mode
  strategyMode: StrategyMode;

  // Entry criteria
  entryScoreThreshold: number;
  /** ML probability threshold override (0-1). Undefined = use model default (0.8845). */
  mlThreshold?: number;
  minVolume24h: number;
  minLiquidity: number;
  maxLiquidity: number;

  // Token filtering
  solPairsOnly: boolean;
  requireSolQuote?: boolean; // Pre-filter: only pools where mint_y === WSOL
  blacklist: string[];

  // Position sizing
  positionSizePercent?: number;
  positionSizeSOL?: number;
  minPositionSOL?: number;
  maxPositionSOL?: number;
  defaultBinRange: number;

  // Risk management
  profitTargetPercent: number;
  stopLossPercent: number;
  maxHoldTimeMinutes: number;
  maxConcurrentPositions: number;
  maxDailyLossSOL: number;
  cooldownMinutes: number;

  // Advanced risk management
  trailingStopEnabled?: boolean;
  trailingStopPercent?: number;

  // Scheduler
  cronIntervalSeconds: number;
  positionCheckIntervalSeconds: number;

  // LLM mode config (only present when strategyMode === "llm")
  llmConfig?: LlmConfig;

  // Simulation
  simulation?: {
    initialBalanceSOL: number;
  };
}

// ═══════════════════════════════════════════════════════════════
// Execution Results
// ═══════════════════════════════════════════════════════════════

export interface OpenPositionResult {
  success: boolean;
  positionId?: string;
  positionPubkey?: PublicKey;
  txSignature?: string;
  error?: string;
}

export interface ClosePositionResult {
  success: boolean;
  txSignature?: string;
  realizedPnlLamports?: BN;
  feesClaimedX?: BN;
  feesClaimedY?: BN;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Interfaces (Dependency Injection)
// ═══════════════════════════════════════════════════════════════

export interface ITradingExecutor {
  openPosition(
    poolAddress: string,
    strategy: StrategyParameters,
    amountX: BN,
    amountY: BN,
    options?: {
      maxHoldTimeMinutes?: number;
    }
  ): Promise<OpenPositionResult>;

  closePosition(
    positionId: string,
    reason: string
  ): Promise<ClosePositionResult>;

  updatePositionData(positionId: string): Promise<TrackedPosition | null>;
  getActivePositions(): TrackedPosition[];
  getBalance(): Promise<BN>;
  /**
   * Charge a platform fee from this bot's wallet.
   *
   * - Simulation: deducts from the virtual balance.
   * - Live: sends a SystemProgram.transfer to the collector wallet.
   *
   * Returns the resulting txSignature on live mode (null in sim).
   * Returns success=false if the bot doesn't have enough balance to cover
   * the fee — the caller should treat this as a soft failure (fee skipped,
   * not the position itself).
   */
  chargeFee(
    feeLamports: number,
    collectorWallet: string
  ): Promise<{ success: boolean; txSignature: string | null; error?: string }>;
  getPerformanceSummary(): {
    totalPositions: number;
    wins: number;
    losses: number;
    totalPnlSol: number;
    currentBalanceSol: number;
    winRate: number;
  };
}

export interface IMarketDataProvider {
  fetchAllPools(): Promise<MeteoraPairData[]>;
  getPoolData(poolAddress: string): Promise<MeteoraPairData | null>;
  getActiveBin(poolAddress: string): Promise<BinLiquidity>;
  calculateMarketScore(
    pool: MeteoraPairData
  ): MarketScore | Promise<MarketScore>;
  filterEligiblePools(config: BotConfig): Promise<MeteoraPairData[]>;
}

// ═══════════════════════════════════════════════════════════════
// Event Types (for EventBus)
// ═══════════════════════════════════════════════════════════════

export type BotEventType =
  | "position:opened"
  | "position:closed"
  | "position:updated"
  | "fee:charged"
  | "scan:completed"
  | "engine:started"
  | "engine:stopped"
  | "engine:error"
  | "engine:warning"
  | "stats:updated"
  // Wallet Intelligence (brain analysis) progress — streamed over the same SSE.
  | "brain:progress"
  | "brain:completed";

export interface BotEvent {
  type: BotEventType;
  botId: string;
  userId: number;
  timestamp: number;
  data: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const METEORA_API_URL = "https://dlmm.datapi.meteora.ag";
