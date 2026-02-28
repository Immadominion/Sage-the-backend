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
        const response = await fetch(url, { signal: controller.signal });
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
    const url = `${config.METEORA_API_URL}/pair/all`;
    const response = await this.rateLimitedFetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<MeteoraPairData[]>;
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
      const url = `${config.METEORA_API_URL}/pair/${poolAddress}`;
      const response = await this.rateLimitedFetch(url);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`HTTP ${response.status}`);
      }

      const pool = (await response.json()) as MeteoraPairData;
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
