/**
 * Jupiter Developer Platform client.
 *
 * Powers the Smart Wallet feature:
 *   - Token API  /tokens/v2/search   → metadata + USD price (one call per ≤100 mints)
 *   - Swap V2   /swap/v2/order      → quote + assembled v0 transaction
 *   - Swap V2   /swap/v2/execute    → broadcast + landing handled by Jupiter
 *
 * Why this exists:
 *   When a Meteora DLMM position closes, fees and the residual side of the
 *   bin range are returned as the pool's quote token (e.g. USDC) — NOT SOL.
 *   The previous /wallet/withdraw endpoint only swept SOL, leaving stranded
 *   token dust the user could see on Solscan but not access in-app. The
 *   Jupiter integration here lets us:
 *     1. Show users what they actually own (every SPL token + USD value).
 *     2. Sweep all non-SOL tokens to SOL in one flow before withdrawing.
 *
 * Auth: x-api-key header. Lowercase. Not Authorization: Bearer.
 * Base: https://api.jup.ag (NOT lite-api).
 */

import {
  Keypair,
  VersionedTransaction,
  Connection,
} from "@solana/web3.js";
import config from "../config.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ component: "jupiter" });

const JUPITER_BASE = "https://api.jup.ag";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Token metadata + price returned by /tokens/v2/search. */
export interface JupiterTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  decimals: number;
  isVerified: boolean;
  organicScoreLabel: "high" | "medium" | "low" | null;
  usdPrice: number | null;
  liquidity: number | null;
}

/** Order response from /swap/v2/order. */
interface JupiterOrderResponse {
  transaction: string;
  requestId: string;
  outAmount: string;
  router: string;
  mode: "ultra" | "manual";
}

/** Execute response from /swap/v2/execute. */
interface JupiterExecuteResponse {
  status: "Success" | "Failed";
  signature: string;
  code: number;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
}

/** Lightweight swap result returned by `swapToSOL`. */
export interface SwapResult {
  signature: string;
  inputMint: string;
  inputAmount: string;
  outputAmount: string;
  outputSOL: number;
  router: string;
}

function authHeaders(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["x-api-key"] = key;
  return headers;
}

function isJupiterConfigured(): boolean {
  return Boolean(process.env.JUPITER_API_KEY);
}

/**
 * Look up metadata + USD price for up to 100 mints in a single call.
 * Mints not found by Jupiter (low liquidity / not indexed) are simply
 * omitted from the response — caller must handle missing entries.
 *
 * @returns Map keyed by mint → token info. Empty if no API key.
 */
export async function getTokenInfos(
  mints: string[]
): Promise<Map<string, JupiterTokenInfo>> {
  const out = new Map<string, JupiterTokenInfo>();
  if (mints.length === 0) return out;

  // Token API /search caps at 100 mints per call.
  const batches: string[][] = [];
  for (let i = 0; i < mints.length; i += 100) {
    batches.push(mints.slice(i, i + 100));
  }

  await Promise.all(
    batches.map(async (batch) => {
      try {
        const url =
          `${JUPITER_BASE}/tokens/v2/search?query=` +
          encodeURIComponent(batch.join(","));
        const resp = await fetch(url, { headers: authHeaders() });
        if (!resp.ok) {
          log.warn(
            { status: resp.status, count: batch.length },
            "jupiter token search failed"
          );
          return;
        }
        const data = (await resp.json()) as any[];
        for (const t of data) {
          if (!t?.id) continue;
          out.set(t.id, {
            mint: t.id,
            symbol: t.symbol ?? "",
            name: t.name ?? "",
            icon: t.icon ?? null,
            decimals: t.decimals ?? 0,
            isVerified: t.isVerified === true,
            organicScoreLabel: t.organicScoreLabel ?? null,
            usdPrice: typeof t.usdPrice === "number" ? t.usdPrice : null,
            liquidity: typeof t.liquidity === "number" ? t.liquidity : null,
          });
        }
      } catch (e: any) {
        log.warn({ err: e?.message }, "jupiter token search threw");
      }
    })
  );

  return out;
}

/**
 * Fetch a swap order (quote + assembled v0 tx) for a single hop.
 *
 * @param inputMint  Mint we're paying with
 * @param outputMint Mint we want to receive
 * @param amount     Input amount in smallest unit (string to avoid bigint loss)
 * @param taker      Wallet that will sign + own the output
 * @param slippageBps Optional slippage cap. If omitted, Jupiter applies RTSE.
 */
async function getSwapOrder(
  inputMint: string,
  outputMint: string,
  amount: string,
  taker: string,
  slippageBps?: number
): Promise<JupiterOrderResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    taker,
  });
  if (slippageBps != null) params.set("slippageBps", String(slippageBps));

  const resp = await fetch(`${JUPITER_BASE}/swap/v2/order?${params}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`jupiter /order ${resp.status}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as JupiterOrderResponse;
}

/**
 * Submit a signed transaction back to Jupiter for landing.
 *
 * Returns the on-chain signature on success. Throws with the Jupiter
 * `code` and `error` fields on failure so callers can react.
 */
async function executeSwap(
  signedTransaction: string,
  requestId: string
): Promise<JupiterExecuteResponse> {
  const resp = await fetch(`${JUPITER_BASE}/swap/v2/execute`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ signedTransaction, requestId }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`jupiter /execute ${resp.status}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as JupiterExecuteResponse;
}

/**
 * Swap an entire token balance to SOL using the bot's keypair.
 *
 * Flow:
 *   1. /order with inputMint=token, outputMint=SOL, amount=full balance
 *   2. Deserialize v0 tx, sign with bot keypair, base64 re-serialize
 *   3. /execute (Jupiter handles landing + retries)
 *
 * Why /order+/execute instead of /build:
 *   - Best price across all routers (Metis, JupiterZ RFQ, Dflow, OKX)
 *   - Auto-gasless when wallet has < 0.01 SOL (saves us from rent edge cases)
 *   - Jupiter does the polling/retries — fewer moving parts on our side
 *
 * @param signer        Bot keypair (decrypted by caller, zeroized after).
 * @param inputMint     SPL token mint to swap from.
 * @param amountRaw     Full balance in smallest unit, as a string.
 * @param slippageBps   Optional override; defaults to Jupiter RTSE.
 */
export async function swapToSOL(
  _connection: Connection,
  signer: Keypair,
  inputMint: string,
  amountRaw: string,
  slippageBps?: number
): Promise<SwapResult> {
  if (!isJupiterConfigured()) {
    throw new Error(
      "JUPITER_API_KEY not configured — cannot swap. Set it on the Railway service."
    );
  }
  if (inputMint === SOL_MINT) {
    throw new Error("swapToSOL called with SOL as input — that's a no-op.");
  }

  const taker = signer.publicKey.toBase58();
  const order = await getSwapOrder(inputMint, SOL_MINT, amountRaw, taker, slippageBps);

  // Decode + sign the assembled tx. For RFQ routes Jupiter adds an extra
  // MM signature server-side during /execute, so we leave room for it
  // (v0 tx partial sign — `tx.sign([signer])` does NOT require all sigs
  // to be present at serialize time).
  const tx = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64")
  );
  tx.sign([signer]);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

  const result = await executeSwap(signedTransaction, order.requestId);
  if (result.status !== "Success") {
    throw new Error(
      `jupiter swap failed (code=${result.code}): ${result.error ?? "unknown"}`
    );
  }

  const outputAmount = result.outputAmountResult ?? order.outAmount;
  return {
    signature: result.signature,
    inputMint,
    inputAmount: amountRaw,
    outputAmount,
    outputSOL: Number(outputAmount) / 1_000_000_000,
    router: order.router,
  };
}

/** Cheap config probe so routes can return a friendly 503 instead of crashing. */
export function jupiterEnabled(): boolean {
  return isJupiterConfigured();
}

// Reference unused import to satisfy strict TS settings if any.
void config;
