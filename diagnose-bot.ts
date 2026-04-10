/**
 * diagnose-bot.ts — Live trade execution diagnostic script
 *
 * Simulates the EXACT openPosition flow step-by-step without sending
 * any real transactions. Prints the full CPI error logs so we know
 * precisely why trades are failing.
 *
 * Usage:
 *   cd sage-backend
 *   npx tsx diagnose-bot.ts [botId]     ← uses .env for DB + RPC
 *   BOT_ID=abc123 npx tsx diagnose-bot.ts
 *
 * If no botId given, uses the most recently created live bot.
 */

import "dotenv/config";
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
    ComputeBudgetProgram,
    TransactionInstruction,
} from "@solana/web3.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { createRequire } from "node:module";
import { eq, and, isNull, desc } from "drizzle-orm";

// DB + Schema
import { db } from "./src/db/index.js";
import { bots, users } from "./src/db/schema.js";

// Engine modules
import { SealSession } from "./src/engine/seal-session.js";
import { deriveWalletPda, deriveAgentPda, deriveSessionPda, SEAL_PROGRAM_ID } from "./src/services/solana.js";
import config from "./src/config.js";

// DLMM SDK (CJS interop)
const _require = createRequire(import.meta.url);
const DLMM: any = _require("@meteora-ag/dlmm").default ?? _require("@meteora-ag/dlmm");

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
const SOL = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const addr = (pk: PublicKey | string) => {
    const s = typeof pk === "string" ? pk : pk.toBase58();
    return `${s.slice(0, 8)}…${s.slice(-6)}`;
};

const DIVIDER = "─".repeat(60);
const HEADER = (t: string) => `\n${"═".repeat(60)}\n  ${t}\n${"═".repeat(60)}`;
const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";
const INFO = "   ";

function encodeU64(value: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
}

const EXECUTE_VIA_SESSION_DISC = 3;
const TRANSFER_LAMPORTS_DISC = 13;
const DLMM_INIT_POSITION_DISC = Buffer.from([219, 192, 234, 71, 190, 191, 102, 80]);
const DLMM_INIT_BIN_ARRAY_DISC = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);

function matchesDisc(data: Buffer, disc: Buffer): boolean {
    if (data.length < disc.length) return false;
    for (let i = 0; i < disc.length; i++) if (data[i] !== disc[i]) return false;
    return true;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────
async function diagnose() {
    const argBotId = process.argv[2] ?? process.env.BOT_ID;
    const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
    const network = config.SOLANA_NETWORK;

    console.log(HEADER("SAGE LIVE BOT — TRADE DIAGNOSTICS"));
    console.log(`${INFO}Network : ${network}`);
    console.log(`${INFO}RPC     : ${config.SOLANA_RPC_URL.slice(0, 50)}…`);
    console.log(`${INFO}Seal ID : ${SEAL_PROGRAM_ID.toBase58()}`);

    // ═══════════════════════════════════════════════════════
    // 1. LOAD BOT FROM DB
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("1. DATABASE STATE"));

    let botRow: typeof bots.$inferSelect & { walletAddress?: string; sealWalletAddress?: string | null };

    const query = db
        .select({
            ...bots,
            walletAddress: users.walletAddress,
            sealWalletAddress: users.sealWalletAddress,
        })
        .from(bots)
        .innerJoin(users, eq(bots.userId, users.id))
        .where(and(eq(bots.mode, "live"), isNull(bots.deletedAt)))
        .orderBy(desc(bots.createdAt));

    const rows = await (argBotId
        ? query.where(eq(bots.botId, argBotId))
        : query.limit(1));

    if (!rows.length) {
        console.error(`${FAIL} No live bot found${argBotId ? ` with id=${argBotId}` : ""}.`);
        process.exit(1);
    }
    botRow = rows[0] as any;

    console.log(`${PASS} Bot loaded`);
    console.log(`${INFO}Bot ID     : ${botRow.botId}`);
    console.log(`${INFO}Name       : ${botRow.name}`);
    console.log(`${INFO}Status     : ${botRow.status}`);
    console.log(`${INFO}Strategy   : ${botRow.strategyMode}`);
    console.log(`${INFO}Pos size   : ${botRow.positionSizeSOL} SOL`);
    console.log(`${INFO}Daily limit: ${botRow.maxDailyLossSOL} SOL`);

    // Check keys
    const hasAgentSecret = !!botRow.agentSecretKey;
    const hasSessionSecret = !!botRow.sessionSecretKey;
    const hasAgentPubkey = !!botRow.agentPubkey;
    const hasSessionPubkey = !!botRow.sessionPubkey;
    const hasSessionAddr = !!botRow.sessionAddress;

    console.log(`\n${hasAgentSecret ? PASS : FAIL} agentSecretKey  : ${hasAgentSecret ? "present" : "MISSING!"}`);
    console.log(`${hasSessionSecret ? PASS : FAIL} sessionSecretKey: ${hasSessionSecret ? "present" : "MISSING!"}`);
    console.log(`${hasAgentPubkey ? PASS : FAIL} agentPubkey     : ${hasAgentPubkey ? addr(botRow.agentPubkey!) : "MISSING!"}`);
    console.log(`${hasSessionPubkey ? PASS : FAIL} sessionPubkey   : ${hasSessionPubkey ? addr(botRow.sessionPubkey!) : "MISSING!"}`);
    console.log(`${hasSessionAddr ? PASS : FAIL} sessionAddress  : ${hasSessionAddr ? addr(botRow.sessionAddress!) : "MISSING!"}`);

    if (!hasAgentSecret || !hasSessionSecret) {
        console.error("\n❌ FATAL: Keys missing in DB — re-run setup-live flow in the app.");
        process.exit(1);
    }

    // ═══════════════════════════════════════════════════════
    // 2. RECONSTRUCT SEAL SESSION
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("2. SEAL SESSION"));

    const walletAddress = botRow.sealWalletAddress ??
        deriveWalletPda(new PublicKey(botRow.walletAddress!))[0].toBase58();

    const sealSession = SealSession.fromDb(
        walletAddress,
        botRow.agentSecretKey!,
        botRow.sessionSecretKey!,
        connection
    );

    const walletPda = sealSession.getWalletPda();
    const sessionKeypair = sealSession.getSessionKeypair();
    const agentPda = sealSession.agentPda;
    const sessionPda = sealSession.sessionPda;

    console.log(`${INFO}Wallet PDA   : ${walletPda.toBase58()}`);
    console.log(`${INFO}Agent PDA    : ${agentPda.toBase58()}`);
    console.log(`${INFO}Session PDA  : ${sessionPda.toBase58()}`);
    console.log(`${INFO}Session signer: ${sessionKeypair.publicKey.toBase58()}`);

    // ═══════════════════════════════════════════════════════
    // 3. ON-CHAIN ACCOUNTS
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("3. ON-CHAIN ACCOUNTS & BALANCES"));

    const [
        sealInfo,
        agentInfo,
        sessionInfo,
        walletPdaBalance,
        sessionSignerBalance,
        agentBalance,
    ] = await Promise.all([
        connection.getAccountInfo(SEAL_PROGRAM_ID),
        connection.getAccountInfo(agentPda),
        connection.getAccountInfo(sessionPda),
        connection.getBalance(walletPda),
        connection.getBalance(sessionKeypair.publicKey),
        connection.getBalance(sealSession.agentPubkey),
    ]);

    console.log(`${sealInfo ? PASS : FAIL} Seal program exists on ${network}`);
    if (!sealInfo) {
        console.error(`   ${PASS} Program ID: ${SEAL_PROGRAM_ID.toBase58()}`);
        console.error(`   Deploy the Seal program to ${network} before live trading.`);
    }

    console.log(`${agentInfo ? PASS : FAIL} Agent PDA on-chain  ${agentInfo ? `(${agentInfo.data.length} bytes)` : "— NOT REGISTERED"}`);
    console.log(`${sessionInfo ? PASS : FAIL} Session PDA on-chain ${sessionInfo ? `(${sessionInfo.data.length} bytes)` : "— SESSION NOT CREATED"}`);

    console.log(`\n${INFO}BALANCES:`);
    console.log(`${"   "} Wallet PDA     : ${SOL(walletPdaBalance)}`);
    console.log(`${"   "} Session signer : ${SOL(sessionSignerBalance)}`);
    console.log(`${"   "} Agent keypair  : ${SOL(agentBalance)}`);
    console.log(`${"   "} TOTAL          : ${SOL(walletPdaBalance + sessionSignerBalance)}`);

    if (!agentInfo) {
        console.error(`\n${FAIL} Agent PDA not on-chain. The user never completed the setup TX.`);
        process.exit(1);
    }
    if (!sessionInfo) {
        console.error(`\n${FAIL} Session PDA not on-chain. CreateSession TX was never sent/confirmed.`);
        process.exit(1);
    }

    // ═══════════════════════════════════════════════════════
    // 4. SESSION LIMITS (decode on-chain data)
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("4. SESSION LIMITS (on-chain)"));
    try {
        // SessionKey layout (after 8-byte discriminator, from Seal program):
        // bump: u8 (1)
        // wallet: PublicKey (32)
        // agent: PublicKey (32)
        // signer: PublicKey (32)
        // expiry: i64 (8)
        // max_amount: u64 (8)
        // max_per_tx: u64 (8)
        // spent: u64 (8) ... approx offsets
        const data = sessionInfo!.data;
        // Try to parse — layout may vary by Seal version
        // Anchor discriminator = 8 bytes, then fields
        // This is approximate — adjust offsets if wrong
        const DISC_SIZE = 8;
        const PK_SIZE = 32;
        // After disc: bump(1), wallet(32), agent(32), signer(32), expiry(8), max_amount(8), max_per_tx(8), spent(8)
        const expiryOffset = DISC_SIZE + 1 + PK_SIZE + PK_SIZE + PK_SIZE;
        const maxAmountOffset = expiryOffset + 8;
        const maxPerTxOffset = maxAmountOffset + 8;
        const spentOffset = maxPerTxOffset + 8;

        if (data.length >= spentOffset + 8) {
            const expiryBig = data.readBigInt64LE(expiryOffset);
            const maxAmountBig = data.readBigUInt64LE(maxAmountOffset);
            const maxPerTxBig = data.readBigUInt64LE(maxPerTxOffset);
            const spentBig = data.readBigUInt64LE(spentOffset);

            const expiryDate = new Date(Number(expiryBig) * 1000);
            const isExpired = expiryDate < new Date();

            console.log(`${isExpired ? FAIL : PASS} Expiry      : ${expiryDate.toISOString()} ${isExpired ? "(EXPIRED!)" : "(OK)"}`);
            console.log(`${INFO}Max amount  : ${SOL(Number(maxAmountBig))}`);
            console.log(`${INFO}Max per TX  : ${SOL(Number(maxPerTxBig))}`);
            console.log(`${INFO}Spent so far: ${SOL(Number(spentBig))}`);
            console.log(`${INFO}Remaining   : ${SOL(Number(maxAmountBig - spentBig))}`);

            const posLamports = Math.floor(botRow.positionSizeSOL * LAMPORTS_PER_SOL);
            if (posLamports > Number(maxPerTxBig)) {
                console.log(`${FAIL} Position size (${SOL(posLamports)}) EXCEEDS maxPerTx (${SOL(Number(maxPerTxBig))})`);
            } else {
                console.log(`${PASS} Position size (${SOL(posLamports)}) fits maxPerTx (${SOL(Number(maxPerTxBig))})`);
            }
            if (posLamports > Number(maxAmountBig - spentBig)) {
                console.log(`${FAIL} Remaining allowance too low — session limit nearly exhausted`);
            }
        } else {
            console.log(`${WARN}Session data too short (${data.length} bytes) — can't parse limits`);
        }
    } catch (e) {
        console.log(`${WARN}Could not parse session PDA data: ${e}`);
    }

    // ═══════════════════════════════════════════════════════
    // 5. ALLOWED PROGRAMS LIST
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("5. SEAL ALLOWED PROGRAMS"));

    const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    const rawAllowed = [
        config.SEAL_ALLOWED_PROGRAMS,
        network === "mainnet-beta" ? config.SEAL_ALLOWED_PROGRAMS_MAINNET : config.SEAL_ALLOWED_PROGRAMS_DEVNET,
    ]
        .filter(Boolean)
        .join(",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const allAllowed = [
        SystemProgram.programId.toBase58(),
        TOKEN_PROGRAM_ID.toBase58(),
        TOKEN_2022_PROGRAM_ID.toBase58(),
        ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        ...rawAllowed,
    ];

    const dlmmAllowed = allAllowed.includes(DLMM_PROGRAM_ID.toBase58());
    console.log(`${INFO}Config env: SEAL_ALLOWED_PROGRAMS_MAINNET = "${config.SEAL_ALLOWED_PROGRAMS_MAINNET ?? "(not set)"}"`);
    console.log(`${INFO}Full list  : ${allAllowed.join(", ")}`);
    console.log(`${dlmmAllowed ? PASS : FAIL} DLMM program (${DLMM_PROGRAM_ID.toBase58().slice(0, 8)}…) in allowed list`);

    if (!dlmmAllowed) {
        console.log(`   → Set SEAL_ALLOWED_PROGRAMS_MAINNET=LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo in Railway vars`);
    }

    // ═══════════════════════════════════════════════════════
    // 6. SIMULATE: TRANSFERLAMPORTS (pre-fund)
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("6. SIMULATE: TransferLamports (pre-fund session)"));

    const positionSizeLamports = Math.floor(botRow.positionSizeSOL * LAMPORTS_PER_SOL);
    const POSITION_RENT_ESTIMATE = 60_000_000; // ~0.06 SOL
    const TX_FEE_BUFFER = 10_000_000; // ~0.01 SOL
    const neededLamports = positionSizeLamports + POSITION_RENT_ESTIMATE + TX_FEE_BUFFER;

    console.log(`${INFO}Position size   : ${SOL(positionSizeLamports)}`);
    console.log(`${INFO}Rent estimate   : ${SOL(POSITION_RENT_ESTIMATE)}`);
    console.log(`${INFO}Fee buffer      : ${SOL(TX_FEE_BUFFER)}`);
    console.log(`${INFO}Total needed    : ${SOL(neededLamports)}`);
    console.log(`${INFO}Session signer  : ${SOL(sessionSignerBalance)} (currently)`);
    console.log(`${INFO}Wallet PDA      : ${SOL(walletPdaBalance)} (currently)`);

    if (sessionSignerBalance >= neededLamports) {
        console.log(`${PASS} Session signer already has enough — no pre-fund needed`);
    } else {
        const deficit = neededLamports - sessionSignerBalance;
        const MIN_WALLET_RENT = 890_880;
        const transferAmount = Math.min(deficit, Math.max(0, walletPdaBalance - MIN_WALLET_RENT));

        console.log(`${INFO}Deficit         : ${SOL(deficit)}`);
        console.log(`${INFO}Max transferable: ${SOL(Math.max(0, walletPdaBalance - MIN_WALLET_RENT))}`);

        if (transferAmount < 10_000) {
            console.log(`${FAIL} Cannot pre-fund — wallet PDA balance too low`);
            console.log(`   → Wallet PDA has ${SOL(walletPdaBalance)}, needs at least ${SOL(MIN_WALLET_RENT)} for rent`);
        } else {
            // Build TransferLamports TX and simulate
            const tlData = Buffer.concat([
                Buffer.from([TRANSFER_LAMPORTS_DISC]),
                encodeU64(BigInt(transferAmount)),
            ]);

            const tlIx = new TransactionInstruction({
                programId: SEAL_PROGRAM_ID,
                keys: [
                    { pubkey: sessionKeypair.publicKey, isSigner: true, isWritable: false },
                    { pubkey: walletPda, isSigner: false, isWritable: true },
                    { pubkey: agentPda, isSigner: false, isWritable: true },
                    { pubkey: sessionPda, isSigner: false, isWritable: true },
                    { pubkey: sessionKeypair.publicKey, isSigner: false, isWritable: true },
                ],
                data: tlData,
            });

            const { blockhash } = await connection.getLatestBlockhash();
            const tlTx = new Transaction();
            tlTx.feePayer = sessionSignerBalance < 5_000
                ? sealSession.agentPubkey   // agent as fee payer if session signer empty
                : sessionKeypair.publicKey;
            tlTx.recentBlockhash = blockhash;
            tlTx.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
                tlIx,
            );

            console.log(`${INFO}Simulating TransferLamports (${SOL(transferAmount)})...`);
            try {
                const simResult = await connection.simulateTransaction(tlTx, [
                    sessionSignerBalance < 5_000 ? Keypair.fromSecretKey(Buffer.from(botRow.agentSecretKey!, "base64")) : sessionKeypair,
                    sessionKeypair,
                ]);

                if (simResult.value.err) {
                    console.log(`${FAIL} TransferLamports simulation FAILED`);
                    console.log(`   Error : ${JSON.stringify(simResult.value.err)}`);
                    console.log(`   Logs  :`);
                    simResult.value.logs?.forEach((l) => console.log(`     ${l}`));
                } else {
                    console.log(`${PASS} TransferLamports simulation OK`);
                    console.log(`   Units used: ${simResult.value.unitsConsumed}`);
                }
            } catch (e) {
                console.log(`${FAIL} simulateTransaction threw: ${e}`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // 7. FIND AN ELIGIBLE POOL
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("7. FIND A TEST POOL (from Meteora API)"));

    let testPool: any;
    try {
        const resp = await fetch(`${config.METEORA_API_URL}/pair/all`);
        const pairs: any[] = await resp.json();
        // Filter SOL-based pools with decent volume
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const eligible = pairs.filter(
            (p) =>
                (p.mint_x === SOL_MINT || p.mint_y === SOL_MINT) &&
                Number(p.liquidity) >= (botRow.minLiquidity ?? 100) &&
                Number(p.liquidity) <= (botRow.maxLiquidity ?? 1_000_000) &&
                Number(p.trade_volume_24h) >= (botRow.minVolume24h ?? 1000)
        );
        testPool = eligible[0];
        if (testPool) {
            console.log(`${PASS} Found eligible pool: ${testPool.name} (${addr(testPool.address)})`);
            console.log(`${INFO}Liquidity : $${Number(testPool.liquidity).toFixed(0)}`);
            console.log(`${INFO}Volume 24h: $${Number(testPool.trade_volume_24h).toFixed(0)}`);
            console.log(`${INFO}Bin step  : ${testPool.bin_step}`);
        } else {
            console.log(`${WARN}No eligible pool found with current bot config — relaxing filters`);
            // Use first SOL pool regardless of volume/liquidity
            testPool = pairs.find((p) => p.mint_x === SOL_MINT || p.mint_y === SOL_MINT);
            if (testPool) {
                console.log(`${INFO}Using pool: ${testPool.name} (${addr(testPool.address)})`);
            }
        }
    } catch (e) {
        console.log(`${FAIL} Failed to fetch pools: ${e}`);
    }

    if (!testPool) {
        console.log(`${WARN}Skipping TX simulation — no pool available`);
        printSummary();
        return;
    }

    // ═══════════════════════════════════════════════════════
    // 8. SIMULATE: FULL OPEN POSITION
    // ═══════════════════════════════════════════════════════
    console.log(HEADER("8. SIMULATE: Full openPosition (executeViaSession)"));

    try {
        console.log(`${INFO}Step 8a: Create DLMM instance...`);
        const dlmm = await DLMM.create(connection, new PublicKey(testPool.address));
        const activeBin = await dlmm.getActiveBin();
        const positionKeypair = Keypair.generate();
        const binRange = botRow.defaultBinRange ?? 10;
        const strategy = {
            maxBinId: activeBin.binId + binRange,
            minBinId: activeBin.binId - binRange,
            strategyType: 0, // Spot
        };

        // Use a small test amount to avoid hitting session limits
        const testAmount = Math.min(positionSizeLamports, 10_000_000); // max 0.01 SOL for test
        const amountX = new BN(0);
        const amountY = new BN(testAmount);

        console.log(`${INFO}Step 8b: Build DLMM position TX (amount: ${SOL(testAmount)})...`);
        const rawTx: Transaction = await dlmm.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: positionKeypair.publicKey,
            user: walletPda,
            totalXAmount: amountX,
            totalYAmount: amountY,
            strategy,
        });

        console.log(`${PASS} DLMM TX built (${rawTx.instructions.length} instructions)`);
        rawTx.instructions.forEach((ix, i) => {
            console.log(`${INFO}  [${i}] ${ix.programId.toBase58().slice(0, 12)}… (${ix.keys.length} keys, ${ix.data.length} bytes)`);
        });

        // ── 8c: Rewrite payer accounts (walletPda → sessionSigner) ──
        console.log(`\n${INFO}Step 8c: Rewrite delegated accounts...`);
        const sessionSigner = sessionKeypair.publicKey;
        const rewrittenTx = new Transaction();
        rewrittenTx.feePayer = sessionSigner;
        rewrittenTx.recentBlockhash = rawTx.recentBlockhash;

        for (const ix of rawTx.instructions) {
            const keys = ix.keys.map((k) => ({ ...k }));

            if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && keys[0]?.pubkey.equals(walletPda)) {
                keys[0] = { ...keys[0], pubkey: sessionSigner, isSigner: true, isWritable: true };
                console.log(`${INFO}  Rewrote ATA payer: walletPda → sessionSigner`);
            } else if (ix.programId.equals(SystemProgram.programId) && keys[0]?.pubkey.equals(walletPda)) {
                keys[0] = { ...keys[0], pubkey: sessionSigner, isSigner: true, isWritable: true };
                console.log(`${INFO}  Rewrote System payer: walletPda → sessionSigner`);
            } else if (matchesDisc(Buffer.from(ix.data), DLMM_INIT_POSITION_DISC) && keys[0]?.pubkey.equals(walletPda)) {
                keys[0] = { ...keys[0], pubkey: sessionSigner, isSigner: true, isWritable: true };
                console.log(`${INFO}  Rewrote DLMM InitPosition payer: walletPda → sessionSigner`);
            } else if (matchesDisc(Buffer.from(ix.data), DLMM_INIT_BIN_ARRAY_DISC) && keys[2]?.pubkey.equals(walletPda)) {
                keys[2] = { ...keys[2], pubkey: sessionSigner, isSigner: true, isWritable: true };
                console.log(`${INFO}  Rewrote DLMM InitBinArray funder: walletPda → sessionSigner`);
            }

            rewrittenTx.add(new TransactionInstruction({ programId: ix.programId, keys, data: ix.data }));
        }

        // ── 8d: Wrap in executeViaSession ──
        console.log(`\n${INFO}Step 8d: Wrap instructions in executeViaSession...`);

        const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
        const WRAPPABLE_PROGRAMS = new Set([
            SystemProgram.programId.toBase58(),
            TOKEN_PROGRAM_ID.toBase58(),
            TOKEN_2022_PROGRAM_ID.toBase58(),
            ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
            MEMO_PROGRAM_ID.toBase58(),
            DLMM_PROGRAM_ID.toBase58(),
            ...(config.SEAL_ALLOWED_PROGRAMS_MAINNET ?? "").split(",").map((s) => s.trim()).filter(Boolean),
            ...(config.SEAL_ALLOWED_PROGRAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        ]);

        const wrappedTx = new Transaction();
        wrappedTx.feePayer = sessionSigner;

        for (const ix of rewrittenTx.instructions) {
            if (ix.programId.equals(ComputeBudgetProgram.programId)) {
                wrappedTx.add(ix);
                continue;
            }

            if (!WRAPPABLE_PROGRAMS.has(ix.programId.toBase58())) {
                console.log(`${FAIL} UNSUPPORTED PROGRAM: ${ix.programId.toBase58()}`);
                console.log(`   → Add to SEAL_ALLOWED_PROGRAMS_MAINNET env var`);
                continue;
            }

            // Strip signer from walletPda (Seal re-adds it via invoke_signed)
            const remainingAccounts = ix.keys.map((k) => ({
                pubkey: k.pubkey,
                isSigner: k.pubkey.equals(walletPda) ? false : k.isSigner,
                isWritable: k.isWritable,
            }));

            const wrapData = Buffer.concat([
                Buffer.from([EXECUTE_VIA_SESSION_DISC]),
                encodeU64(BigInt(testAmount)),
                ix.data,
            ]);

            const wrappedIx = new TransactionInstruction({
                programId: SEAL_PROGRAM_ID,
                keys: [
                    { pubkey: sessionSigner, isSigner: true, isWritable: false },
                    { pubkey: walletPda, isSigner: false, isWritable: true },
                    { pubkey: agentPda, isSigner: false, isWritable: true },
                    { pubkey: sessionPda, isSigner: false, isWritable: true },
                    { pubkey: ix.programId, isSigner: false, isWritable: false },
                    ...remainingAccounts,
                ],
                data: wrapData,
            });

            wrappedTx.add(wrappedIx);
        }

        console.log(`${PASS} Wrapped TX: ${wrappedTx.instructions.length} instructions`);

        // ── 8e: Add compute budget + blockhash ──
        const finalTx = new Transaction();
        finalTx.feePayer = sessionSigner;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        finalTx.recentBlockhash = blockhash;
        finalTx.lastValidBlockHeight = lastValidBlockHeight;
        finalTx.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
        );
        for (const ix of wrappedTx.instructions) finalTx.add(ix);

        // ── 8f: SIMULATE ──
        console.log(`\n${INFO}Step 8e: SIMULATING full openPosition TX...`);
        const simResult = await connection.simulateTransaction(finalTx, [
            sessionKeypair,
            positionKeypair,
        ]);

        console.log(DIVIDER);
        if (simResult.value.err) {
            console.log(`${FAIL} SIMULATION FAILED`);
            console.log(`   Error : ${JSON.stringify(simResult.value.err, null, 2)}`);
        } else {
            console.log(`${PASS} SIMULATION SUCCEEDED`);
            console.log(`   Units : ${simResult.value.unitsConsumed}`);
        }
        console.log(`\n   PROGRAM LOGS:`);
        if (simResult.value.logs?.length) {
            simResult.value.logs.forEach((l) => console.log(`     ${l}`));
        } else {
            console.log(`     (no logs)`);
        }
        console.log(DIVIDER);

    } catch (e) {
        console.log(`${FAIL} openPosition simulation threw an exception:`);
        console.log(`   ${e}`);
        if (e instanceof Error && e.stack) {
            const lines = e.stack.split("\n").slice(1, 4);
            lines.forEach((l) => console.log(`   ${l}`));
        }
    }

    printSummary();
    process.exit(0);
}

function printSummary() {
    console.log(HEADER("DIAGNOSIS COMPLETE"));
    console.log(`Check each ❌ above for the root cause.`);
    console.log(`Common fixes:`);
    console.log(`  • Session expired → delete bot, re-create`);
    console.log(`  • DLMM not in allowed programs → set SEAL_ALLOWED_PROGRAMS_MAINNET in Railway`);
    console.log(`  • Session PDA missing → restart bot (auto-creates)`);
    console.log(`  • Balance too low → fund wallet PDA via 'Fund Wallet' in app`);
    console.log(`  • Spending limit → session maxPerTx < positionSize`);
    console.log();
}

diagnose().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
});
