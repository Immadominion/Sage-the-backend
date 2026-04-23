/**
 * Fee Calculator — pure functions for computing per-trade platform fees.
 *
 * Fee schedule (cheap, transparent, capped):
 *   feeBps = FEE_BPS_BASE + surcharge(strategyMode)
 *   feeLamports = clamp(positionSize * feeBps / 10_000, FEE_MIN, FEE_MAX)
 *
 * Surcharges:
 *   - rule-based: +0 bps
 *   - aura-ai:    +FEE_BPS_AURA_AI_SURCHARGE bps (default 0)
 *   - both:       +FEE_BPS_AURA_AI_SURCHARGE bps
 *   - llm:        +FEE_BPS_LLM_SURCHARGE bps (default 5; covers Claude API)
 *
 * Defaults yield ~$0.045 per 1 SOL trade (rule-based) and ~$0.12 (LLM).
 *
 * If FEE_COLLECTOR_WALLET is unset, fees are disabled — calculateTradeFee
 * returns { feeLamports: 0, feeBps: 0, collectorWallet: null }.
 */

import config from "../config.js";
import type { StrategyMode } from "./types.js";

export interface FeeQuote {
  /** Total bps applied (base + surcharge). 0 if fees disabled. */
  feeBps: number;
  /** Lamports actually charged after min/max clamp. 0 if fees disabled. */
  feeLamports: number;
  /** Fee collector wallet (base58). Null if fees disabled. */
  collectorWallet: string | null;
  /** Whether fee collection is enabled this trade */
  enabled: boolean;
}

/** Resolve the bps surcharge for a strategy mode. */
export function getStrategySurchargeBps(mode: StrategyMode): number {
  switch (mode) {
    case "rule-based":
      return 0;
    case "aura-ai":
    case "both":
      return config.FEE_BPS_AURA_AI_SURCHARGE;
    case "llm":
      return config.FEE_BPS_LLM_SURCHARGE;
    default:
      return 0;
  }
}

/**
 * Compute the platform fee for a trade.
 *
 * @param positionSizeLamports - Total position size (SOL leg) in lamports
 * @param strategyMode - Bot's strategy mode (drives surcharge)
 * @returns A fee quote — pass to fee-collector to actually charge it
 */
export function calculateTradeFee(
  positionSizeLamports: number,
  strategyMode: StrategyMode
): FeeQuote {
  const collector = config.FEE_COLLECTOR_WALLET ?? null;
  if (!collector || positionSizeLamports <= 0) {
    return {
      feeBps: 0,
      feeLamports: 0,
      collectorWallet: null,
      enabled: false,
    };
  }

  const bps = config.FEE_BPS_BASE + getStrategySurchargeBps(strategyMode);
  if (bps <= 0) {
    return {
      feeBps: 0,
      feeLamports: 0,
      collectorWallet: collector,
      enabled: true,
    };
  }

  // Compute raw fee. Use Math.floor to never overcharge by rounding.
  const raw = Math.floor((positionSizeLamports * bps) / 10_000);
  const clamped = Math.max(
    config.FEE_MIN_LAMPORTS,
    Math.min(config.FEE_MAX_LAMPORTS, raw)
  );

  return {
    feeBps: bps,
    feeLamports: clamped,
    collectorWallet: collector,
    enabled: true,
  };
}
