/**
 * Live SOL/USD price provider for aura-backend.
 *
 * Mirrors lp-bot/src/providers/sol-price.ts. Source: Jupiter Lite price API.
 * Cached 60s; falls back to env override `SOL_PRICE_USD` then 150.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const CACHE_TTL_MS = 60_000;
const FALLBACK_USD = parseFloat(process.env.SOL_PRICE_USD || "150");

let cached: { priceUsd: number; ts: number } | null = null;
let inflight: Promise<number> | null = null;

async function fetchFromJupiter(): Promise<number> {
  const url = `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
    const body = (await res.json()) as Record<string, { usdPrice?: number }>;
    const px = body[SOL_MINT]?.usdPrice;
    if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) {
      throw new Error("Jupiter returned invalid price");
    }
    return px;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSolPriceUsd(): Promise<number> {
  if (
    process.env.SOL_PRICE_OVERRIDE === "1" &&
    process.env.SOL_PRICE_USD
  ) {
    const override = parseFloat(process.env.SOL_PRICE_USD);
    if (Number.isFinite(override) && override > 0) return override;
  }
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.priceUsd;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const px = await fetchFromJupiter();
      cached = { priceUsd: px, ts: now };
      return px;
    } catch {
      if (cached) return cached.priceUsd;
      return FALLBACK_USD;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getSolPriceUsdSync(): number {
  return cached?.priceUsd ?? FALLBACK_USD;
}
