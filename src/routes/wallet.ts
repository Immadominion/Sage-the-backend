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
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
// Withdraw SOL from bot wallet → bot.ownerWallet (the SIWS-authenticated
// wallet that registered the bot).
//
// Security (H2): the backend signs the transfer with the bot's keypair,
// so we MUST NOT let a caller redirect funds. `destination` is accepted
// for API compatibility but is required to equal `bot.ownerWallet` —
// any mismatch is rejected. To withdraw elsewhere, send to the owner
// wallet first and forward from there using a real wallet signature.
// ═══════════════════════════════════════════════════════════════

const withdrawSchema = z.object({
  amountSOL: z.number().positive().max(10_000),
  /** Optional — if supplied, MUST equal bot.ownerWallet. Backend never honours an arbitrary value. */
  destination: z.string().min(32).max(50).optional(),
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
    const { amountSOL, destination } = c.req.valid("json");

    if (!bot.ownerWallet) {
      throw createApiError(
        "Owner wallet not set — cannot withdraw. Contact support.",
        400
      );
    }

    // If the caller specified a destination, it must equal the bot's
    // owner wallet — otherwise we'd be letting whoever holds the access
    // token drain funds anywhere.
    if (destination && destination !== bot.ownerWallet) {
      throw createApiError(
        "Withdrawals are only allowed to the bot's registered owner wallet",
        403
      );
    }

    const destinationAddress = bot.ownerWallet;
    let destinationPubkey: PublicKey;
    try {
      destinationPubkey = new PublicKey(destinationAddress);
    } catch {
      throw createApiError("Invalid owner wallet address on record", 500);
    }

    const connection = getConnection();
    const botPubkey = new PublicKey(bot.walletAddress!);
    const requestedLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    const balance = await connection.getBalance(botPubkey);

    // "Drain all" mode: when the user requests >= balance, drain the entire
    // account to zero.  We skip priority fees for drain TXs (a simple SOL
    // transfer lands fine with just the 5 000-lamport base fee) so the
    // account ends up at exactly 0 lamports and gets garbage-collected.
    const BASE_FEE_LAMPORTS = 5_000; // 1 signature × 5000
    const isDrain = requestedLamports >= balance - BASE_FEE_LAMPORTS;

    if (balance <= BASE_FEE_LAMPORTS) {
      throw createApiError(
        `Balance too low to cover the transaction fee ` +
        `(${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
        400
      );
    }

    const withdrawLamports = isDrain
      ? balance - BASE_FEE_LAMPORTS   // drain: send everything minus the base fee
      : Math.min(requestedLamports, balance - BASE_FEE_LAMPORTS);

    // Decrypt keypair, sign, send
    const keypair = decryptKeypair(
      bot.encryptedPrivateKey!,
      config.MASTER_ENCRYPTION_KEY
    );

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: botPubkey,
          toPubkey: destinationPubkey,
          lamports: withdrawLamports,
        })
      );

      const txSender = new TransactionSender(connection);
      // Skip priority fees on drain TXs — maximizes amount sent,
      // account goes to 0 lamports and gets GC'd by the runtime.
      const finalTx = isDrain ? tx : txSender.addPriorityFee(tx);
      const result = await txSender.sendTransaction(finalTx, [keypair]);

      if (!result.success) {
        throw createApiError(
          `Withdrawal failed: ${result.error ?? "unknown"}`,
          500
        );
      }

      const actualSOL = withdrawLamports / LAMPORTS_PER_SOL;
      return c.json({
        success: true,
        signature: result.signature,
        amountSOL: actualSOL,
        drained: isDrain,
        from: bot.walletAddress,
        to: destinationAddress,
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

// ═══════════════════════════════════════════════════════════════
// GET /wallet/balances — All bot wallet balances (SOL + tokens)
// Aggregates across all live-mode bots for the authenticated user.
// ═══════════════════════════════════════════════════════════════

wallet.get("/balances", requireAuth, async (c) => {
  const userId = c.var.userId;

  const rows = await db
    .select()
    .from(bots)
    .where(and(eq(bots.userId, userId), eq(bots.mode, "live")));

  const liveBots = rows.filter(
    (r) => r.walletAddress && r.encryptedPrivateKey
  );

  if (liveBots.length === 0) {
    return c.json({
      wallets: [],
      totalSOL: 0,
      tokenAccounts: [],
    });
  }

  const connection = getConnection();

  type WalletInfo = {
    botId: string;
    botName: string;
    walletAddress: string;
    balanceSOL: number;
    tokens: { mint: string; amount: number; decimals: number }[];
  };

  const wallets: WalletInfo[] = [];
  let totalSOL = 0;
  const tokenMap = new Map<
    string,
    { mint: string; totalAmount: number; decimals: number }
  >();

  await Promise.all(
    liveBots.map(async (bot) => {
      const pubkey = new PublicKey(bot.walletAddress!);
      let solBalance = 0;
      const tokens: WalletInfo["tokens"] = [];

      try {
        solBalance = (await connection.getBalance(pubkey)) / LAMPORTS_PER_SOL;
      } catch {
        // If RPC fails for one wallet, continue with others
      }

      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          pubkey,
          { programId: TOKEN_PROGRAM_ID }
        );

        for (const { account } of tokenAccounts.value) {
          const parsed = account.data.parsed?.info;
          if (!parsed) continue;
          const mint = parsed.mint as string;
          const amount = parsed.tokenAmount?.uiAmount ?? 0;
          const decimals = parsed.tokenAmount?.decimals ?? 0;
          if (amount > 0) {
            tokens.push({ mint, amount, decimals });

            const existing = tokenMap.get(mint);
            if (existing) {
              existing.totalAmount += amount;
            } else {
              tokenMap.set(mint, { mint, totalAmount: amount, decimals });
            }
          }
        }
      } catch {
        // Token query failed for this wallet — continue
      }

      totalSOL += solBalance;
      wallets.push({
        botId: bot.botId,
        botName: bot.name,
        walletAddress: bot.walletAddress!,
        balanceSOL: solBalance,
        tokens,
      });
    })
  );

  return c.json({
    wallets,
    totalSOL,
    tokenAccounts: Array.from(tokenMap.values()),
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /wallet/smart-withdraw — Batch withdraw from multiple wallets
// Withdraws SOL from selected bot wallets to the owner wallet.
// ═══════════════════════════════════════════════════════════════

const smartWithdrawSchema = z.object({
  botIds: z.array(z.string()).min(1).max(50),
});

wallet.post(
  "/smart-withdraw",
  requireAuth,
  zValidator("json", smartWithdrawSchema),
  async (c) => {
    const userId = c.var.userId;
    const { botIds } = c.req.valid("json");

    const connection = getConnection();
    const results: {
      botId: string;
      success: boolean;
      signature?: string;
      amountSOL?: number;
      error?: string;
    }[] = [];

    let totalWithdrawn = 0;

    for (const botId of botIds) {
      try {
        if (!BOT_ID_REGEX.test(botId)) {
          results.push({ botId, success: false, error: "Invalid bot ID" });
          continue;
        }

        const [row] = await db
          .select()
          .from(bots)
          .where(and(eq(bots.botId, botId), eq(bots.userId, userId)));

        if (!row || row.mode !== "live" || !row.walletAddress || !row.encryptedPrivateKey) {
          results.push({ botId, success: false, error: "Not a valid live bot" });
          continue;
        }

        if (!row.ownerWallet) {
          results.push({ botId, success: false, error: "No owner wallet set" });
          continue;
        }

        const botPubkey = new PublicKey(row.walletAddress);
        const ownerPubkey = new PublicKey(row.ownerWallet);
        const balance = await connection.getBalance(botPubkey);
        const BASE_FEE = 5_000;

        if (balance <= BASE_FEE) {
          results.push({
            botId,
            success: true,
            amountSOL: 0,
            signature: undefined,
          });
          continue;
        }

        // Drain entire account — skip priority fees so account → 0 lamports
        const withdrawLamports = balance - BASE_FEE;
        const keypair = decryptKeypair(
          row.encryptedPrivateKey,
          config.MASTER_ENCRYPTION_KEY
        );

        try {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: botPubkey,
              toPubkey: ownerPubkey,
              lamports: withdrawLamports,
            })
          );

          const txSender = new TransactionSender(connection);
          // No priority fee — drain TX, account goes to 0
          const result = await txSender.sendTransaction(tx, [keypair]);

          if (result.success) {
            const sol = withdrawLamports / LAMPORTS_PER_SOL;
            totalWithdrawn += sol;
            results.push({
              botId,
              success: true,
              signature: result.signature,
              amountSOL: sol,
            });
          } else {
            results.push({
              botId,
              success: false,
              error: result.error ?? "Transaction failed",
            });
          }
        } finally {
          keypair.secretKey.fill(0);
        }
      } catch (e: any) {
        results.push({
          botId,
          success: false,
          error: e?.message ?? "Unknown error",
        });
      }
    }

    return c.json({
      success: true,
      totalWithdrawnSOL: totalWithdrawn,
      results,
    });
  }
);


export default wallet;
