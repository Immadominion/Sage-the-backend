/**
 * Wallet Intelligence client.
 *
 * Server-to-server HTTP client for the Python wallet-intelligence FastAPI
 * service. Analysis is ASYNC: startAnalyze() kicks off a background job and
 * returns a jobId instantly; getAnalyzeResult() polls with short fast requests.
 * This avoids holding a single HTTP connection past the platform's ~60s idle
 * timeout (which previously surfaced as 502s for non-trivial wallets).
 *
 * Configured via WALLET_INTEL_URL (+ WALLET_INTEL_API_KEY). When unset, the
 * /brain routes return 503 — the feature is simply unavailable, nothing breaks.
 */

import config from "../config.js";

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

export interface AnalyzeJob {
  status: "running" | "complete" | "error";
  result: WalletIntelResult | null;
  error: string | null;
}

/** Whether the wallet-intelligence service is configured. */
export function isConfigured(): boolean {
  return Boolean(config.WALLET_INTEL_URL);
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.WALLET_INTEL_API_KEY
      ? { "X-WI-API-Key": config.WALLET_INTEL_API_KEY }
      : {}),
  };
}

function baseUrl(): string {
  const base = config.WALLET_INTEL_URL;
  if (!base) throw new Error("WALLET_INTEL_URL not configured");
  return base.replace(/\/$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Start an analysis job. Returns the jobId (fast — no long-held connection). */
export async function startAnalyze(
  wallet: string,
  windowDays: number,
  maxTxs: number
): Promise<string> {
  const resp = await fetchWithTimeout(
    `${baseUrl()}/analyze`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ wallet, window_days: windowDays, max_txs: maxTxs }),
    },
    20_000
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`wallet-intel start ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { jobId: string };
  return data.jobId;
}

/** Poll a job's status/result (short request). */
export async function getAnalyzeResult(jobId: string): Promise<AnalyzeJob> {
  const resp = await fetchWithTimeout(
    `${baseUrl()}/analyze/${jobId}`,
    { method: "GET", headers: authHeaders() },
    20_000
  );
  if (resp.status === 404) {
    throw new Error("wallet-intel job not found (service may have restarted)");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`wallet-intel poll ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as AnalyzeJob;
}
