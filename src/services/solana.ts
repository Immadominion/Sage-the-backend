/**
 * Solana connection service.
 */

import { Connection } from "@solana/web3.js";
import config from "../config.js";

// ═══════════════════════════════════════════════════════════════
// Connection (singleton with timeout)
// ═══════════════════════════════════════════════════════════════

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000, // 60s for tx confirmation
      disableRetryOnRateLimit: false,
    });
  }
  return connection;
}

// ═══════════════════════════════════════════════════════════════
// RPC Retry Helper
// ═══════════════════════════════════════════════════════════════

/**
 * Retry an async RPC call with exponential backoff.
 * Handles transient `TypeError: fetch failed` and network errors
 * that are common with public Solana RPC endpoints.
 */
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, baseDelayMs = 500 } = {}
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes("fetch failed") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("socket hang up") ||
        msg.includes("429") ||
        msg.includes("503");

      if (!isTransient || attempt === retries) break;

      const delay = baseDelayMs * 2 ** attempt;
      console.warn(
        `[RPC] Attempt ${attempt + 1}/${retries + 1} failed (${msg}), retrying in ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
