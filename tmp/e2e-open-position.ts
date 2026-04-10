/**
 * e2e-open-position.ts
 * 
 * End-to-end test: Uses SegaBot's real credentials to open a position on the
 * highest-probability pool. This tests the ENTIRE pipeline:
 *   DB → SealSession → MarketData → ML scoring → SealExecutor.openPosition
 *
 * Run with:
 *   DATABASE_URL="..." npx tsx tmp/e2e-open-position.ts
 *
 * ⚠️ This uses REAL SOL on mainnet. The position size is 0.1 SOL.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { bots, users, tradeLog } from "../src/db/schema.js";
import { MarketDataProvider } from "../src/engine/market-data.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { MLPredictor } from "../src/engine/ml-predictor.js";
import { extractV3Features, featuresToArray } from "../src/engine/ml-features.js";
import { SealSession } from "../src/engine/seal-session.js";
import { SealExecutor } from "../src/engine/seal-executor.js";
import { EmergencyStop } from "../src/engine/emergency-stop.js";
import { CircuitBreaker } from "../src/engine/circuit-breaker.js";
import type { BotConfig, StrategyParameters } from "../src/engine/types.js";
import { StrategyType, LAMPORTS_PER_SOL, SOL_MINT } from "../src/engine/types.js";
import BN from "bn.js";

const BOT_ID = "0131429c"; // SegaBot
const DB_URL = process.env.DATABASE_URL!;
const RPC_URL = process.env.SOLANA_RPC_URL!;
const SEAL_PROGRAM = new PublicKey("EV3TKRVz7pTHpAqBTjP8jmwuvoRBRCpjmVSPHhcMnXqb");

function deriveWalletPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("wallet"), owner.toBytes()],
        SEAL_PROGRAM
    );
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    console.log("═══════════════════════════════════════════════════");
    console.log(`  END-TO-END POSITION OPEN TEST ${dryRun ? "(DRY RUN)" : "(LIVE)"}`);
    console.log("═══════════════════════════════════════════════════\n");

    if (!dryRun) {
        console.log("⚠️  This will use REAL SOL on mainnet (0.1 SOL position).");
        console.log("    Pass --dry-run to test everything except the actual TX.\n");
    }

    const db = drizzle(DB_URL);
    const connection = new Connection(RPC_URL, "confirmed");

    // ── 1. Load bot from DB ──
    console.log("1. Loading bot from DB...");
    const [botRow] = await db.select().from(bots).where(eq(bots.botId, BOT_ID));
    if (!botRow) { console.error("Bot not found"); process.exit(1); }

    if (!botRow.agentSecretKey || !botRow.sessionSecretKey) {
        console.error("Bot missing agent/session keys. Run setup-live first.");
        process.exit(1);
    }

    console.log(`   Bot: ${botRow.name} (${botRow.strategyMode}, mode=${botRow.mode})`);
    console.log(`   ML threshold: ${botRow.mlThreshold ?? "model-default"}`);

    // ── 2. Create SealSession ──
    console.log("\n2. Creating SealSession...");
    const [user] = await db.select().from(users).where(eq(users.id, botRow.userId));
    if (!user) { console.error("User not found"); process.exit(1); }

    const walletAddress = user.sealWalletAddress ??
        deriveWalletPda(new PublicKey(user.walletAddress))[0].toBase58();

    const sealSession = SealSession.fromDb(
        walletAddress,
        botRow.agentSecretKey,
        botRow.sessionSecretKey,
        connection
    );
    console.log(`   Wallet PDA: ${sealSession.getWalletPda().toBase58()}`);
    console.log(`   Session signer: ${sealSession.getSessionKeypair().publicKey.toBase58()}`);

    // ── 3. Check balance ──
    console.log("\n3. Checking balance...");
    const [walletBal, sessionBal] = await Promise.all([
        connection.getBalance(sealSession.getWalletPda()),
        connection.getBalance(sealSession.getSessionKeypair().publicKey),
    ]);
    const totalBal = walletBal + sessionBal;
    console.log(`   Wallet PDA: ${(walletBal / 1e9).toFixed(4)} SOL`);
    console.log(`   Session signer: ${(sessionBal / 1e9).toFixed(4)} SOL`);
    console.log(`   Total: ${(totalBal / 1e9).toFixed(4)} SOL`);

    const positionSizeSOL = botRow.positionSizeSOL ?? 0.1;
    const minRequired = positionSizeSOL + 0.07;
    if (totalBal / 1e9 < minRequired) {
        console.error(`\n❌ Insufficient balance. Need ${minRequired} SOL, have ${(totalBal / 1e9).toFixed(4)}`);
        process.exit(1);
    }
    console.log(`   ✅ Sufficient for ${positionSizeSOL} SOL position`);

    // ── 4. Find best pool using ML ──
    console.log("\n4. Scanning market for best ML-rated pool...");
    const botConfig: BotConfig = {
        mode: "LIVE" as any,
        rpcEndpoint: RPC_URL,
        positionSizeSOL,
        maxConcurrentPositions: botRow.maxConcurrentPositions ?? 1,
        entryScoreThreshold: botRow.entryScoreThreshold ?? 100,
        mlThreshold: botRow.mlThreshold ?? undefined,
        minVolume24h: botRow.minVolume24h ?? 1000,
        minLiquidity: botRow.minLiquidity ?? 100,
        maxLiquidity: botRow.maxLiquidity ?? 1000000,
        cooldownMinutes: botRow.cooldownMinutes ?? 79,
        cronIntervalSeconds: botRow.cronIntervalSeconds ?? 30,
        defaultBinRange: botRow.defaultBinRange ?? 10,
        profitTargetPercent: botRow.profitTargetPercent ?? 5,
        stopLossPercent: botRow.stopLossPercent ?? 4,
        maxDailyLossSOL: botRow.maxDailyLossSOL ?? 1.5,
        maxHoldTimeMinutes: botRow.maxHoldTimeMinutes ?? 120,
        strategyMode: botRow.strategyMode ?? "sage-ai",
        solPairsOnly: true,
        blacklist: [],
        positionCheckIntervalSeconds: 30,
    };

    const marketData = new MarketDataProvider(connection, botConfig);
    const eligible = await marketData.filterEligiblePools(botConfig);
    console.log(`   Eligible pools: ${eligible.length}`);

    // ML predictions
    const predictor = new MLPredictor();
    const byVolume = [...eligible]
        .sort((a, b) => (b.volume?.hour_1 ?? 0) - (a.volume?.hour_1 ?? 0))
        .slice(0, 30);

    const featureArrays = byVolume.map(p => featuresToArray(extractV3Features(p)));
    const addresses = byVolume.map(p => p.address);
    const predictions = await predictor.predictBatch(featureArrays, addresses);

    if (!predictions) {
        console.error("❌ ML prediction failed");
        process.exit(1);
    }

    const threshold = botRow.mlThreshold ?? 0.8845;
    const qualifying = predictions
        .map((pred, i) => ({ pred, pool: byVolume[i] }))
        .filter(({ pred }) => pred.probability >= threshold)
        .sort((a, b) => b.pred.probability - a.pred.probability);

    console.log(`   Pools above ML threshold (${threshold}): ${qualifying.length}`);

    if (qualifying.length === 0) {
        console.log("\n   Top 5 pools by probability:");
        for (const pred of predictions.sort((a, b) => b.probability - a.probability).slice(0, 5)) {
            const pool = byVolume.find(p => p.address === pred.poolAddress);
            console.log(`     ${pred.probability.toFixed(4)} | ${pool?.name}`);
        }
        console.error("\n❌ No pools qualify at current ML threshold.");
        process.exit(1);
    }

    const bestPick = qualifying[0];
    console.log(`\n   🎯 Best pool: ${bestPick.pool.name}`);
    console.log(`      Address: ${bestPick.pool.address}`);
    console.log(`      ML probability: ${bestPick.pred.probability.toFixed(4)} (threshold: ${threshold})`);
    console.log(`      Volume 1h: $${(bestPick.pool.volume?.hour_1 ?? 0).toFixed(0)}`);
    console.log(`      Liquidity: $${parseFloat(bestPick.pool.liquidity).toFixed(0)}`);
    console.log(`      APR: ${(bestPick.pool.apr ?? 0).toFixed(1)}%`);

    // ── 5. Get active bin ──
    console.log("\n5. Getting active bin for pool...");
    const activeBin = await marketData.getActiveBin(bestPick.pool.address);
    if (!activeBin) {
        console.error("❌ Could not get active bin");
        process.exit(1);
    }
    console.log(`   Active bin: ${activeBin.binId}, price: ${activeBin.price}`);

    const binRange = botConfig.defaultBinRange ?? 10;
    const strategy: StrategyParameters = {
        minBinId: activeBin.binId - binRange,
        maxBinId: activeBin.binId + binRange,
        strategyType: StrategyType.Spot,
    };
    console.log(`   Strategy: Spot, bins ${strategy.minBinId} to ${strategy.maxBinId}`);

    // ── 6. Calculate position size ──
    const positionLamports = Math.floor(positionSizeSOL * LAMPORTS_PER_SOL);
    const solIsX = bestPick.pool.mint_x === SOL_MINT;
    const solIsY = bestPick.pool.mint_y === SOL_MINT;
    const amountX = solIsX ? new BN(positionLamports) : new BN(0);
    const amountY = solIsY ? new BN(positionLamports) : new BN(0);
    console.log(`\n6. Position: ${positionSizeSOL} SOL (${positionLamports} lamports) on ${solIsX ? "X" : "Y"} side`);

    if (dryRun) {
        console.log("\n═══════════════════════════════════════════════════");
        console.log("  DRY RUN COMPLETE — All checks passed ✅");
        console.log("  Run without --dry-run to actually open the position.");
        console.log("═══════════════════════════════════════════════════\n");
        process.exit(0);
    }

    // ── 7. Create executor and open position ──
    console.log("\n7. Creating SealExecutor and opening position...");
    const emergencyStop = new EmergencyStop(BOT_ID, {
        maxDailyLossSOL: botConfig.maxDailyLossSOL ?? 2,
        maxTotalLossSOL: (botConfig.maxDailyLossSOL ?? 2) * 3,
        maxConsecutiveLosses: 5,
        maxTxFailuresPerHour: 10,
        maxApiErrorsPerHour: 50,
    });

    const circuitBreaker = new CircuitBreaker(BOT_ID, {
        maxPositionCount: botConfig.maxConcurrentPositions,
        maxPositionsPerPool: 1,
        maxSinglePositionSOL: (botConfig.maxPositionSOL ?? 2),
        maxTotalExposureSOL: (botConfig.maxPositionSOL ?? 2) * botConfig.maxConcurrentPositions,
    });

    const executor = new SealExecutor(
        connection,
        sealSession,
        marketData,
        botConfig,
        emergencyStop,
        circuitBreaker,
    );

    console.log(`   Opening position on ${bestPick.pool.name}...`);
    const result = await executor.openPosition(
        bestPick.pool.address,
        strategy,
        amountX,
        amountY,
    );

    if (result.success) {
        console.log("\n═══════════════════════════════════════════════════");
        console.log("  ✅ POSITION OPENED SUCCESSFULLY");
        console.log(`  Position ID: ${result.positionId}`);
        console.log(`  TX Signature: ${result.signature}`);
        console.log(`  Pool: ${bestPick.pool.name} (${bestPick.pool.address})`);
        console.log(`  Amount: ${positionSizeSOL} SOL`);
        console.log("═══════════════════════════════════════════════════\n");

        // Log to DB
        await db.insert(tradeLog).values({
            botId: BOT_ID,
            userId: botRow.userId,
            positionId: result.positionId ?? null,
            event: "position_opened",
            details: JSON.stringify({
                source: "e2e-test",
                pool: bestPick.pool.name,
                poolAddress: bestPick.pool.address,
                mlProbability: bestPick.pred.probability,
                positionSizeSOL,
                signature: result.signature,
            }),
        });
        console.log("Trade logged to DB.");
    } else {
        console.error("\n═══════════════════════════════════════════════════");
        console.error(`  ❌ POSITION OPEN FAILED: ${result.error}`);
        console.error("═══════════════════════════════════════════════════\n");
    }

    process.exit(result.success ? 0 : 1);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
