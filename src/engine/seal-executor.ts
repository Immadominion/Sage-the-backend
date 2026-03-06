/**
 * SealExecutor — Live trade execution through Seal smart wallets.
 *
 * Same lifecycle as LiveExecutor (open/close/update positions on DLMM)
 * but all instructions are wrapped in executeViaSession so the
 * Seal program validates spending limits and CPI-invokes with the
 * wallet PDA as signer.
 *
 * Key differences from LiveExecutor:
 *  - "user" = wallet PDA (not a direct keypair)
 *  - Every DLMM instruction → wrapInstruction() → executeViaSession
 *  - Session keypair signs the outer TX (no wallet private key needed)
 *  - Positions are owned by the wallet PDA (CPI invoke_signed)
 *
 * ⚠️ CRITICAL: This handles REAL MONEY through delegated authority.
 */

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
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
import { SealSession } from "./seal-session.js";
import { TransactionSender } from "./transaction-sender.js";
import { MarketDataProvider } from "./market-data.js";
import { EmergencyStop } from "./emergency-stop.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "seal-executor" });

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

export interface SealExecutorConfig {
    priorityFeeMicroLamports: number;
    confirmationTimeoutMs: number;
    maxRetries: number;
    jupiterSlippageBps: number;
    jupiterDustThresholdSOL: number;
}

const DEFAULT_CONFIG: SealExecutorConfig = {
    priorityFeeMicroLamports: 10_000,
    confirmationTimeoutMs: 60_000,
    maxRetries: 3,
    jupiterSlippageBps: 300,
    jupiterDustThresholdSOL: 0.001,
};

// ═══════════════════════════════════════════════════════════════
// SealExecutor
// ═══════════════════════════════════════════════════════════════

export class SealExecutor implements ITradingExecutor {
    private connection: Connection;
    private session: SealSession;
    private txSender: TransactionSender;
    private marketData: MarketDataProvider;
    private config: BotConfig;
    private execConfig: SealExecutorConfig;

    private emergencyStop: EmergencyStop;
    private circuitBreaker: CircuitBreaker;

    private positions: Map<string, TrackedPosition> = new Map();

    constructor(
        connection: Connection,
        session: SealSession,
        marketData: MarketDataProvider,
        config: BotConfig,
        emergencyStop: EmergencyStop,
        circuitBreaker: CircuitBreaker,
        execConfig?: Partial<SealExecutorConfig>
    ) {
        this.connection = connection;
        this.session = session;
        this.marketData = marketData;
        this.config = config;
        this.emergencyStop = emergencyStop;
        this.circuitBreaker = circuitBreaker;
        this.execConfig = { ...DEFAULT_CONFIG, ...execConfig };

        this.txSender = new TransactionSender(connection, {
            priorityFeeMicroLamports: this.execConfig.priorityFeeMicroLamports,
            confirmationTimeoutMs: this.execConfig.confirmationTimeoutMs,
            maxRetries: this.execConfig.maxRetries,
        });

        log.warn(
            {
                walletPda: session.getWalletPda().toBase58().slice(0, 8) + "…",
                sessionPubkey: session.sessionPubkey.toBase58().slice(0, 8) + "…",
            },
            "SAGE LIVE EXECUTOR INITIALIZED — Delegated wallet execution"
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // Open Position (via Seal session)
    // ═══════════════════════════════════════════════════════════════

    async openPosition(
        poolAddress: string,
        strategy: StrategyParameters,
        amountX: BN,
        amountY: BN
    ): Promise<OpenPositionResult> {
        // ── Safety checks ──
        const eCheck = this.emergencyStop.canTrade();
        if (!eCheck.allowed) {
            log.warn({ reason: eCheck.reason }, "Emergency stop active");
            return { success: false, error: `Emergency stop: ${eCheck.reason}` };
        }

        const totalAmount = amountX.add(amountY);
        const cbCheck = this.circuitBreaker.canOpenPosition(poolAddress, totalAmount);
        if (!cbCheck.allowed) {
            log.warn({ reason: cbCheck.reason }, "Circuit breaker triggered");
            return { success: false, error: `Circuit breaker: ${cbCheck.reason}` };
        }

        try {
            const walletPda = this.session.getWalletPda();
            log.info(
                {
                    pool: poolAddress.slice(0, 8) + "…",
                    amountSOL: totalAmount.toNumber() / LAMPORTS_PER_SOL,
                    via: "delegated-wallet",
                },
                "Opening live position…"
            );

            // Get pool data & DLMM instance
            const poolData = await this.marketData.getPoolData(poolAddress);
            if (!poolData) {
                return { success: false, error: "Pool not found" };
            }

            const entryFeatures = this.captureEntryFeatures(poolData);
            const dlmm = await this.marketData.getDLMM(poolAddress);
            const activeBin = await dlmm.getActiveBin();
            const positionKeypair = Keypair.generate();

            // ── Rent-aware position sizing ──
            const RENT_BUFFER = 25_000_000; // 0.025 SOL
            const currentBalance = await this.connection.getBalance(walletPda);
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
                    error: `Insufficient wallet balance: ${(adjTotal / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
                };
            }

            // ── Build DLMM instruction with walletPda as "user" ──
            const createTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
                positionPubKey: positionKeypair.publicKey,
                user: walletPda, // Seal wallet PDA is the "user"
                totalXAmount: adjX,
                totalYAmount: adjY,
                strategy: {
                    maxBinId: strategy.maxBinId,
                    minBinId: strategy.minBinId,
                    strategyType: strategy.strategyType,
                },
            });

            // ── Wrap in executeViaSession ──
            const amountLamports = BigInt(adjTotal);
            await this.session.assertFeePayerFunded();
            const wrappedTx = this.session.wrapTransaction(createTx, amountLamports);
            const txWithFees = this.txSender.addPriorityFee(wrappedTx);

            // Sign with session keypair + position keypair
            const result = await this.txSender.sendTransaction(txWithFees, [
                this.session.getSessionKeypair(),
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
                    entryTxCost = 5000 + this.execConfig.priorityFeeMicroLamports;
                }
            }

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
                "Position opened (live)"
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
                "Failed to open live position"
            );
            this.emergencyStop.recordTxFailure();
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Close Position (via Seal session)
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

            log.info({ positionId, reason }, "Closing live position…");

            const dlmm = await this.marketData.getDLMM(position.poolAddress);
            const walletPda = this.session.getWalletPda();

            // ── Find on-chain position (owned by wallet PDA) ──
            const { userPositions } = await dlmm.getPositionsByUserAndLbPair(
                walletPda
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

            // ── Remove liquidity (walletPda is the "user") ──
            const removeTxs = await dlmm.removeLiquidity({
                position: onChain.publicKey,
                user: walletPda,
                fromBinId: binIds[0],
                toBinId: binIds[binIds.length - 1],
                bps: new BN(100 * 100), // 100%
                shouldClaimAndClose: true,
            });

            let lastSig = "";
            const txArray = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
            let totalExitTxCost = 0;
            const sessionKeypair = this.session.getSessionKeypair();

            for (const tx of txArray) {
                // Wrap in executeViaSession (amount = 0 for withdrawals)
                await this.session.assertFeePayerFunded();
                const wrappedTx = this.session.wrapTransaction(tx, 0n);
                const txWithFees = this.txSender.addPriorityFee(wrappedTx);
                const result = await this.txSender.sendTransaction(txWithFees, [
                    sessionKeypair,
                ]);

                if (!result.success) {
                    this.emergencyStop.recordTxFailure();
                    return { success: false, error: result.error };
                }

                lastSig = result.signature ?? "";

                if (lastSig) {
                    try {
                        const txInfo = await this.connection.getTransaction(lastSig, {
                            commitment: "confirmed",
                            maxSupportedTransactionVersion: 0,
                        });
                        totalExitTxCost += txInfo?.meta?.fee ?? 0;
                    } catch {
                        totalExitTxCost += 5000 + this.execConfig.priorityFeeMicroLamports;
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

            const feesYSOL = totalFeesY.toNumber() / LAMPORTS_PER_SOL;
            const feesXSOL =
                totalFeesX.toNumber() > 0
                    ? (totalFeesX.toNumber() * exitPrice) / LAMPORTS_PER_SOL
                    : 0;
            const totalFeesSOL = feesYSOL + feesXSOL;

            const totalTxCost =
                totalExitTxCost + (position.entryTxCostLamports ?? 0);
            const txCostSOL = totalTxCost / LAMPORTS_PER_SOL;

            const pnlSOL = pricePnl.toNumber() / LAMPORTS_PER_SOL;
            const netPnlSOL = pnlSOL + totalFeesSOL - txCostSOL;

            // ── Safety records ──
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
                `Position closed (net ${emoji}${netPnlSOL.toFixed(6)} SOL)`
            );

            // Note: Jupiter swap for leftover tokens is NOT done via Seal
            // because Jupiter generates VersionedTransactions that cannot be
            // easily wrapped. The leftover tokens stay in the wallet PDA and
            // can be swapped later by the owner directly.

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
                "Failed to close live position"
            );
            this.emergencyStop.recordTxFailure();
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Update position data (read-only — no wrapping needed)
    // ═══════════════════════════════════════════════════════════════

    async updatePositionData(
        positionId: string
    ): Promise<TrackedPosition | null> {
        const position = this.positions.get(positionId);
        if (!position || position.status !== "ACTIVE") return null;

        try {
            const dlmm = await this.marketData.getDLMM(position.poolAddress);
            const walletPda = this.session.getWalletPda();

            const { userPositions, activeBin } =
                await dlmm.getPositionsByUserAndLbPair(walletPda);

            const onChain = userPositions.find((p: any) =>
                p.publicKey.equals(position.positionPubkey)
            );

            if (onChain) {
                position.currentPositionData = onChain.positionData;
                position.currentPricePerToken = activeBin.pricePerToken;
                position.feesEarnedX = onChain.positionData.feeX;
                position.feesEarnedY = onChain.positionData.feeY;

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
        const balance = await this.session.getWalletBalance();
        return new BN(balance);
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
            currentBalanceSol: 0,
            totalPnlSol: totalPnl,
            wins,
            losses,
            winRate: total > 0 ? wins / total : 0,
            totalPositions: closed.length,
        };
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

export default SealExecutor;
