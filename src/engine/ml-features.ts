/**
 * ML Feature Extraction — Maps MeteoraPairData → V3 feature array.
 *
 * V3 Model uses 12 features in a specific order.
 * This module extracts them from the raw Meteora API data.
 *
 * ⚠️ FINANCIAL SYSTEM: Feature order must match train_model_v3.py EXACTLY.
 */

import type { MeteoraPairData } from "./types.js";

// V3 feature names — order must match Python training script
export const V3_FEATURE_NAMES = [
  "volume_30m",
  "volume_1h",
  "volume_2h",
  "volume_4h",
  "volume_24h",
  "fees_30m",
  "fees_1h",
  "fees_24h",
  "fee_efficiency_1h",
  "liquidity",
  "apr",
  "volume_to_liquidity",
] as const;

export type V3Features = {
  volume_30m: number;
  volume_1h: number;
  volume_2h: number;
  volume_4h: number;
  volume_24h: number;
  fees_30m: number;
  fees_1h: number;
  fees_24h: number;
  fee_efficiency_1h: number;
  liquidity: number;
  apr: number;
  volume_to_liquidity: number;
};

/**
 * Extract the 12 V3 features from a MeteoraPairData object.
 * Returns the features as a named object for readability.
 */
export function extractV3Features(pool: MeteoraPairData): V3Features {
  const liquidity = parseFloat(pool.liquidity) || 0;
  const safeLiquidity = Math.max(liquidity, 1); // Avoid division by zero

  const feesHour1 = pool.fees?.hour_1 ?? 0;
  const volumeHour1 = pool.volume?.hour_1 ?? 0;

  return {
    volume_30m: pool.volume?.min_30 ?? 0,
    volume_1h: volumeHour1,
    volume_2h: pool.volume?.hour_2 ?? 0,
    volume_4h: pool.volume?.hour_4 ?? 0,
    volume_24h: pool.trade_volume_24h ?? pool.volume?.hour_24 ?? 0,
    fees_30m: pool.fees?.min_30 ?? 0,
    fees_1h: feesHour1,
    fees_24h: pool.fees_24h ?? pool.fees?.hour_24 ?? 0,
    fee_efficiency_1h: feesHour1 / safeLiquidity,
    liquidity,
    apr: pool.apr ?? 0,
    volume_to_liquidity: volumeHour1 / safeLiquidity,
  };
}

/**
 * Convert V3Features to a number array in model-expected order.
 * Order MUST match FEATURE_COLUMNS_V3 in train_model_v3.py.
 */
export function featuresToArray(features: V3Features): number[] {
  return [
    features.volume_30m,
    features.volume_1h,
    features.volume_2h,
    features.volume_4h,
    features.volume_24h,
    features.fees_30m,
    features.fees_1h,
    features.fees_24h,
    features.fee_efficiency_1h,
    features.liquidity,
    features.apr,
    features.volume_to_liquidity,
  ];
}

/**
 * Extract features and return as array — convenience function.
 * combines extractV3Features + featuresToArray.
 */
export function extractFeatureArray(pool: MeteoraPairData): number[] {
  return featuresToArray(extractV3Features(pool));
}

/**
 * Batch extract features from multiple pools.
 */
export function extractBatchFeatures(
  pools: MeteoraPairData[]
): { pool: MeteoraPairData; features: V3Features; array: number[] }[] {
  return pools.map((pool) => {
    const features = extractV3Features(pool);
    return { pool, features, array: featuresToArray(features) };
  });
}
