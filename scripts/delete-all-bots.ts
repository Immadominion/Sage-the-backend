/**
 * delete-all-bots.ts — one-time cleanup, wipes all bots from the DB.
 * Run: npx tsx scripts/delete-all-bots.ts
 */

import db from "../src/db/index.js";
import { bots, positions, tradeLog, botDecisions } from "../src/db/schema.js";

async function main() {
    // Delete child rows first to satisfy FK constraints
    const dl = await db.delete(botDecisions);
    const tl = await db.delete(tradeLog);
    const pl = await db.delete(positions);
    const deleted = await db.delete(bots).returning({ botId: bots.botId, name: bots.name });

    if (deleted.length === 0) {
        console.log("No bots found.");
    } else {
        console.log(`Deleted ${deleted.length} bot(s):`);
        deleted.forEach(b => console.log(` - [${b.botId}] ${b.name}`));
    }
}

main().catch(err => { console.error(err); process.exit(1); });
