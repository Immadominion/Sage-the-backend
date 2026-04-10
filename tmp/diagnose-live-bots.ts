/**
 * diagnose-live-bots.ts
 * 
 * Query the DB for all bots and their trade logs, then run a live scan
 * against the Meteora API to see exactly what the engine sees.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc } from "drizzle-orm";
import { bots, tradeLog } from "../src/db/schema.js";
import { MarketDataProvider } from "../src/engine/market-data.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { MLPredictor } from "../src/engine/ml-predictor.js";
import { extractV3Features, featuresToArray } from "../src/engine/ml-features.js";
import type { BotConfig } from "../src/engine/types.js";
import { SOL_MINT } from "../src/engine/types.js";

// Allow override: DATABASE_URL=... npx tsx tmp/diagnose-live-bots.ts
const DATABASE_URL = process.env.DATABASE_URL!;
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

async function main() {
    console.log("═══════════════════════════════════════════════");
    console.log("  SAGE BOT LIVE DIAGNOSIS");
    console.log("═══════════════════════════════════════════════\n");

    // ── 1. Query all bots ──
    const db = drizzle(DATABASE_URL);

    const allBots = await db.select().from(bots).where(eq(bots.userId, 4));
    console.log(`Found ${allBots.length} bots for user 4:\n`);

    for (const bot of allBots) {
        console.log(`  [${bot.botId}] "${bot.name}"`);
        console.log(`    mode: ${bot.mode}, status: ${bot.status}, strategy: ${bot.strategyMode}`);
        console.log(`    positionSize: ${bot.positionSizeSOL} SOL, maxConcurrent: ${bot.maxConcurrentPositions}`);
        console.log(`    entryThreshold: ${bot.entryScoreThreshold}, minVolume: ${bot.minVolume24h}`);
        console.log(`    minLiquidity: ${bot.minLiquidity}, maxLiquidity: ${bot.maxLiquidity}`);
        console.log(`    agentPubkey: ${bot.agentPubkey ?? 'NONE'}`);
        console.log(`    sessionAddress: ${bot.sessionAddress ?? 'NONE'}`);
        console.log(`    totalTrades: ${bot.totalTrades}, lastError: ${bot.lastError ?? 'none'}`);
        console.log();
    }

    // ── 2. Query recent trade logs ──
    const logs = await db
        .select()
        .from(tradeLog)
        .where(eq(tradeLog.userId, 4))
        .orderBy(desc(tradeLog.timestamp))
        .limit(20);

    console.log(`\nRecent trade logs (${logs.length}):\n`);
    for (const l of logs) {
        console.log(`  [${l.timestamp?.toISOString()}] ${l.event} — bot:${l.botId} — ${l.details?.substring(0, 120) ?? ''}`);
    }

    // ── 3. Run a live market scan ──
    console.log("\n═══════════════════════════════════════════════");
    console.log("  LIVE MARKET SCAN");
    console.log("═══════════════════════════════════════════════\n");

    const connection = new Connection(RPC_URL, "confirmed");

    // Use Sanctuary's config (rule-based, entry threshold 200)
    const sanctuaryBot = allBots.find(b => b.botId === "c9b6bcba");
    const segaBot = allBots.find(b => b.botId === "0131429c");

    // Test with BOTH configs
    for (const bot of [sanctuaryBot, segaBot].filter(Boolean)) {
        if (!bot) continue;

        console.log(`\n── Scanning as "${bot.name}" (${bot.strategyMode}, threshold=${bot.entryScoreThreshold}) ──\n`);

        const botConfig: BotConfig = {
            mode: "LIVE" as any,
            rpcEndpoint: RPC_URL,
            positionSizeSOL: bot.positionSizeSOL ?? 0.1,
            maxConcurrentPositions: bot.maxConcurrentPositions ?? 1,
            entryScoreThreshold: bot.entryScoreThreshold ?? 150,
            mlThreshold: bot.mlThreshold ?? undefined,
            minVolume24h: bot.minVolume24h ?? 1000,
            minLiquidity: bot.minLiquidity ?? 100,
            maxLiquidity: bot.maxLiquidity ?? 1000000,
            cooldownMinutes: bot.cooldownMinutes ?? 79,
            cronIntervalSeconds: bot.cronIntervalSeconds ?? 30,
            defaultBinRange: bot.defaultBinRange ?? 10,
            profitTargetPercent: bot.profitTargetPercent ?? 5,
            stopLossPercent: bot.stopLossPercent ?? 4,
            maxDailyLossSOL: bot.maxDailyLossSOL ?? 1.5,
            maxHoldTimeMinutes: bot.maxHoldTimeMinutes ?? 120,
            strategyMode: bot.strategyMode ?? "rule-based",
            solPairsOnly: true,
            blacklist: [],
            positionCheckIntervalSeconds: 30,
        };

        const marketData = new MarketDataProvider(connection, botConfig);

        // Filter eligible pools
        const eligible = await marketData.filterEligiblePools(botConfig);
        console.log(`  Eligible pools (after volume/liquidity filter): ${eligible.length}`);

        // Score ALL eligible pools
        const scored = eligible.map(pool => {
            const score = marketData.calculateMarketScore(pool);
            return { pool, score };
        });

        // Sort by total score
        scored.sort((a, b) => b.score.totalScore - a.score.totalScore);

        // Show top 10
        console.log(`\n  Top 10 pools by score (threshold = ${botConfig.entryScoreThreshold}):\n`);
        const top10 = scored.slice(0, 10);
        for (const { pool, score } of top10) {
            const passes = score.totalScore >= botConfig.entryScoreThreshold ? "✅ ENTER" : "❌ SKIP";
            const isSOL = pool.mint_x === SOL_MINT || pool.mint_y === SOL_MINT;
            console.log(`    ${passes} | score=${score.totalScore.toFixed(0).padStart(4)} | ${pool.name.padEnd(25)} | vol1h=$${(pool.volume?.hour_1 ?? 0).toFixed(0).padStart(8)} | liq=$${parseFloat(pool.liquidity).toFixed(0).padStart(10)} | apr=${(pool.apr ?? 0).toFixed(0).padStart(5)}% | SOL=${isSOL ? 'Y' : 'N'}`);
        }

        const qualifying = scored.filter(s => s.score.totalScore >= botConfig.entryScoreThreshold);
        console.log(`\n  Qualifying pools (above threshold): ${qualifying.length}`);

        if (qualifying.length === 0) {
            console.log(`\n  ⚠️  NO POOLS QUALIFY! Best score=${scored[0]?.score.totalScore.toFixed(1)}, threshold=${botConfig.entryScoreThreshold}`);
            console.log(`  The entry threshold of ${botConfig.entryScoreThreshold} is TOO HIGH for current market conditions.`);

            // Show what threshold WOULD let pools in
            if (scored.length > 0) {
                const bestScore = scored[0].score.totalScore;
                console.log(`\n  If threshold were ${Math.floor(bestScore)}, the top pool "${scored[0].pool.name}" would qualify.`);

                // How many would qualify at 80% of best
                const threshold80 = bestScore * 0.8;
                const wouldQualify = scored.filter(s => s.score.totalScore >= threshold80);
                console.log(`  At threshold ${Math.floor(threshold80)}, ${wouldQualify.length} pools would qualify.`);
            }
        }

        // If sage-ai mode, also check ML predictions
        if (bot.strategyMode === "sage-ai") {
            const customThreshold = bot.mlThreshold;
            console.log(`\n  ── ML Predictor Check (bot mlThreshold: ${customThreshold ?? 'model-default (0.8845)'}) ──`);
            try {
                const predictor = new MLPredictor();
                if (predictor.isEnabled) {
                    console.log("  ML model loaded ✅");

                    // Get top 30 by volume
                    const byVolume = [...eligible]
                        .sort((a, b) => (b.volume?.hour_1 ?? 0) - (a.volume?.hour_1 ?? 0))
                        .slice(0, 30);

                    const featureArrays = byVolume.map(p => featuresToArray(extractV3Features(p)));
                    const addresses = byVolume.map(p => p.address);

                    const predictions = await predictor.predictBatch(featureArrays, addresses);
                    if (predictions) {
                        // Apply per-bot threshold if set
                        const effectiveThreshold = customThreshold ?? 0.8845;
                        const enters = predictions.filter(p => p.probability >= effectiveThreshold);
                        console.log(`  ML predictions: ${predictions.length} pools evaluated, ${enters.length} would enter (threshold=${effectiveThreshold})`);

                        for (const pred of predictions.sort((a, b) => b.probability - a.probability).slice(0, 10)) {
                            const pool = byVolume.find(p => p.address === pred.poolAddress);
                            const wouldEnter = pred.probability >= effectiveThreshold;
                            console.log(`    ${wouldEnter ? "✅" : "❌"} prob=${pred.probability.toFixed(4)} | ${pool?.name ?? pred.poolAddress}`);
                        }

                        if (enters.length === 0) {
                            console.log(`\n  ⚠️  ML model says SKIP for ALL pools at threshold ${effectiveThreshold}.`);
                        } else {
                            console.log(`\n  🎯 ${enters.length} pools would be entered! Top: ${enters[0].poolAddress} (prob=${enters[0].probability.toFixed(4)})`);
                        }
                    } else {
                        console.log("  ❌ ML prediction returned null — model may be corrupted");
                    }
                } else {
                    console.log("  ❌ ML model NOT loaded — sage-ai mode cannot operate");
                }
            } catch (e) {
                console.log(`  ❌ ML predictor error: ${e}`);
            }
        }
    }

    // ── 4. Check if live bots can actually execute ──
    console.log("\n═══════════════════════════════════════════════");
    console.log("  EXECUTION CAPABILITY CHECK");
    console.log("═══════════════════════════════════════════════\n");

    for (const bot of allBots) {
        if (bot.mode !== "live") continue;

        const hasKeys = bot.agentPubkey && bot.sessionAddress && bot.agentSecretKey && bot.sessionSecretKey;
        console.log(`  [${bot.botId}] "${bot.name}" — keys: ${hasKeys ? '✅' : '❌ MISSING'}`);

        if (hasKeys) {
            // Check session signer balance
            try {
                const sessionPubkey = new PublicKey(bot.sessionPubkey!);
                const balance = await connection.getBalance(sessionPubkey);
                console.log(`    Session signer balance: ${(balance / 1e9).toFixed(4)} SOL`);

                if (balance < 100_000_000) {
                    console.log(`    ⚠️  Balance too low to open positions (need ~0.17 SOL minimum)`);
                }
            } catch (e) {
                console.log(`    ❌ Could not check balance: ${e}`);
            }
        }
    }

    console.log("\n═══════════════════════════════════════════════");
    console.log("  DONE");
    console.log("═══════════════════════════════════════════════\n");

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
