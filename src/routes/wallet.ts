/**
 * Sentinel wallet routes — proxy to on-chain wallet operations.
 *
 * These endpoints prepare unsigned transactions that the Flutter app
 * signs via MWA (Mobile Wallet Adapter) and submits.
 *
 * Ported from sentinel/backend/src/routes/wallet.ts — now requires auth.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getConnection,
  deriveWalletPda,
  SENTINEL_PROGRAM_ID,
} from "../services/solana.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import db from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

const wallet = new Hono<{ Variables: AuthVariables }>();

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const createWalletSchema = z.object({
  dailyLimitSol: z.number().positive().max(1000).default(10),
  perTxLimitSol: z.number().positive().max(100).default(1),
});

// ═══════════════════════════════════════════════════════════════
// Discriminators & Account Parsing (from sentinel backend)
// ═══════════════════════════════════════════════════════════════

const SMART_WALLET_DISCRIMINATOR = Buffer.from("SentWalt");

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

interface SmartWalletState {
  address: string;
  owner: string;
  bump: number;
  nonce: string;
  agentCount: number;
  guardianCount: number;
  guardians: string[];
  dailyLimitSol: number;
  perTxLimitSol: number;
  spentTodaySol: number;
  dayStartTimestamp: number;
  isLocked: boolean;
  isClosed: boolean;
}

function parseSmartWallet(
  address: string,
  data: Buffer
): SmartWalletState | null {
  if (data.length < 245) return null;
  const disc = data.subarray(0, 8);
  if (!disc.equals(SMART_WALLET_DISCRIMINATOR)) return null;

  const guardianCount = data[50];
  const guardians: string[] = [];
  for (let i = 0; i < guardianCount && i < 5; i++) {
    guardians.push(readPubkey(data, 51 + i * 32));
  }

  return {
    address,
    owner: readPubkey(data, 8),
    bump: data[40],
    nonce: readU64LE(data, 41).toString(),
    agentCount: data[49],
    guardianCount,
    guardians,
    dailyLimitSol: Number(readU64LE(data, 211)) / LAMPORTS_PER_SOL,
    perTxLimitSol: Number(readU64LE(data, 219)) / LAMPORTS_PER_SOL,
    spentTodaySol: Number(readU64LE(data, 227)) / LAMPORTS_PER_SOL,
    dayStartTimestamp: Number(readU64LE(data, 235)),
    isLocked: data[243] !== 0,
    isClosed: data[244] !== 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Instruction Builder
// ═══════════════════════════════════════════════════════════════

function encodeU64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function buildCreateWalletIx(
  owner: PublicKey,
  walletPda: PublicKey,
  bump: number,
  dailyLimitLamports: bigint,
  perTxLimitLamports: bigint
) {
  const data = Buffer.concat([
    Buffer.from([0]), // CreateWallet discriminant
    Buffer.from([bump]),
    encodeU64(dailyLimitLamports),
    encodeU64(perTxLimitLamports),
  ]);

  return {
    programId: SENTINEL_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  };
}

// ═══════════════════════════════════════════════════════════════
// Routes (all require auth)
// ═══════════════════════════════════════════════════════════════

/**
 * POST /wallet/prepare-create
 * Prepare unsigned TX for Sentinel wallet creation.
 * Uses the authenticated user's wallet as the owner.
 */
wallet.post(
  "/prepare-create",
  requireAuth,
  zValidator("json", createWalletSchema),
  async (c) => {
    const ownerAddress = c.var.walletAddress;
    const body = c.req.valid("json");
    const ownerPubkey = new PublicKey(ownerAddress);

    const [walletPda, bump] = deriveWalletPda(ownerPubkey);

    // Check if wallet already exists
    const connection = getConnection();
    const existing = await connection.getAccountInfo(walletPda);
    if (existing) {
      throw createApiError("Sentinel wallet already exists", 409, {
        walletAddress: walletPda.toBase58(),
      });
    }

    const dailyLimitLamports = BigInt(
      Math.floor(body.dailyLimitSol * LAMPORTS_PER_SOL)
    );
    const perTxLimitLamports = BigInt(
      Math.floor(body.perTxLimitSol * LAMPORTS_PER_SOL)
    );

    const ix = buildCreateWalletIx(
      ownerPubkey,
      walletPda,
      bump,
      dailyLimitLamports,
      perTxLimitLamports
    );

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = blockhash;
    tx.feePayer = ownerPubkey;

    const serialized = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    // Store sentinel wallet address in user record
    db.update(users)
      .set({ sentinelWalletAddress: walletPda.toBase58() })
      .where(eq(users.walletAddress, ownerAddress))
      .run();

    return c.json({
      success: true,
      walletAddress: walletPda.toBase58(),
      transaction: serialized,
      blockhash,
      lastValidBlockHeight,
    });
  }
);

/**
 * GET /wallet/state
 * Get authenticated user's Sentinel wallet state.
 */
wallet.get("/state", requireAuth, async (c) => {
  const ownerAddress = c.var.walletAddress;
  const ownerPubkey = new PublicKey(ownerAddress);
  const [walletPda] = deriveWalletPda(ownerPubkey);

  const connection = getConnection();
  const accountInfo = await connection.getAccountInfo(walletPda);

  if (!accountInfo) {
    return c.json({
      success: true,
      exists: false,
      walletAddress: walletPda.toBase58(),
    });
  }

  const walletState = parseSmartWallet(
    walletPda.toBase58(),
    accountInfo.data as Buffer
  );

  return c.json({ success: true, exists: true, wallet: walletState });
});

/**
 * GET /wallet/balance
 * Get SOL balance of authenticated user's Sentinel wallet.
 */
wallet.get("/balance", requireAuth, async (c) => {
  const ownerAddress = c.var.walletAddress;
  const ownerPubkey = new PublicKey(ownerAddress);
  const [walletPda] = deriveWalletPda(ownerPubkey);

  const connection = getConnection();
  const lamports = await connection.getBalance(walletPda);

  return c.json({
    success: true,
    lamports,
    sol: lamports / LAMPORTS_PER_SOL,
  });
});

export default wallet;
