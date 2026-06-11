/**
 * Wallet Intelligence client.
 *
 * Server-to-server HTTP client for the Python wallet-intelligence FastAPI
 * service, which fetches a wallet's full on-chain history, decodes it, and
 * returns a real behavioral fingerprint + reconstructed DLMM positions.
 *
 * Configured via WALLET_INTEL_URL (+ WALLET_INTEL_API_KEY). When unset, the
 * /brain routes return 503 — the feature is simply unavailable, nothing breaks.
 */

import config from "../config.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "wallet-intel" });

export interface WalletIntelResult {
  wallet: string;
  txs_scanned: number;
  capped: boolean;
  window_days: number;
  fingerprint: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  priced_positions: unknown[];
  events_by_type: Record<string, number>;
  note?: string;
}

/** Whether the wallet-intelligence service is configured. */
export function isConfigured(): boolean {
  return Boolean(config.WALLET_INTEL_URL);
}

/**
 * Analyze a wallet. Blocking call to the Python service (it does fetch +
 * decode + reconstruct in one request, which can take minutes for heavy
 * wallets), so use a generous timeout. Callers run this in the background.
 */
export async function analyzeWallet(
  wallet: string,
  windowDays: number,
  maxTxs: number,
  timeoutMs = 6 * 60_000
): Promise<WalletIntelResult> {
  const base = config.WALLET_INTEL_URL;
  if (!base) throw new Error("WALLET_INTEL_URL not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base.replace(/\/$/, "")}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.WALLET_INTEL_API_KEY
          ? { "X-WI-API-Key": config.WALLET_INTEL_API_KEY }
          : {}),
      },
      body: JSON.stringify({ wallet, window_days: windowDays, max_txs: maxTxs }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`wallet-intel ${resp.status}: ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as WalletIntelResult;
  } catch (err) {
    log.error(
      { wallet, err: err instanceof Error ? err.message : String(err) },
      "wallet-intel analyze failed"
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
