/**
 * TransactionSender — Robust Solana transaction submission with retry.
 *
 * Ported from lp-bot/src/executors/transaction-sender.ts for ESM.
 *
 * Features:
 *  - Exponential backoff on failure
 *  - Fresh blockhash per retry (prevents expiry)
 *  - Priority fee injection (ComputeBudget)
 *  - Confirmation polling with timeout
 *  - Legacy & VersionedTransaction support
 *
 * ⚠️ FINANCIAL WARNING: This sends REAL transactions with REAL money.
 */

import {
  Connection,
  Transaction,
  VersionedTransaction,
  type SendOptions,
  type TransactionSignature,
  Keypair,
  type Commitment,
  ComputeBudgetProgram,
  TransactionMessage,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "tx-sender" });

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

export interface TransactionSenderConfig {
  commitment: Commitment;
  confirmationTimeoutMs: number;
  skipPreflight: boolean;

  maxRetries: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;

  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
}

const DEFAULT_CONFIG: TransactionSenderConfig = {
  commitment: "confirmed",
  confirmationTimeoutMs: 60_000,
  skipPreflight: false,
  maxRetries: 3,
  initialRetryDelayMs: 1_000,
  maxRetryDelayMs: 10_000,
  priorityFeeMicroLamports: 10_000,
  computeUnitLimit: 200_000,
};

// ═══════════════════════════════════════════════════════════════
// Result type
// ═══════════════════════════════════════════════════════════════

export interface SendResult {
  success: boolean;
  signature?: TransactionSignature;
  error?: string;
  retries: number;
  confirmationTime?: number;
}

// ═══════════════════════════════════════════════════════════════
// TransactionSender
// ═══════════════════════════════════════════════════════════════

export class TransactionSender {
  private connection: Connection;
  private config: TransactionSenderConfig;

  constructor(
    connection: Connection,
    config?: Partial<TransactionSenderConfig>
  ) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Send a transaction with retry logic.
   * Handles both legacy Transaction and VersionedTransaction.
   */
  async sendTransaction(
    transaction: Transaction | VersionedTransaction,
    signers: Keypair[],
    options?: Partial<SendOptions>
  ): Promise<SendResult> {
    let lastError: Error | null = null;
    let retries = 0;
    const startTime = Date.now();

    while (retries <= this.config.maxRetries) {
      try {
        // Fresh blockhash every attempt (prevents expiry failures)
        const { blockhash, lastValidBlockHeight } =
          await this.connection.getLatestBlockhash(this.config.commitment);

        // Update blockhash on legacy transactions
        if (transaction instanceof Transaction) {
          transaction.recentBlockhash = blockhash;
          transaction.lastValidBlockHeight = lastValidBlockHeight;

          if (signers.length > 0) {
            transaction.sign(...signers);
          }
        }

        const sendOpts: SendOptions = {
          skipPreflight: this.config.skipPreflight,
          preflightCommitment: this.config.commitment,
          maxRetries: 0, // We handle retries ourselves
          ...options,
        };

        const signature: TransactionSignature =
          await this.connection.sendRawTransaction(
            transaction.serialize(),
            sendOpts
          );

        log.info(
          { signature, retry: retries },
          "Transaction sent, awaiting confirmation…"
        );

        // Poll for confirmation
        const confirmResult = await this.confirmTransaction(
          signature,
          blockhash,
          lastValidBlockHeight
        );

        if (confirmResult.confirmed) {
          const confirmationTime = Date.now() - startTime;
          log.info(
            { signature, confirmationTime, retries },
            "Transaction confirmed"
          );
          return { success: true, signature, retries, confirmationTime };
        }

        lastError = new Error(confirmResult.error ?? "Confirmation failed");
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        log.warn(
          { error: lastError.message, retry: retries },
          "Transaction attempt failed"
        );
      }

      // Exponential backoff before next retry
      if (retries < this.config.maxRetries) {
        const delay = Math.min(
          this.config.initialRetryDelayMs * Math.pow(2, retries),
          this.config.maxRetryDelayMs
        );
        await sleep(delay);
      }

      retries++;
    }

    log.error(
      { error: lastError?.message, totalRetries: retries - 1 },
      "Transaction failed after all retries"
    );

    return {
      success: false,
      error: lastError?.message ?? "Unknown error",
      retries: retries - 1,
    };
  }

  /**
   * Inject ComputeBudget priority-fee instructions into a legacy tx.
   * Idempotent — won't duplicate if instructions already present.
   */
  addPriorityFee(transaction: Transaction): Transaction {
    const CB = "ComputeBudget111111111111111111111111111111";

    const hasLimit = transaction.instructions.some(
      (ix) =>
        ix.programId.toBase58() === CB &&
        ix.data.length > 0 &&
        ix.data[0] === 2 // SetComputeUnitLimit
    );

    const hasPrice = transaction.instructions.some(
      (ix) =>
        ix.programId.toBase58() === CB &&
        ix.data.length > 0 &&
        ix.data[0] === 3 // SetComputeUnitPrice
    );

    const prepend: TransactionInstruction[] = [];

    if (!hasLimit) {
      prepend.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: this.config.computeUnitLimit,
        })
      );
    }
    if (!hasPrice) {
      prepend.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityFeeMicroLamports,
        })
      );
    }

    if (prepend.length > 0) {
      transaction.instructions = [...prepend, ...transaction.instructions];
    }

    return transaction;
  }

  /**
   * Build a versioned transaction with priority fees pre-injected.
   */
  async createVersionedTransaction(
    instructions: TransactionInstruction[],
    payer: Keypair,
    lookupTables?: AddressLookupTableAccount[]
  ): Promise<VersionedTransaction> {
    const { blockhash } = await this.connection.getLatestBlockhash(
      this.config.commitment
    );

    const allIx: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: this.config.computeUnitLimit,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.config.priorityFeeMicroLamports,
      }),
      ...instructions,
    ];

    const msgV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: allIx,
    }).compileToV0Message(lookupTables);

    const vtx = new VersionedTransaction(msgV0);
    vtx.sign([payer]);
    return vtx;
  }

  /**
   * Update priority fee dynamically.
   */
  setPriorityFee(microLamports: number): void {
    this.config.priorityFeeMicroLamports = microLamports;
    log.info({ priorityFeeMicroLamports: microLamports }, "Priority fee updated");
  }

  // ── Private ──

  private async confirmTransaction(
    signature: TransactionSignature,
    _blockhash: string,
    lastValidBlockHeight: number
  ): Promise<{ confirmed: boolean; error?: string }> {
    const deadline = Date.now() + this.config.confirmationTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (status.value) {
          if (status.value.err) {
            return {
              confirmed: false,
              error: `Transaction error: ${JSON.stringify(status.value.err)}`,
            };
          }

          if (
            status.value.confirmationStatus === this.config.commitment ||
            status.value.confirmationStatus === "finalized"
          ) {
            return { confirmed: true };
          }
        }

        // Check blockheight expiry
        const currentHeight = await this.connection.getBlockHeight();
        if (currentHeight > lastValidBlockHeight) {
          return { confirmed: false, error: "Blockhash expired" };
        }

        await sleep(1_000);
      } catch {
        // Network blip — keep polling
        await sleep(1_000);
      }
    }

    return { confirmed: false, error: "Confirmation timeout" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default TransactionSender;
