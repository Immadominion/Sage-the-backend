/**
 * Wallet routes — bot wallet balance, deposit address, and withdrawal.
 *
 * Each live-mode bot has its own server-side Solana keypair encrypted at rest.
 * These routes let the user check balance, get the deposit address, and
 * withdraw funds (signed server-side, sent to the user's ownerWallet).
 *
 * GET  /wallet/balance/:botId   — SOL balance of the bot's wallet
 * GET  /wallet/address/:botId   — deposit address (public key)
 * POST /wallet/withdraw/:botId  — withdraw SOL to owner wallet
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getConnection } from "../services/solana.js";
import { TransactionSender } from "../engine/transaction-sender.js";
import { decryptKeypair } from "../engine/crypto-utils.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { createApiError } from "../middleware/error.js";
import config from "../config.js";
import db from "../db/index.js";
import { bots } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

const wallet = new Hono<{ Variables: AuthVariables }>();

const BOT_ID_REGEX = /^[0-9a-f]{8}$/;

/** Validate bot ID format. */
function validateBotId(botId: string): void {
  if (!BOT_ID_REGEX.test(botId)) {
    throw createApiError("Invalid bot ID format", 400);
  }
}

/** Look up a live-mode bot that belongs to the authenticated user. */
async function getLiveBot(userId: number, botId: string) {
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

  if (!row) throw createApiError("Bot not found", 404);
  if (row.mode !== "live") throw createApiError("Only live-mode bots have wallets", 400);
  if (!row.walletAddress || !row.encryptedPrivateKey) {
    throw createApiError("Bot wallet not initialized", 400);
  }
  return row;
}

// ═══════════════════════════════════════════════════════════════
// GET /wallet/balance/:botId
// ═══════════════════════════════════════════════════════════════

wallet.get("/balance/:botId", requireAuth, async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const bot = await getLiveBot(userId, botId);
  const connection = getConnection();
  const balanceLamports = await connection.getBalance(
    new PublicKey(bot.walletAddress!)
  );

  return c.json({
    botId,
    walletAddress: bot.walletAddress,
    balanceLamports,
    balanceSOL: balanceLamports / LAMPORTS_PER_SOL,
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /wallet/address/:botId
// Returns the deposit address for a bot. The user sends SOL here.
// ═══════════════════════════════════════════════════════════════

wallet.get("/address/:botId", requireAuth, async (c) => {
  const userId = c.var.userId;
  const botId = c.req.param("botId");
  validateBotId(botId);

  const bot = await getLiveBot(userId, botId);

  return c.json({
    botId,
    walletAddress: bot.walletAddress,
    ownerWallet: bot.ownerWallet,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /wallet/withdraw/:botId
// Withdraw SOL from bot wallet → owner wallet.
// Backend decrypts the keypair and signs the transfer.
// ═══════════════════════════════════════════════════════════════

const withdrawSchema = z.object({
  amountSOL: z.number().positive().max(10_000),
});

wallet.post(
  "/withdraw/:botId",
  requireAuth,
  zValidator("json", withdrawSchema),
  async (c) => {
    const userId = c.var.userId;
    const botId = c.req.param("botId");
    validateBotId(botId);

    const bot = await getLiveBot(userId, botId);
    const { amountSOL } = c.req.valid("json");

    if (!bot.ownerWallet) {
      throw createApiError(
        "Owner wallet not set — cannot withdraw. Contact support.",
        400
      );
    }

    const connection = getConnection();
    const botPubkey = new PublicKey(bot.walletAddress!);
    const ownerPubkey = new PublicKey(bot.ownerWallet);
    const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    // Check balance (leave enough for rent + TX fee)
    const balance = await connection.getBalance(botPubkey);
    const reserveLamports = 10_000; // ~0.00001 SOL for fees
    if (balance < amountLamports + reserveLamports) {
      throw createApiError(
        `Insufficient balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
        `(requested ${amountSOL} SOL)`,
        400
      );
    }

    // Decrypt keypair, sign, send
    const keypair = decryptKeypair(
      bot.encryptedPrivateKey!,
      config.MASTER_ENCRYPTION_KEY
    );

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: botPubkey,
          toPubkey: ownerPubkey,
          lamports: amountLamports,
        })
      );

      const txSender = new TransactionSender(connection);
      const txWithFees = txSender.addPriorityFee(tx);
      const result = await txSender.sendTransaction(txWithFees, [keypair]);

      if (!result.success) {
        throw createApiError(
          `Withdrawal failed: ${result.error ?? "unknown"}`,
          500
        );
      }

      return c.json({
        success: true,
        signature: result.signature,
        amountSOL,
        from: bot.walletAddress,
        to: bot.ownerWallet,
      });
    } finally {
      // Zeroize decrypted key material
      keypair.secretKey.fill(0);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// POST /wallet/prepare-deposit/:botId
// Build a system transfer TX (user → bot wallet) for MWA signing.
// The user (feePayer) signs client-side via their mobile wallet.
// ═══════════════════════════════════════════════════════════════

const prepareDepositSchema = z.object({
  amountSOL: z.number().positive().max(10_000),
  feePayer: z.string().min(32).max(50),
});

wallet.post(
  "/prepare-deposit/:botId",
  requireAuth,
  zValidator("json", prepareDepositSchema),
  async (c) => {
    const userId = c.var.userId;
    const botId = c.req.param("botId");
    validateBotId(botId);

    const bot = await getLiveBot(userId, botId);
    const { amountSOL, feePayer } = c.req.valid("json");

    const connection = getConnection();
    const feePayerPubkey = new PublicKey(feePayer);
    const botPubkey = new PublicKey(bot.walletAddress!);
    const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: feePayerPubkey,
      recentBlockhash: blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: feePayerPubkey,
        toPubkey: botPubkey,
        lamports: amountLamports,
      })
    );

    const serialized = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    return c.json({
      transaction: serialized,
      botId,
      amountSOL,
      depositAddress: bot.walletAddress,
      network: config.SOLANA_NETWORK || "mainnet-beta",
    });
  }
);


export default wallet;
