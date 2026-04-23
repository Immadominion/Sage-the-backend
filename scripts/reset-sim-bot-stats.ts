/**
 * reset-sim-bot-stats.ts
 *
 * One-time cleanup script: resets simulation-bot stats rows that contain
 * clearly inflated P&L figures from pre-fix trades on non-SOL-quoted pools.
 *
 * Background:
 *   Before the `mint_y !== SOL_MINT` guard was added to SimulationExecutor,
 *   the engine could open positions on pools where token Y was not SOL (e.g.,
 *   USDC, BONK, etc.). The P&L math treated non-SOL amounts as if they were
 *   SOL lamports, producing values like +9915 SOL from tiny price moves.
 *   Those values were written to `bots.total_pnl_lamports` and
 *   `bots.current_virtual_balance_lamports`.
 *
 * What this script does:
 *   - Finds all simulation bots whose total_pnl_lamports exceeds a sane
 *     maximum (default: 100 SOL = 100e9 lamports). Any sim bot that shows
 *     > 100 SOL lifetime profit without being in live mode is almost
 *     certainly a victim of the bug.
 *   - Resets total_pnl_lamports, total_trades, winning_trades,
 *     current_virtual_balance_lamports, and emergency_stop_state.
 *
 * Usage:
 *   npx tsx scripts/reset-sim-bot-stats.ts
 *   # or with a custom threshold (lamports):
 *   MAX_PNL_LAMPORTS=50000000000 npx tsx scripts/reset-sim-bot-stats.ts
 *
 * This is safe to re-run. It only resets rows where
 * total_pnl_lamports > MAX_PNL_LAMPORTS AND mode = 'simulation'.
 */

import db from "../src/db/index.js";
import { bots } from "../src/db/schema.js";
import { and, eq, gt } from "drizzle-orm";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Max sane sim P&L: 100 SOL. Anything beyond this from a sim is almost
// certainly inflated from the cross-quoted pool bug.
const MAX_PNL_LAMPORTS = BigInt(
    process.env.MAX_PNL_LAMPORTS ?? String(100n * LAMPORTS_PER_SOL)
);

async function main() {
    console.log(
        `\nScanning for simulation bots with total_pnl_lamports > ${MAX_PNL_LAMPORTS} ` +
        `(${Number(MAX_PNL_LAMPORTS) / Number(LAMPORTS_PER_SOL)} SOL)...\n`
    );

    // Find affected bots
    const affected = await db
        .select({
            botId: bots.botId,
            name: bots.name,
            totalPnlLamports: bots.totalPnlLamports,
            totalTrades: bots.totalTrades,
            mode: bots.mode,
        })
        .from(bots)
        .where(
            and(
                eq(bots.mode, "simulation"),
                gt(bots.totalPnlLamports, Number(MAX_PNL_LAMPORTS))
            )
        );

    if (affected.length === 0) {
        console.log("✓ No bots with inflated P&L found. Nothing to reset.");
        return;
    }

    console.log(`Found ${affected.length} bot(s) with inflated P&L:\n`);
    for (const b of affected) {
        const pnlSol = b.totalPnlLamports / Number(LAMPORTS_PER_SOL);
        console.log(`  [${b.botId}] "${b.name}" — ${pnlSol.toFixed(2)} SOL / ${b.totalTrades} trades`);
    }

    console.log("\nResetting stats for affected bots...");

    for (const b of affected) {
        await db
            .update(bots)
            .set({
                totalTrades: 0,
                winningTrades: 0,
                totalPnlLamports: 0,
                currentVirtualBalanceLamports: null, // reset to simulationBalanceSOL next start
                emergencyStopState: null,
                updatedAt: new Date(),
            })
            .where(eq(bots.botId, b.botId));

        const pnlSol = b.totalPnlLamports / Number(LAMPORTS_PER_SOL);
        console.log(`  ✓ [${b.botId}] "${b.name}" — cleared ${pnlSol.toFixed(2)} SOL of inflated P&L`);
    }

    console.log(`\nDone. ${affected.length} bot(s) reset.\n`);
}

main().catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
});
