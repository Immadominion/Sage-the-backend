/**
 * Seed script — populates strategy_presets with system defaults.
 *
 * Run: npm run db:seed
 */

import { runMigrations } from "./index.js";
import db from "./index.js";
import { strategyPresets } from "./schema.js";
import { eq, and } from "drizzle-orm";

const SYSTEM_PRESETS = [
  {
    name: "FreesolGames",
    description:
      "Replicates FreesolGames' 77% win rate bot: 150% threshold, 79min cooldown, 1 SOL positions. Battle-tested strategy.",
    isSystem: true,
    entryScoreThreshold: 150,
    minVolume24h: 1000,
    minLiquidity: 100,
    maxLiquidity: 1_000_000,
    positionSizeSOL: 1,
    maxConcurrentPositions: 5,
    profitTargetPercent: 8,
    stopLossPercent: 12,
    maxHoldTimeMinutes: 240,
    cooldownMinutes: 79,
  },
  {
    name: "Conservative",
    description:
      "Lower risk, slower trades. Ideal for beginners or larger capital. Tighter stop-loss, shorter holding time.",
    isSystem: true,
    entryScoreThreshold: 200,
    minVolume24h: 5000,
    minLiquidity: 500,
    maxLiquidity: 500_000,
    positionSizeSOL: 0.5,
    maxConcurrentPositions: 3,
    profitTargetPercent: 5,
    stopLossPercent: 8,
    maxHoldTimeMinutes: 120,
    cooldownMinutes: 120,
  },
  {
    name: "Heart Attack",
    description:
      "High risk, high reward. Aggressive entries, wider stops, longer holds. Only for risk-tolerant traders.",
    isSystem: true,
    entryScoreThreshold: 100,
    minVolume24h: 500,
    minLiquidity: 50,
    maxLiquidity: 2_000_000,
    positionSizeSOL: 2,
    maxConcurrentPositions: 8,
    profitTargetPercent: 15,
    stopLossPercent: 20,
    maxHoldTimeMinutes: 480,
    cooldownMinutes: 30,
  },
  {
    name: "Slow & Steady",
    description:
      "Very conservative. Targets high-liquidity, stable pools only. Small position sizes for consistent small gains.",
    isSystem: true,
    entryScoreThreshold: 250,
    minVolume24h: 10000,
    minLiquidity: 1000,
    maxLiquidity: 5_000_000,
    positionSizeSOL: 0.25,
    maxConcurrentPositions: 2,
    profitTargetPercent: 3,
    stopLossPercent: 5,
    maxHoldTimeMinutes: 60,
    cooldownMinutes: 180,
  },
];

async function seed() {
  console.log("🌱 Running migrations...");
  await runMigrations();

  console.log("🌱 Seeding strategy presets...");

  for (const preset of SYSTEM_PRESETS) {
    // Upsert: insert or skip if exists
    const [existing] = await db.select()
      .from(strategyPresets)
      .where(
        and(
          eq(strategyPresets.name, preset.name),
          eq(strategyPresets.isSystem, true)
        )
      );

    if (!existing) {
      await db.insert(strategyPresets).values(preset);
      console.log(`  ✅ ${preset.name}`);
    } else {
      console.log(`  ⏭️  ${preset.name} (already exists)`);
    }
  }

  console.log("🌱 Seeding complete.");
  process.exit(0);
}

seed().catch(console.error);
