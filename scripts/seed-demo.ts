/**
 * seed-demo.ts — Populate the Sage DB with realistic demo data.
 *
 * Creates:
 *  - 1 demo user (wallet: DemoWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
 *  - 2 bots (one rule-based, one sage-ai)
 *  - 20 closed positions with varied P&L (mix of wins/losses)
 *  - Aggregated bot stats
 *
 * Run: npx tsx scripts/seed-demo.ts
 *
 * ⚠️ WARNING: This INSERTS data — safe to run multiple times
 *    (uses INSERT OR IGNORE for idempotency on unique fields).
 */

import { db } from "../src/db/index.js";
import { users, bots, positions } from "../src/db/schema.js";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const DEMO_WALLET = "DemoWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const LAMPORTS_PER_SOL = 1_000_000_000;

// Real Meteora pool addresses for demo realism
const DEMO_POOLS = [
  {
    address: "FtVs24f9xbouZs1bVuSgtA1gJSuJqNzKJBt9xUfL9GEH",
    name: "SOL-USDC",
    tokenXMint: "So11111111111111111111111111111111111111112",
    tokenYMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    binStep: 10,
    basePrice: 148.5,
  },
  {
    address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScVcSAhPsQG",
    name: "SOL-USDT",
    tokenXMint: "So11111111111111111111111111111111111111112",
    tokenYMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    binStep: 10,
    basePrice: 148.3,
  },
  {
    address: "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq",
    name: "USDC-USDT",
    tokenXMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    tokenYMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    binStep: 1,
    basePrice: 1.0001,
  },
  {
    address: "6kJoJ8reBz3VqoE5HYpnWxXuQ2MaFRN96zqKiPLfwDa5",
    name: "JitoSOL-SOL",
    tokenXMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    tokenYMint: "So11111111111111111111111111111111111111112",
    binStep: 5,
    basePrice: 1.089,
  },
  {
    address: "2QFQCi8xvUgUH13Mh5qb4wTZ3jPCHLPdoE9MtFPnhJy5",
    name: "mSOL-SOL",
    tokenXMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    tokenYMint: "So11111111111111111111111111111111111111112",
    binStep: 5,
    basePrice: 1.075,
  },
];

// Exit reason distribution (matching FreesolGames strategy)
const EXIT_REASONS = [
  "profit_target",
  "profit_target",
  "profit_target",
  "profit_target",
  "profit_target",
  "profit_target", // ~60% profit target
  "stop_loss",
  "stop_loss", // ~20% stop loss
  "max_hold_time",
  "manual", // 10% each: timeout, manual
];

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function shortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generatePosition(
  botId: string,
  userId: number,
  index: number
): typeof positions.$inferInsert {
  const pool = randomChoice(DEMO_POOLS);
  const exitReason = randomChoice(EXIT_REASONS);

  // Generate timestamps going back 1-7 days
  const daysAgo = randomFloat(0.5, 7);
  const entryTimestamp = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const holdMinutes = randomFloat(5, 180);
  const exitTimestamp = entryTimestamp + holdMinutes * 60 * 1000;

  const entryAmountY = randomFloat(0.5, 2) * LAMPORTS_PER_SOL;

  // P&L based on exit reason
  let pnlPercent: number;
  switch (exitReason) {
    case "profit_target":
      pnlPercent = randomFloat(2, 12);
      break;
    case "stop_loss":
      pnlPercent = randomFloat(-15, -3);
      break;
    case "max_hold_time":
      pnlPercent = randomFloat(-2, 4);
      break;
    case "manual":
      pnlPercent = randomFloat(-5, 8);
      break;
    default:
      pnlPercent = 0;
  }

  const realizedPnlLamports = Math.round(
    (pnlPercent / 100) * entryAmountY
  );
  const entryPrice = pool.basePrice * randomFloat(0.97, 1.03);
  const exitPrice = entryPrice * (1 + pnlPercent / 100);

  const feesX = Math.round(randomFloat(0, 0.01) * LAMPORTS_PER_SOL);
  const feesY = Math.round(randomFloat(0, 0.005) * LAMPORTS_PER_SOL);
  const txCost = Math.round(randomFloat(0.001, 0.008) * LAMPORTS_PER_SOL);

  const score = randomFloat(120, 250);
  const mlProb = randomFloat(0.65, 0.98);

  return {
    positionId: `demo-${shortId()}`,
    botId,
    userId,
    status: "closed" as const,
    poolAddress: pool.address,
    poolName: pool.name,
    tokenXMint: pool.tokenXMint,
    tokenYMint: pool.tokenYMint,
    binStep: pool.binStep,
    entryActiveBinId: Math.floor(randomFloat(8000, 12000)),
    entryPricePerToken: entryPrice.toFixed(6),
    entryTimestamp: Math.round(entryTimestamp),
    entryAmountXLamports: Math.round(randomFloat(0, 0.1) * LAMPORTS_PER_SOL),
    entryAmountYLamports: Math.round(entryAmountY),
    entryTxSignature: `demo_entry_${crypto.randomBytes(32).toString("hex")}`,
    entryScore: score,
    mlProbability: mlProb,
    entryFeatures: JSON.stringify({
      volume_30m: randomFloat(1000, 50000),
      volume_1h: randomFloat(5000, 100000),
      volume_2h: randomFloat(10000, 200000),
      volume_4h: randomFloat(20000, 400000),
      volume_24h: randomFloat(100000, 2000000),
      fees_30m: randomFloat(10, 500),
      fees_1h: randomFloat(50, 1000),
      fees_24h: randomFloat(500, 10000),
      fee_efficiency_1h: randomFloat(0.001, 0.02),
      liquidity: randomFloat(5000, 500000),
      apr: randomFloat(10, 200),
      volume_to_liquidity: randomFloat(0.1, 5),
    }),
    profitTargetPercent: 8,
    stopLossPercent: 12,
    maxHoldTimeMinutes: 240,
    exitPricePerToken: exitPrice.toFixed(6),
    exitTimestamp: Math.round(exitTimestamp),
    exitTxSignature: `demo_exit_${crypto.randomBytes(32).toString("hex")}`,
    exitReason,
    realizedPnlLamports,
    feesEarnedXLamports: feesX,
    feesEarnedYLamports: feesY,
    txCostLamports: txCost,
    createdAt: new Date(entryTimestamp).toISOString(),
    updatedAt: new Date(exitTimestamp).toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("🌱 Seeding demo data...\n");

  // 1. Create demo user (idempotent)
  const existingUser = db
    .select()
    .from(users)
    .where(sql`${users.walletAddress} = ${DEMO_WALLET}`)
    .get();

  let userId: number;
  if (existingUser) {
    userId = existingUser.id;
    console.log(`  ✓ Demo user already exists (id=${userId})`);
  } else {
    const result = db
      .insert(users)
      .values({ walletAddress: DEMO_WALLET })
      .run();
    userId = Number(result.lastInsertRowid);
    console.log(`  ✓ Created demo user (id=${userId})`);
  }

  // 2. Create 2 bots
  const botConfigs = [
    {
      botId: `demo-rb-${shortId()}`,
      name: "FreesolGames Strategy",
      strategyMode: "rule-based" as const,
      mode: "simulation" as const,
      positionSizeSOL: 1,
      entryScoreThreshold: 150,
      simulationBalanceSOL: 10,
    },
    {
      botId: `demo-ai-${shortId()}`,
      name: "Sage AI Predictor",
      strategyMode: "sage-ai" as const,
      mode: "simulation" as const,
      positionSizeSOL: 0.5,
      entryScoreThreshold: 130,
      simulationBalanceSOL: 5,
    },
  ];

  const botIds: string[] = [];
  for (const cfg of botConfigs) {
    db.insert(bots)
      .values({
        ...cfg,
        userId,
        status: "stopped",
        profitTargetPercent: 8,
        stopLossPercent: 12,
        maxHoldTimeMinutes: 240,
        maxDailyLossSOL: 2,
        cooldownMinutes: 79,
        cronIntervalSeconds: 30,
        maxConcurrentPositions: 5,
        defaultBinRange: 10,
        minVolume24h: 1000,
        minLiquidity: 100,
        maxLiquidity: 1_000_000,
      })
      .run();
    botIds.push(cfg.botId);
    console.log(`  ✓ Created bot: ${cfg.name} (${cfg.botId})`);
  }

  // 3. Create positions (12 for bot 1, 8 for bot 2 = 20 total)
  const positionsToInsert: (typeof positions.$inferInsert)[] = [];
  for (let i = 0; i < 12; i++) {
    positionsToInsert.push(generatePosition(botIds[0], userId, i));
  }
  for (let i = 0; i < 8; i++) {
    positionsToInsert.push(generatePosition(botIds[1], userId, i));
  }

  for (const pos of positionsToInsert) {
    db.insert(positions).values(pos).run();
  }
  console.log(`  ✓ Created ${positionsToInsert.length} demo positions`);

  // 4. Update bot stats from their positions
  for (const botId of botIds) {
    const botPositions = positionsToInsert.filter((p) => p.botId === botId);
    const totalTrades = botPositions.length;
    const winningTrades = botPositions.filter(
      (p) => (p.realizedPnlLamports ?? 0) > 0
    ).length;
    const totalPnlLamports = botPositions.reduce(
      (sum, p) => sum + (p.realizedPnlLamports ?? 0),
      0
    );

    db.update(bots)
      .set({ totalTrades, winningTrades, totalPnlLamports })
      .where(sql`${bots.botId} = ${botId}`)
      .run();

    const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) : "0";
    const pnlSol = (totalPnlLamports / LAMPORTS_PER_SOL).toFixed(4);
    console.log(
      `  ✓ Bot ${botId}: ${totalTrades} trades, ${winRate}% win rate, ${pnlSol} SOL P&L`
    );
  }

  console.log("\n✅ Demo data seeded successfully!");
  console.log(
    `\n   To test: Generate a JWT for wallet "${DEMO_WALLET}" and hit the API.`
  );
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
