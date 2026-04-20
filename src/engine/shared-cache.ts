/**
 * SharedAPICache — Singleton cache for Meteora API calls.
 *
 * Adapted from lp-bot/src/providers/shared-cache.ts for ESM.
 * Shared across ALL bot instances to prevent 429 rate limiting.
 */

import type { MeteoraPairData, BinLiquidity } from "./types.js";
import config from "../config.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "shared-cache" });

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  fetchPromise?: Promise<T>;
}

interface DlmmTimeWindowData {
  "30m"?: number;
  "1h"?: number;
  "2h"?: number;
  "4h"?: number;
  "12h"?: number;
  "24h"?: number;
}

interface DlmmPoolConfig {
  bin_step?: number;
  base_fee_pct?: number;
  max_fee_pct?: number;
  protocol_fee_pct?: number;
}

interface DlmmTokenMetrics {
  address?: string;
  is_verified?: boolean;
}

interface DlmmPoolRecord {
  address: string;
  name: string;
  token_x?: DlmmTokenMetrics;
  token_y?: DlmmTokenMetrics;
  reserve_x?: string;
  reserve_y?: string;
  token_x_amount?: number;
  token_y_amount?: number;
  reward_mint_x?: string;
  reward_mint_y?: string;
  pool_config?: DlmmPoolConfig;
  dynamic_fee_pct?: number;
  tvl?: number;
  current_price?: number;
  apr?: number;
  apy?: number;
  farm_apr?: number;
  farm_apy?: number;
  volume?: DlmmTimeWindowData;
  fees?: DlmmTimeWindowData;
  cumulative_metrics?: {
    volume?: number;
    fees?: number;
  };
  is_blacklisted?: boolean;
}

interface DlmmPoolsResponse {
  data: DlmmPoolRecord[];
}

class SharedAPICache {
  private static instance: SharedAPICache;

  private allPoolsCache: CacheEntry<MeteoraPairData[]> | null = null;
  private poolCache: Map<string, CacheEntry<MeteoraPairData>> = new Map();
  private activeBinCache: Map<string, CacheEntry<BinLiquidity>> = new Map();

  // TTLs
  private readonly ALL_POOLS_TTL_MS = 15_000;
  private readonly POOL_DATA_TTL_MS = 10_000;
  private readonly ACTIVE_BIN_TTL_MS = 5_000;

  // Rate limiting
  private lastApiCall = 0;
  private readonly MIN_API_INTERVAL_MS = 500;

  // Stats
  private stats = { apiCalls: 0, cacheHits: 0, cacheMisses: 0 };

  private constructor() {
    log.info("Shared API Cache initialized");
  }

  static getInstance(): SharedAPICache {
    if (!SharedAPICache.instance) {
      SharedAPICache.instance = new SharedAPICache();
    }
    return SharedAPICache.instance;
  }

  // ── Rate-limited fetch with retry ──

  private async rateLimitedFetch(
    url: string,
    retries = 2
  ): Promise<Response> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;

    if (timeSinceLastCall < this.MIN_API_INTERVAL_MS) {
      await sleep(this.MIN_API_INTERVAL_MS - timeSinceLastCall);
    }

    this.lastApiCall = Date.now();
    this.stats.apiCalls++;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": "aura-backend/0.3",
          },
        });
        clearTimeout(timeout);
        return response;
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        if (attempt < retries) {
          await sleep((attempt + 1) * 1000);
        }
      }
    }
    throw lastError!;
  }

  // ── All pools ──

  async getAllPools(): Promise<MeteoraPairData[]> {
    const now = Date.now();

    if (
      this.allPoolsCache &&
      now - this.allPoolsCache.timestamp < this.ALL_POOLS_TTL_MS
    ) {
      this.stats.cacheHits++;
      return this.allPoolsCache.data;
    }

    if (this.allPoolsCache?.fetchPromise) {
      return this.allPoolsCache.fetchPromise;
    }

    this.stats.cacheMisses++;

    const fetchPromise = this.fetchAllPoolsInternal();

    if (this.allPoolsCache) {
      this.allPoolsCache.fetchPromise = fetchPromise;
    } else {
      this.allPoolsCache = { data: [], timestamp: 0, fetchPromise };
    }

    try {
      const pools = await fetchPromise;
      this.allPoolsCache = { data: pools, timestamp: Date.now() };

      for (const pool of pools) {
        this.poolCache.set(pool.address, {
          data: pool,
          timestamp: Date.now(),
        });
      }

      return pools;
    } catch (error) {
      if (this.allPoolsCache) {
        this.allPoolsCache.fetchPromise = undefined;
      }
      if (this.allPoolsCache && this.allPoolsCache.data.length > 0) {
        log.warn(
          {
            age: Math.round(
              (Date.now() - this.allPoolsCache.timestamp) / 1000
            ),
            count: this.allPoolsCache.data.length,
          },
          "API fetch failed, using stale cache"
        );
        return this.allPoolsCache.data;
      }
      throw error;
    }
  }

  private async fetchAllPoolsInternal(): Promise<MeteoraPairData[]> {
    const url = `${config.METEORA_API_URL}/pools?page=1&page_size=1000&sort_by=volume_24h:desc&filter_by=is_blacklisted=false`;
    const response = await this.rateLimitedFetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const payload = (await response.json()) as DlmmPoolsResponse;
    return (payload.data ?? []).map((pool) => this.normalizePool(pool));
  }

  // ── Single pool ──

  async getPoolData(poolAddress: string): Promise<MeteoraPairData | null> {
    const now = Date.now();
    const cached = this.poolCache.get(poolAddress);

    if (cached && now - cached.timestamp < this.POOL_DATA_TTL_MS) {
      this.stats.cacheHits++;
      return cached.data;
    }

    this.stats.cacheMisses++;

    try {
      const url = `${config.METEORA_API_URL}/pools/${poolAddress}`;
      const response = await this.rateLimitedFetch(url);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`HTTP ${response.status}`);
      }

      const pool = this.normalizePool((await response.json()) as DlmmPoolRecord);
      this.poolCache.set(poolAddress, { data: pool, timestamp: Date.now() });
      return pool;
    } catch (error) {
      if (cached) {
        log.warn({ poolAddress }, "Using stale cache due to error");
        return cached.data;
      }
      throw error;
    }
  }

  private normalizePool(pool: DlmmPoolRecord): MeteoraPairData {
    const volume = this.normalizeTimeWindow(pool.volume);
    const fees = this.normalizeTimeWindow(pool.fees);
    const poolConfig = pool.pool_config ?? {};

    return {
      address: pool.address,
      name: pool.name,
      mint_x: pool.token_x?.address ?? "",
      mint_y: pool.token_y?.address ?? "",
      reserve_x: pool.reserve_x ?? "",
      reserve_y: pool.reserve_y ?? "",
      reserve_x_amount: pool.token_x_amount ?? 0,
      reserve_y_amount: pool.token_y_amount ?? 0,
      bin_step: poolConfig.bin_step ?? 1,
      base_fee_percentage: String(poolConfig.base_fee_pct ?? 0),
      max_fee_percentage: String(poolConfig.max_fee_pct ?? 0),
      protocol_fee_percentage: String(poolConfig.protocol_fee_pct ?? 0),
      liquidity: String(pool.tvl ?? 0),
      reward_mint_x: pool.reward_mint_x ?? "11111111111111111111111111111111",
      reward_mint_y: pool.reward_mint_y ?? "11111111111111111111111111111111",
      fees_24h: fees.hour_24,
      today_fees: fees.hour_24,
      trade_volume_24h: volume.hour_24,
      cumulative_trade_volume: String(pool.cumulative_metrics?.volume ?? 0),
      cumulative_fee_volume: String(pool.cumulative_metrics?.fees ?? 0),
      current_price: pool.current_price ?? 0,
      apr: pool.apr ?? 0,
      apy: pool.apy ?? 0,
      farm_apr: pool.farm_apr ?? 0,
      farm_apy: pool.farm_apy ?? 0,
      hide: false,
      is_blacklisted: pool.is_blacklisted ?? false,
      fees,
      volume,
      is_verified: Boolean(pool.token_x?.is_verified && pool.token_y?.is_verified),
    };
  }

  private normalizeTimeWindow(data?: DlmmTimeWindowData) {
    return {
      min_30: data?.["30m"] ?? 0,
      hour_1: data?.["1h"] ?? 0,
      hour_2: data?.["2h"] ?? 0,
      hour_4: data?.["4h"] ?? 0,
      hour_12: data?.["12h"] ?? 0,
      hour_24: data?.["24h"] ?? 0,
    };
  }

  // ── Active bin cache ──

  cacheActiveBin(poolAddress: string, activeBin: BinLiquidity): void {
    this.activeBinCache.set(poolAddress, {
      data: activeBin,
      timestamp: Date.now(),
    });
  }

  getCachedActiveBin(poolAddress: string): BinLiquidity | null {
    const cached = this.activeBinCache.get(poolAddress);
    if (cached && Date.now() - cached.timestamp < this.ACTIVE_BIN_TTL_MS) {
      this.stats.cacheHits++;
      return cached.data;
    }
    return null;
  }

  // ── Stats ──

  getStats() {
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate =
      total > 0
        ? ((this.stats.cacheHits / total) * 100).toFixed(1) + "%"
        : "N/A";
    return { ...this.stats, hitRate };
  }

  clearAll(): void {
    this.allPoolsCache = null;
    this.poolCache.clear();
    this.activeBinCache.clear();
    this.stats = { apiCalls: 0, cacheHits: 0, cacheMisses: 0 };
  }

  /** Reset singleton (for testing) */
  static reset(): void {
    if (SharedAPICache.instance) {
      SharedAPICache.instance.clearAll();
      SharedAPICache.instance = null as unknown as SharedAPICache;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getSharedCache = () => SharedAPICache.getInstance();
export default SharedAPICache;
