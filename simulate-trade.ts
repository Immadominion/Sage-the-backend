/**
 * simulate-trade.ts — Replicate the EXACT production flow from
 * bot-keypair-executor.ts → transaction-sender.ts
 * to find the real error when opening a trade.
 *
 * NOTE: This file references the legacy Seal wallet infrastructure
 * (SealSession, seal-executor, SEAL_PROGRAM_ID) which is no longer
 * the active architecture. Kept for historical debugging reference.
 *
 * Uses real bot from the database, real on-chain accounts.
 */
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, LAMPORTS_PER_SOL, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const DLMM: any = _require("@meteora-ag/dlmm").default ?? _require("@meteora-ag/dlmm");
const BN: any = _require("bn.js");
import { db } from "./src/db/index.js";
import { bots, users } from "./src/db/schema.js";
import { eq, and, isNotNull } from "drizzle-orm";
import config from "./src/config.js";
import { deriveWalletPda, deriveAgentPda, deriveSessionPda, SEAL_PROGRAM_ID } from "./src/services/solana.js";
import { SealSession } from "./src/engine/seal-session.js";

// ── Exactly replicate legacy seal-executor's rewriteDelegatedIx ──
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
// Use the EXACT same discriminators as the legacy seal-executor.ts
const DLMM_INITIALIZE_POSITION_DISC = Buffer.from([219, 192, 234, 71, 190, 191, 102, 80]);
const DLMM_INITIALIZE_BIN_ARRAY_DISC = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);

function matchesDisc(data: Buffer, disc: Buffer): boolean {
    return data.length >= disc.length && data.subarray(0, disc.length).equals(disc);
}

function rewriteDelegatedIx(ix: TransactionInstruction, walletPda: PublicKey, sessionSigner: PublicKey): TransactionInstruction {
    const keys = ix.keys.map(k => ({ ...k }));

    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && keys.length >= 1 && keys[0].pubkey.equals(walletPda)) {
        keys[0] = { ...keys[0], pubkey: sessionSigner, isSigner: true, isWritable: true };
    } else if (ix.programId.equals(SystemProgram.programId) && keys.length >= 1 && keys[0].pubkey.equals(walletPda)) {
        keys[0] = { ...keys[0], pubkey: sessionSigner, isSigner: true, isWritable: true };
    } else if (matchesDisc(Buffer.from(ix.data), DLMM_INITIALIZE_POSITION_DISC) && keys.length >= 4 && keys[0].pubkey.equals(walletPda)) {
        keys[0] = { ...keys[0], pubkey: sessionSigner, isSigner: true, isWritable: true };
    } else if (matchesDisc(Buffer.from(ix.data), DLMM_INITIALIZE_BIN_ARRAY_DISC) && keys.length >= 3 && keys[2].pubkey.equals(walletPda)) {
        keys[2] = { ...keys[2], pubkey: sessionSigner, isSigner: true, isWritable: true };
    } else if (
        ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data.length >= 1 && ix.data[0] === 9 &&
        keys.length >= 2 && keys[1].pubkey.equals(walletPda)
    ) {
        keys[1] = { ...keys[1], pubkey: sessionSigner, isSigner: false, isWritable: true };
    }

    return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}

async function simulate() {
    const connection = new Connection(config.HELIUS_RPC_URL || config.SOLANA_RPC_URL, "confirmed");
    console.log("Network:", config.SOLANA_NETWORK);
    console.log("RPC:", (config.HELIUS_RPC_URL || config.SOLANA_RPC_URL).slice(0, 50) + "...");

    // ── 1. Load bot from DB — pick the one with status=error (the failing SegaBot) ──
    let [botRow] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.mode, "live"), eq(bots.status, "error"), isNotNull(bots.sessionSecretKey)))
        .limit(1);
    if (!botRow) {
        [botRow] = await db
            .select()
            .from(bots)
            .where(and(eq(bots.mode, "live"), isNotNull(bots.sessionSecretKey)))
            .limit(1);
    }

    if (!botRow) { console.log("No live bot found"); process.exit(1); }
    console.log(`\nBot: ${botRow.name} (${botRow.botId.slice(0, 8)})`);

    const [user] = await db.select().from(users).where(eq(users.id, botRow.userId));
    if (!user?.walletAddress) { console.log("No user wallet"); process.exit(1); }

    // ── 2. Build legacy SealSession (exactly like orchestrator.ts) ──
    const ownerPubkey = new PublicKey(user.walletAddress);
    const [walletPda] = deriveWalletPda(ownerPubkey);
    const sealSession = SealSession.fromDb(
        walletPda.toBase58(),
        botRow.agentSecretKey!,
        botRow.sessionSecretKey!,
        connection
    );

    const sessionKeypair = sealSession.getSessionKeypair();
    const sessionSigner = sessionKeypair.publicKey;
    console.log("Wallet PDA:", walletPda.toBase58());
    console.log("Session signer:", sessionSigner.toBase58());
    console.log("Agent PDA:", sealSession.agentPda.toBase58());
    console.log("Session PDA:", sealSession.sessionPda.toBase58());

    // Check all key accounts exist on-chain
    const [walletInfo, agentInfo, sessionInfo, signerBal] = await Promise.all([
        connection.getAccountInfo(walletPda),
        connection.getAccountInfo(sealSession.agentPda),
        connection.getAccountInfo(sealSession.sessionPda),
        connection.getBalance(sessionSigner),
    ]);
    console.log(`\nAccount checks:`);
    console.log(`  Wallet PDA:   ${walletInfo ? "EXISTS (" + walletInfo.data.length + " bytes)" : "MISSING!"}`);
    console.log(`  Agent PDA:    ${agentInfo ? "EXISTS (" + agentInfo.data.length + " bytes)" : "MISSING!"}`);
    console.log(`  Session PDA:  ${sessionInfo ? "EXISTS (" + sessionInfo.data.length + " bytes)" : "MISSING!"}`);
    console.log(`  Signer SOL:   ${(signerBal / LAMPORTS_PER_SOL).toFixed(6)}`);

    if (!walletInfo || !agentInfo || !sessionInfo) {
        console.log("\n❌ CRITICAL: Some on-chain accounts don't exist!");
        if (!walletInfo) console.log("   Wallet PDA missing — setup-live never completed or wrong owner derivation");
        if (!agentInfo) console.log("   Agent PDA missing — RegisterAgent TX was never confirmed");
        if (!sessionInfo) console.log("   Session PDA missing — CreateSession TX was never confirmed");
    }

    // ── 3. Find a test pool ──
    console.log("\nFetching pools...");
    const resp = await fetch("https://dlmm-api.meteora.ag/pair/all");
    const pairs: any[] = await resp.json();
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const pool = pairs.find((p: any) =>
        (p.mint_x === SOL_MINT || p.mint_y === SOL_MINT) &&
        Number(p.liquidity) >= 500 &&
        Number(p.trade_volume_24h) >= 5000
    );
    if (!pool) { console.log("No eligible pool found"); process.exit(1); }
    console.log(`Pool: ${pool.name} (${pool.address})`);

    // ── 4. Build DLMM TX (exactly like legacy seal-executor.ts) ──
    console.log("\nBuilding DLMM TX...");
    const dlmm = await DLMM.create(connection, new PublicKey(pool.address));
    const activeBin = await dlmm.getActiveBin();
    const positionKeypair = Keypair.generate();
    const binRange = botRow.defaultBinRange ?? 10;

    const testAmountLamports = 10_000_000; // 0.01 SOL — small test

    // Detect which side is SOL (matching production trading-engine.ts fix)
    const solIsX = pool.mint_x === SOL_MINT;
    const solIsY = pool.mint_y === SOL_MINT;
    console.log(`Mint X: ${pool.mint_x} ${solIsX ? "(SOL)" : ""}`);
    console.log(`Mint Y: ${pool.mint_y} ${solIsY ? "(SOL)" : ""}`);
    if (!solIsX && !solIsY) { console.log("Neither token is SOL!"); process.exit(1); }

    const amountX = solIsX ? new BN(testAmountLamports) : new BN(0);
    const amountY = solIsY ? new BN(testAmountLamports) : new BN(0);
    console.log(`amountX: ${amountX.toString()}, amountY: ${amountY.toString()}`);

    const createTx: Transaction = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: walletPda,
        totalXAmount: amountX,
        totalYAmount: amountY,
        strategy: {
            maxBinId: activeBin.binId + binRange,
            minBinId: activeBin.binId - binRange,
            strategyType: 0,
        },
    });

    console.log(`DLMM TX: ${createTx.instructions.length} instructions`);
    createTx.instructions.forEach((ix, i) => {
        console.log(`  [${i}] ${ix.programId.toBase58().slice(0, 15)}... (${ix.keys.length} keys)`);
    });

    // ── 5. Analyze discriminators and rewrite delegated accounts ──
    console.log("\nAnalyzing instruction discriminators:");
    for (let i = 0; i < createTx.instructions.length; i++) {
        const ix = createTx.instructions[i];
        const disc = Buffer.from(ix.data.subarray(0, 8));
        const progName = ix.programId.equals(DLMM_PROGRAM_ID) ? "DLMM" :
            ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ? "ATA" :
                ix.programId.equals(SystemProgram.programId) ? "System" :
                    ix.programId.equals(TOKEN_PROGRAM_ID) ? "Token" :
                        ix.programId.equals(ComputeBudgetProgram.programId) ? "ComputeBudget" :
                            ix.programId.toBase58().slice(0, 12);

        const matchInitPos = matchesDisc(Buffer.from(ix.data), DLMM_INITIALIZE_POSITION_DISC);
        const matchInitArr = matchesDisc(Buffer.from(ix.data), DLMM_INITIALIZE_BIN_ARRAY_DISC);
        const matchInfo = matchInitPos ? " ← MATCHES initPosition disc" :
            matchInitArr ? " ← MATCHES initBinArray disc" : "";

        console.log(`  [${i}] ${progName} disc=[${Array.from(disc).map(b => '0x' + b.toString(16).padStart(2, '0')).join(',')}]${matchInfo}`);

        // Check if walletPda appears in any key
        ix.keys.forEach((k, ki) => {
            if (k.pubkey.equals(walletPda)) {
                console.log(`       key[${ki}] = WALLET_PDA (signer=${k.isSigner}, writable=${k.isWritable})`);
            }
        });
    }

    console.log("\nRewriting delegated accounts...");
    const rewrittenTx = new Transaction();
    rewrittenTx.feePayer = sessionSigner;
    rewrittenTx.recentBlockhash = createTx.recentBlockhash;
    for (const ix of createTx.instructions) {
        rewrittenTx.add(rewriteDelegatedIx(ix, walletPda, sessionSigner));
    }

    // Show what changed
    for (let i = 0; i < createTx.instructions.length; i++) {
        const orig = createTx.instructions[i];
        const rewr = rewrittenTx.instructions[i];
        for (let k = 0; k < orig.keys.length; k++) {
            if (!orig.keys[k].pubkey.equals(rewr.keys[k].pubkey)) {
                console.log(`  [${i}] key[${k}]: ${orig.keys[k].pubkey.toBase58().slice(0, 8)}... → ${rewr.keys[k].pubkey.toBase58().slice(0, 8)}...`);
            }
        }
        // Check if walletPda STILL appears as a from-style signer after rewrite
        rewr.keys.forEach((k, ki) => {
            if (k.pubkey.equals(walletPda) && k.isSigner && k.isWritable) {
                console.log(`  ⚠️  [${i}] key[${ki}] STILL walletPda as writable signer after rewrite!`);
            }
        });
    }

    // ── 6. Wrap in executeViaSession (legacy seal-session.ts wrapTransaction) ──
    console.log("\nWrapping in executeViaSession (legacy Seal flow)...");
    const amountLamportsBig = BigInt(testAmountLamports);
    let wrappedTx: Transaction;
    try {
        wrappedTx = sealSession.wrapTransaction(rewrittenTx, amountLamportsBig);
        console.log(`Wrapped TX: ${wrappedTx.instructions.length} instructions`);
    } catch (e: any) {
        console.log(`\n❌ wrapTransaction FAILED: ${e.message}`);
        console.log("This means an instruction uses a program NOT in the allowed list.");
        process.exit(1);
    }

    // ── 7. Add priority fees (exactly like transaction-sender.ts addPriorityFee) ──
    console.log("\nAdding priority fees...");
    const CB = "ComputeBudget111111111111111111111111111111";
    const hasLimit = wrappedTx.instructions.some(ix => ix.programId.toBase58() === CB && ix.data.length > 0 && ix.data[0] === 2);
    const hasPrice = wrappedTx.instructions.some(ix => ix.programId.toBase58() === CB && ix.data.length > 0 && ix.data[0] === 3);

    if (!hasLimit) wrappedTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    if (!hasPrice) wrappedTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));

    console.log(`Final TX: ${wrappedTx.instructions.length} instructions`);
    wrappedTx.instructions.forEach((ix, i) => {
        const prog = ix.programId.toBase58();
        const label = prog === CB ? "ComputeBudget" :
            prog === SEAL_PROGRAM_ID.toBase58() ? "Legacy Seal::executeViaSession" :
                prog.slice(0, 15) + "...";
        console.log(`  [${i}] ${label} (${ix.keys.length} keys, ${ix.data.length} bytes)`);
    });

    // ── 8. Set blockhash and SIMULATE ──
    console.log("\nChecking all TX accounts exist on-chain...");
    const allKeys = new Set<string>();
    wrappedTx.instructions.forEach(ix => {
        allKeys.add(ix.programId.toBase58());
        ix.keys.forEach(k => allKeys.add(k.pubkey.toBase58()));
    });
    const uniqueKeys = [...allKeys];
    const accountInfos = await connection.getMultipleAccountsInfo(
        uniqueKeys.map(k => new PublicKey(k))
    );
    const missing = uniqueKeys.filter((_, i) => !accountInfos[i]);
    if (missing.length > 0) {
        console.log(`⚠️  ${missing.length} accounts don't exist on-chain:`);
        missing.forEach(m => console.log(`   ${m}`));
        console.log("(Some may be expected — new position account, ATAs to be created)");
    } else {
        console.log(`All ${uniqueKeys.length} accounts exist on-chain.`);
    }

    console.log("\nSimulating...");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    wrappedTx.recentBlockhash = blockhash;
    wrappedTx.lastValidBlockHeight = lastValidBlockHeight;
    wrappedTx.feePayer = sessionSigner;

    try {
        const simResult = await connection.simulateTransaction(wrappedTx, [sessionKeypair, positionKeypair]);

        if (simResult.value.err) {
            console.log("\n❌ SIMULATION FAILED");
            console.log("Error:", JSON.stringify(simResult.value.err, null, 2));
            console.log("\nLogs:");
            (simResult.value.logs ?? []).forEach((l, i) => console.log(`  ${i}: ${l}`));
            console.log("\nUnits consumed:", simResult.value.unitsConsumed);
        } else {
            console.log("\n✅ SIMULATION SUCCESS!");
            console.log("Units consumed:", simResult.value.unitsConsumed);
            console.log("\nLogs (last 20):");
            const logs = simResult.value.logs ?? [];
            logs.slice(-20).forEach((l, i) => console.log(`  ${logs.length - 20 + i}: ${l}`));
        }
    } catch (e: any) {
        console.log("\n❌ Simulation threw exception:");
        console.log("Message:", e.message);

        // Try to extract logs from SendTransactionError
        if (e.logs) {
            console.log("\nLogs:");
            e.logs.forEach((l: string, i: number) => console.log(`  ${i}: ${l}`));
        }

        // Try getLogs if available
        if (typeof e.getLogs === "function") {
            try {
                const logs = await e.getLogs();
                console.log("\nDetailed logs:");
                logs.forEach((l: string, i: number) => console.log(`  ${i}: ${l}`));
            } catch { /* ignore */ }
        }
    }

    process.exit(0);
}

simulate().catch(e => { console.error("Fatal:", e); process.exit(1); });
