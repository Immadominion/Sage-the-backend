/**
 * LiveExecutor — Executes REAL transactions on Meteora DLMM.
 *
 * Ported from lp-bot/src/executors/live-v2.ts for ESM.
 *
 * Safety layers:
 *  1. WalletManager — Secure key handling
 *  2. EmergencyStop — Kill switch on loss limits  (injected by orchestrator)
 *  3. CircuitBreaker — Rate / exposure limits     (injected by orchestrator)
 *  4. TransactionSender — Retry with exponential backoff + priority fees
 *
 * Position lifecycle:
 *  open  → DLMM.initializePositionAndAddLiquidityByStrategy()
 *  update → DLMM.getPositionsByUserAndLbPair()  (price + fees refresh)
 *  close → DLMM.removeLiquidity({ shouldClaimAndClose: true })
 *          → Jupiter V6 swap leftover tokens → SOL
 *
 * ⚠️ CRITICAL: This handles REAL MONEY.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import BN from "bn.js";
import { v4 as uuidv4 } from "uuid";

import type {
  ITradingExecutor,
  TrackedPosition,
  StrategyParameters,
  OpenPositionResult,
  ClosePositionResult,
  BotConfig,
  MeteoraPairData,
} from "./types.js";
import { SOL_MINT } from "./types.js";
import { WalletManager } from "./wallet-manager.js";
import { TransactionSender } from "./transaction-sender.js";
import { MarketDataProvider } from "./market-data.js";
import { EmergencyStop } from "./emergency-stop.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "live-executor" });

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

export interface LiveExecutorConfig {
  priorityFeeMicroLamports: number;
  confirmationTimeoutMs: number;
  maxRetries: number;
  /** Jupiter slippage tolerance in basis points */
  jupiterSlippageBps: number;
  /** Minimum swap-out to bother swapping (in SOL) */
  jupiterDustThresholdSOL: number;
}

const DEFAULT_LIVE_CONFIG: LiveExecutorConfig = {
  priorityFeeMicroLamports: 10_000,
  confirmationTimeoutMs: 60_000,
  maxRetries: 3,
  jupiterSlippageBps: 300, // 3%
  jupiterDustThresholdSOL: 0.001,
};

// ═══════════════════════════════════════════════════════════════
// LiveExecutor
// ═══════════════════════════════════════════════════════════════

export class LiveExecutor implements ITradingExecutor {
  private connection: Connection;
  private walletManager: WalletManager;
  private txSender: TransactionSender;
  private marketData: MarketDataProvider;
  private config: BotConfig;
  private liveConfig: LiveExecutorConfig;

  // External safety systems (injected by orchestrator)
  private emergencyStop: EmergencyStop;
  private circuitBreaker: CircuitBreaker;

  private positions: Map<string, TrackedPosition> = new Map();

  constructor(
    connection: Connection,
    walletManager: WalletManager,
    marketData: MarketDataProvider,
    config: BotConfig,
    emergencyStop: EmergencyStop,
    circuitBreaker: CircuitBreaker,
    liveConfig?: Partial<LiveExecutorConfig>
  ) {
    this.connection = connection;
    this.walletManager = walletManager;
    this.marketData = marketData;
    this.config = config;
    this.emergencyStop = emergencyStop;
    this.circuitBreaker = circuitBreaker;
    this.liveConfig = { ...DEFAULT_LIVE_CONFIG, ...liveConfig };

    this.txSender = new TransactionSender(connection, {
      priorityFeeMicroLamports: this.liveConfig.priorityFeeMicroLamports,
      confirmationTimeoutMs: this.liveConfig.confirmationTimeoutMs,
      maxRetries: this.liveConfig.maxRetries,
    });

    log.warn(
      {
        wallet: walletManager.getPublicKey().toBase58().slice(0, 8) + "…",
      },
      "LIVE EXECUTOR INITIALIZED — REAL MONEY MODE"
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Open Position
  // ═══════════════════════════════════════════════════════════════

  async openPosition(
    poolAddress: string,
    strategy: StrategyParameters,
    amountX: BN,
    amountY: BN
  ): Promise<OpenPositionResult> {
    // ── Safety Check 1: Emergency Stop ──
    const eCheck = this.emergencyStop.canTrade();
    if (!eCheck.allowed) {
      log.warn({ reason: eCheck.reason }, "Emergency stop active");
      return { success: false, error: `Emergency stop: ${eCheck.reason}` };
    }

    // ── Safety Check 2: Circuit Breaker ──
    const totalAmount = amountX.add(amountY);
    const cbCheck = this.circuitBreaker.canOpenPosition(
      poolAddress,
      totalAmount
    );
    if (!cbCheck.allowed) {
      log.warn({ reason: cbCheck.reason }, "Circuit breaker triggered");
      return { success: false, error: `Circuit breaker: ${cbCheck.reason}` };
    }

    // ── Safety Check 3: Wallet validation ──
    const walletCheck = await this.walletManager.validateForTrading(0);
    if (!walletCheck.valid) {
      log.warn({ reason: walletCheck.reason }, "Wallet validation failed");
      return { success: false, error: `Wallet: ${walletCheck.reason}` };
    }

    try {
      log.info(
        {
          pool: poolAddress.slice(0, 8) + "…",
          amountSOL: totalAmount.toNumber() / LAMPORTS_PER_SOL,
        },
        "Opening LIVE position…"
      );

      // Get pool data & DLMM instance (shared cache)
      const poolData = await this.marketData.getPoolData(poolAddress);
      if (!poolData) {
        return { success: false, error: "Pool not found" };
      }

      const entryFeatures = this.captureEntryFeatures(poolData);
      const dlmm = await this.marketData.getDLMM(poolAddress);
      const activeBin = await dlmm.getActiveBin();
      const wallet = this.walletManager.getKeypair();
      const positionKeypair = Keypair.generate();

      // ── Rent-aware position sizing ──
      const RENT_BUFFER = 25_000_000; // 0.025 SOL
      const currentBalance = await this.connection.getBalance(wallet.publicKey);
      const maxDeposit = Math.max(0, currentBalance - RENT_BUFFER);

      let adjX = amountX;
      let adjY = amountY;
      const requestedTotal = amountX.add(amountY).toNumber();

      if (requestedTotal > maxDeposit) {
        const ratio = maxDeposit / requestedTotal;
        adjX = new BN(Math.floor(amountX.toNumber() * ratio));
        adjY = new BN(Math.floor(amountY.toNumber() * ratio));
        log.info(
          {
            requested: (requestedTotal / LAMPORTS_PER_SOL).toFixed(4),
            adjusted: (maxDeposit / LAMPORTS_PER_SOL).toFixed(4),
          },
          "Adjusted position size for rent costs"
        );
      }

      const adjTotal = adjX.add(adjY).toNumber();
      const minLamports = (this.config.minPositionSOL ?? 0.05) * LAMPORTS_PER_SOL;
      if (adjTotal < minLamports) {
        return {
          success: false,
          error: `Insufficient balance after rent: ${(adjTotal / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        };
      }

      // ── Build & send create-position tx ──
      const createTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: wallet.publicKey,
        totalXAmount: adjX,
        totalYAmount: adjY,
        strategy: {
          maxBinId: strategy.maxBinId,
          minBinId: strategy.minBinId,
          strategyType: strategy.strategyType,
        },
      });

      const txWithFees = this.txSender.addPriorityFee(createTx);
      const result = await this.txSender.sendTransaction(txWithFees, [
        wallet,
        positionKeypair,
      ]);

      if (!result.success) {
        this.emergencyStop.recordTxFailure();
        return { success: false, error: result.error };
      }

      // ── Track entry tx cost ──
      let entryTxCost = 0;
      if (result.signature) {
        try {
          const txInfo = await this.connection.getTransaction(
            result.signature,
            { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
          );
          entryTxCost = txInfo?.meta?.fee ?? 0;
        } catch {
          entryTxCost = 5000 + this.liveConfig.priorityFeeMicroLamports;
        }
      }

      // Record in circuit breaker
      this.circuitBreaker.recordPositionOpened(poolAddress, adjX.add(adjY));

      // ── Create tracked position ──
      const positionId = uuidv4();
      const position: TrackedPosition = {
        id: positionId,
        mode: "LIVE",
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
        entryAmountX: adjX,
        entryAmountY: adjY,
        entryTxSignature: result.signature,
        entryTxCostLamports: entryTxCost,
        entryFeatures,
        strategy,
        feesEarnedX: new BN(0),
        feesEarnedY: new BN(0),
        profitTargetPercent: this.config.profitTargetPercent,
        stopLossPercent: this.config.stopLossPercent,
        maxHoldTimeMinutes: this.config.maxHoldTimeMinutes,
        trailingStopEnabled: this.config.trailingStopEnabled,
        trailingStopPercent: this.config.trailingStopPercent,
        highWaterMarkPercent: 0,
      };

      this.positions.set(positionId, position);

      log.info(
        {
          positionId,
          pool: poolData.name,
          txSignature: result.signature,
          txCost: entryTxCost,
        },
        "[LIVE] Position opened"
      );

      return {
        success: true,
        positionId,
        positionPubkey: positionKeypair.publicKey,
        txSignature: result.signature,
      };
    } catch (error) {
      log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          poolAddress,
        },
        "Failed to open LIVE position"
      );
      this.emergencyStop.recordTxFailure();
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Close Position
  // ═══════════════════════════════════════════════════════════════

  async closePosition(
    positionId: string,
    reason: string
  ): Promise<ClosePositionResult> {
    try {
      const position = this.positions.get(positionId);
      if (!position) {
        return { success: false, error: `Position ${positionId} not found` };
      }

      log.info({ positionId, reason }, "Closing LIVE position…");

      const dlmm = await this.marketData.getDLMM(position.poolAddress);
      const wallet = this.walletManager.getKeypair();

      // ── Find on-chain position ──
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(
        wallet.publicKey
      );

      const onChain = userPositions.find((p: any) =>
        p.publicKey.equals(position.positionPubkey)
      );

      if (!onChain) {
        log.warn({ positionId }, "Position not found on-chain — marking closed");
        position.status = "CLOSED";
        position.exitReason = "NOT_FOUND_ON_CHAIN";
        position.exitTimestamp = Date.now();
        this.positions.delete(positionId);
        return { success: true };
      }

      const binIds: number[] = onChain.positionData.positionBinData.map(
        (b: any) => b.binId
      );

      if (binIds.length === 0) {
        log.warn({ positionId }, "No liquidity in position");
        position.status = "CLOSED";
        position.exitReason = "NO_LIQUIDITY";
        position.exitTimestamp = Date.now();
        this.positions.delete(positionId);
        return { success: true };
      }

      // ── Capture real fees before removal ──
      const feesX: BN = onChain.positionData.feeX || new BN(0);
      const feesY: BN = onChain.positionData.feeY || new BN(0);
      const totalFeesX = position.feesEarnedX
        ? BN.max(feesX, position.feesEarnedX)
        : feesX;
      const totalFeesY = position.feesEarnedY
        ? BN.max(feesY, position.feesEarnedY)
        : feesY;

      log.info(
        { positionId, feesX: totalFeesX.toString(), feesY: totalFeesY.toString() },
        "Fees earned snapshot"
      );

      // ── Remove liquidity (may return Transaction[]) ──
      const removeTxs = await dlmm.removeLiquidity({
        position: onChain.publicKey,
        user: wallet.publicKey,
        fromBinId: binIds[0],
        toBinId: binIds[binIds.length - 1],
        bps: new BN(100 * 100), // 100%
        shouldClaimAndClose: true,
      });

      let lastSig = "";
      const txArray = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
      let totalExitTxCost = 0;

      for (const tx of txArray) {
        const txWithFees = this.txSender.addPriorityFee(tx);
        const result = await this.txSender.sendTransaction(txWithFees, [wallet]);

        if (!result.success) {
          this.emergencyStop.recordTxFailure();
          return { success: false, error: result.error };
        }

        lastSig = result.signature ?? "";

        // Track actual tx fee
        if (lastSig) {
          try {
            const txInfo = await this.connection.getTransaction(lastSig, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            totalExitTxCost += txInfo?.meta?.fee ?? 0;
          } catch {
            totalExitTxCost += 5000 + this.liveConfig.priorityFeeMicroLamports;
          }
        }
      }

      // ── Calculate real P&L ──
      const activeBin = await dlmm.getActiveBin();
      const exitPrice = parseFloat(activeBin.pricePerToken);
      const entryPrice = parseFloat(position.entryPricePerToken);
      const priceChange = (exitPrice - entryPrice) / entryPrice;
      const entryValue = position.entryAmountX.add(position.entryAmountY);
      const pricePnl = new BN(Math.floor(entryValue.toNumber() * priceChange));

      // Fees in SOL
      const feesYSOL = totalFeesY.toNumber() / LAMPORTS_PER_SOL;
      const feesXSOL =
        totalFeesX.toNumber() > 0
          ? (totalFeesX.toNumber() * exitPrice) / LAMPORTS_PER_SOL
          : 0;
      const totalFeesSOL = feesYSOL + feesXSOL;

      // Tx costs
      const totalTxCost =
        totalExitTxCost + (position.entryTxCostLamports ?? 0);
      const txCostSOL = totalTxCost / LAMPORTS_PER_SOL;

      // Net P&L = price change + fees - tx costs
      const pnlSOL = pricePnl.toNumber() / LAMPORTS_PER_SOL;
      const netPnlSOL = pnlSOL + totalFeesSOL - txCostSOL;

      // ── Record in safety systems ──
      this.circuitBreaker.recordPositionClosed(position.poolAddress, entryValue);
      this.emergencyStop.recordTradeResult(netPnlSOL);

      // ── Update position record ──
      position.status = "CLOSED";
      position.exitPricePerToken = activeBin.pricePerToken;
      position.exitTimestamp = Date.now();
      position.exitTxSignature = lastSig;
      position.exitReason = reason;
      position.realizedPnlLamports = pricePnl;
      position.feesEarnedX = totalFeesX;
      position.feesEarnedY = totalFeesY;
      position.exitTxCostLamports = totalExitTxCost;

      const holdMin = (Date.now() - position.entryTimestamp) / 60_000;
      const emoji = netPnlSOL >= 0 ? "+" : "";

      log.info(
        {
          positionId,
          pool: position.poolName,
          pricePnl: pnlSOL.toFixed(6),
          feesSOL: totalFeesSOL.toFixed(6),
          txCost: txCostSOL.toFixed(6),
          netPnlSOL: `${emoji}${netPnlSOL.toFixed(6)}`,
          holdMin: holdMin.toFixed(1),
          reason,
          txSig: lastSig,
        },
        `[LIVE] Position closed (net ${emoji}${netPnlSOL.toFixed(6)} SOL)`
      );

      // ── Auto-swap leftover tokens → SOL (non-fatal) ──
      const nonSolMint =
        position.tokenYMint === SOL_MINT
          ? position.tokenXMint
          : position.tokenYMint;

      if (nonSolMint && nonSolMint !== SOL_MINT) {
        const swapResult = await this.swapLeftoverTokensToSOL(
          nonSolMint,
          position.poolName
        );
        if (swapResult.success && (swapResult.solReceived ?? 0) > 0) {
          log.info(
            { solRecovered: swapResult.solReceived?.toFixed(6) },
            "Capital recovered from token swap"
          );
        }
      }

      return {
        success: true,
        txSignature: lastSig,
        realizedPnlLamports: pricePnl,
        feesClaimedX: totalFeesX,
        feesClaimedY: totalFeesY,
      };
    } catch (error) {
      log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          positionId,
        },
        "Failed to close LIVE position"
      );
      this.emergencyStop.recordTxFailure();
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Update position data (from chain)
  // ═══════════════════════════════════════════════════════════════

  async updatePositionData(
    positionId: string
  ): Promise<TrackedPosition | null> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== "ACTIVE") return null;

    try {
      const dlmm = await this.marketData.getDLMM(position.poolAddress);
      const wallet = this.walletManager.getKeypair();

      const { userPositions, activeBin } =
        await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

      const onChain = userPositions.find((p: any) =>
        p.publicKey.equals(position.positionPubkey)
      );

      if (onChain) {
        position.currentPositionData = onChain.positionData;
        position.currentPricePerToken = activeBin.pricePerToken;
        position.feesEarnedX = onChain.positionData.feeX;
        position.feesEarnedY = onChain.positionData.feeY;

        // Update high water mark for trailing stop
        const currentPrice = parseFloat(activeBin.pricePerToken);
        const entryPrice = parseFloat(position.entryPricePerToken);
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

        if (pnlPercent > (position.highWaterMarkPercent ?? 0)) {
          position.highWaterMarkPercent = pnlPercent;
        }
      }

      return position;
    } catch (error) {
      log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          positionId,
        },
        "Failed to update position data"
      );
      this.emergencyStop.recordApiError();
      return position;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Getters
  // ═══════════════════════════════════════════════════════════════

  getActivePositions(): TrackedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "ACTIVE"
    );
  }

  async getBalance(): Promise<BN> {
    const info = await this.walletManager.getWalletInfo();
    return new BN(info.balanceLamports);
  }

  getPerformanceSummary(): {
    currentBalanceSol: number;
    totalPnlSol: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPositions: number;
  } {
    const closed = Array.from(this.positions.values()).filter(
      (p) => p.status === "CLOSED"
    );

    let totalPnl = 0;
    let wins = 0;
    let losses = 0;

    for (const pos of closed) {
      const pnl = pos.realizedPnlLamports?.toNumber() ?? 0;
      totalPnl += pnl / LAMPORTS_PER_SOL;
      if (pnl >= 0) wins++;
      else losses++;
    }

    const total = wins + losses;

    return {
      currentBalanceSol: 0, // async — caller should use getBalance()
      totalPnlSol: totalPnl,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      totalPositions: closed.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Jupiter V6 Swap — leftover tokens → SOL
  // ═══════════════════════════════════════════════════════════════

  private async swapLeftoverTokensToSOL(
    tokenMint: string,
    poolName: string
  ): Promise<{
    success: boolean;
    amountSwapped?: number;
    solReceived?: number;
    error?: string;
  }> {
    const wallet = this.walletManager.getKeypair();

    try {
      if (tokenMint === SOL_MINT) {
        return { success: true, amountSwapped: 0 };
      }

      // Check token balance
      const mintPk = new PublicKey(tokenMint);
      const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey);

      let tokenBalance: bigint;
      try {
        const account = await getAccount(this.connection, ata);
        tokenBalance = account.amount;
      } catch (e) {
        if (e instanceof TokenAccountNotFoundError) {
          log.debug({ tokenMint }, "No token account — nothing to swap");
          return { success: true, amountSwapped: 0 };
        }
        throw e;
      }

      if (tokenBalance <= 0n) {
        return { success: true, amountSwapped: 0 };
      }

      log.info(
        { pool: poolName, tokenBalance: tokenBalance.toString() },
        "Swapping leftover tokens → SOL via Jupiter V6…"
      );

      // ── Step 1: Get quote ──
      const quoteUrl =
        `https://quote-api.jup.ag/v6/quote` +
        `?inputMint=${tokenMint}` +
        `&outputMint=${SOL_MINT}` +
        `&amount=${tokenBalance.toString()}` +
        `&slippageBps=${this.liveConfig.jupiterSlippageBps}`;

      const quoteRes = await fetch(quoteUrl);
      if (!quoteRes.ok) {
        const body = await quoteRes.text();
        log.warn({ status: quoteRes.status, body }, "Jupiter quote failed");
        return {
          success: false,
          error: `Jupiter quote failed: HTTP ${quoteRes.status}`,
        };
      }

      const quoteData = (await quoteRes.json()) as {
        outAmount?: string;
        priceImpactPct?: string;
        [k: string]: unknown;
      };

      if (!quoteData?.outAmount) {
        log.warn("Jupiter returned no valid quote");
        return { success: false, error: "No valid swap route found" };
      }

      const outSOL = parseInt(quoteData.outAmount) / LAMPORTS_PER_SOL;
      log.info(
        { outSOL: outSOL.toFixed(6), priceImpact: quoteData.priceImpactPct },
        "Jupiter quote received"
      );

      // Skip dust
      if (outSOL < this.liveConfig.jupiterDustThresholdSOL) {
        log.info({ outSOL }, "Swap output below dust threshold — skipping");
        return { success: true, amountSwapped: 0, solReceived: 0 };
      }

      // ── Step 2: Get swap transaction ──
      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: this.liveConfig.priorityFeeMicroLamports,
        }),
      });

      if (!swapRes.ok) {
        const body = await swapRes.text();
        log.warn({ status: swapRes.status, body }, "Jupiter swap tx request failed");
        return {
          success: false,
          error: `Jupiter swap failed: HTTP ${swapRes.status}`,
        };
      }

      const swapData = (await swapRes.json()) as {
        swapTransaction?: string;
        [k: string]: unknown;
      };

      if (!swapData.swapTransaction) {
        return { success: false, error: "Jupiter returned no swap transaction" };
      }

      // ── Step 3: Deserialize, sign, send ──
      const txBuf = Buffer.from(swapData.swapTransaction, "base64");
      const vtx = VersionedTransaction.deserialize(txBuf);
      vtx.sign([wallet]);

      const rawTx = vtx.serialize();
      const txSig = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      const confirmation = await this.connection.confirmTransaction(
        txSig,
        "confirmed"
      );

      if (confirmation.value.err) {
        log.warn(
          { txSig, err: confirmation.value.err },
          "Swap transaction failed on-chain"
        );
        return {
          success: false,
          error: `Swap tx failed: ${JSON.stringify(confirmation.value.err)}`,
        };
      }

      log.info(
        { pool: poolName, solReceived: outSOL.toFixed(6), txSig },
        "Leftover tokens swapped → SOL"
      );

      return {
        success: true,
        amountSwapped: Number(tokenBalance),
        solReceived: outSOL,
      };
    } catch (error) {
      // Swap failure is non-fatal
      log.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          pool: poolName,
        },
        "Failed to swap leftover tokens (non-fatal)"
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // V3 Feature Capture (ML retraining)
  // ═══════════════════════════════════════════════════════════════

  private captureEntryFeatures(
    pool: MeteoraPairData
  ): TrackedPosition["entryFeatures"] {
    try {
      const v30m = pool.volume?.min_30 ?? 0;
      const v1h = pool.volume?.hour_1 ?? 0;
      const v2h = pool.volume?.hour_2 ?? 0;
      const v4h = pool.volume?.hour_4 ?? 0;
      const v24h = pool.trade_volume_24h ?? pool.volume?.hour_24 ?? 0;

      const f30m = pool.fees?.min_30 ?? 0;
      const f1h = pool.fees?.hour_1 ?? 0;
      const f24h = pool.fees_24h ?? pool.fees?.hour_24 ?? 0;

      const liq = parseFloat(pool.liquidity) || 0;
      const apr = pool.apr ?? 0;

      return {
        volume_30m: v30m,
        volume_1h: v1h,
        volume_2h: v2h,
        volume_4h: v4h,
        volume_24h: v24h,
        fees_30m: f30m,
        fees_1h: f1h,
        fees_24h: f24h,
        fee_efficiency_1h: v1h > 0 ? f1h / v1h : 0,
        liquidity: liq,
        apr,
        volume_to_liquidity: liq > 0 ? v1h / liq : 0,
      };
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Failed to capture entry features"
      );
      return undefined;
    }
  }
}

export default LiveExecutor;
