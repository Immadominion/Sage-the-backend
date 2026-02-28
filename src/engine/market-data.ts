/**
 * MarketDataProvider — Fetches real data from Meteora API and on-chain.
 *
 * Adapted from lp-bot/src/providers/market-data.ts for ESM.
 * Uses SharedAPICache to prevent rate limiting across bot instances.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import BN from "bn.js";
import type {
  IMarketDataProvider,
  MeteoraPairData,
  MarketScore,
  BinLiquidity,
  BotConfig,
} from "./types.js";
import { SOL_MINT } from "./types.js";
import { getSharedCache } from "./shared-cache.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "market-data" });

// CJS interop: DLMM (and its anchor dep) has CJS-ESM issues on Node v24.
// Load via require() to use the CJS path cleanly.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DLMM: any = _require("@meteora-ag/dlmm").default ?? _require("@meteora-ag/dlmm");

export class MarketDataProvider implements IMarketDataProvider {
  private connection: Connection;
  private config: BotConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dlmmCache: Map<string, { dlmm: any; timestamp: number }> =
    new Map();
  private readonly DLMM_CACHE_TTL_MS = 60_000;

  constructor(connection: Connection, config: BotConfig) {
    this.connection = connection;
    this.config = config;
    log.info("Market data provider initialized");
  }

  async fetchAllPools(): Promise<MeteoraPairData[]> {
    try {
      const pools = await getSharedCache().getAllPools();
      log.debug({ count: pools.length }, "Got pools from shared cache");
      return pools;
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Failed to fetch pools from Meteora API"
      );
      throw error;
    }
  }

  async getPoolData(poolAddress: string): Promise<MeteoraPairData | null> {
    try {
      return await getSharedCache().getPoolData(poolAddress);
    } catch (error) {
      log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          poolAddress,
        },
        "Failed to fetch pool data"
      );
      return null;
    }
  }

  /**
   * Get active bin from on-chain data using DLMM SDK.
   * Uses shared cache for recent reads.
   * Falls back to synthetic data from API when on-chain fetch fails
   * (e.g., simulation mode on devnet with mainnet pool addresses).
   */
  async getActiveBin(poolAddress: string): Promise<BinLiquidity> {
    const cached = getSharedCache().getCachedActiveBin(poolAddress);
    if (cached) return cached;

    try {
      const dlmm = await this.getDLMM(poolAddress);
      const activeBin = await dlmm.getActiveBin();
      getSharedCache().cacheActiveBin(poolAddress, activeBin);
      return activeBin;
    } catch (error) {
      // Fallback: derive synthetic active bin from API data
      // This enables simulation mode when on-chain data is unavailable
      const poolData = await this.getPoolData(poolAddress);
      if (!poolData) {
        throw new Error(`Pool ${poolAddress} not found in API or on-chain`);
      }

      const price = poolData.current_price || 1;
      const binStep = poolData.bin_step || 1;

      // Derive bin ID from price: binId = log(price) / log(1 + binStep/10000)
      const binId = Math.round(
        Math.log(price) / Math.log(1 + binStep / 10_000)
      );

      const syntheticBin: BinLiquidity = {
        binId: isFinite(binId) ? binId : 0,
        xAmount: new BN(0),
        yAmount: new BN(0),
        supply: new BN(0),
        version: 0,
        price: price.toString(),
        pricePerToken: price.toString(),
      };

      log.debug(
        {
          poolAddress,
          pool: poolData.name,
          derivedBinId: syntheticBin.binId,
          price,
          binStep,
        },
        "Using synthetic active bin from API data (on-chain unavailable)"
      );

      getSharedCache().cacheActiveBin(poolAddress, syntheticBin);
      return syntheticBin;
    }
  }

  /**
   * Get or create a DLMM instance (cached).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDLMM(poolAddress: string): Promise<any> {
    const cached = this.dlmmCache.get(poolAddress);
    if (cached && Date.now() - cached.timestamp < this.DLMM_CACHE_TTL_MS) {
      return cached.dlmm;
    }

    const poolPubkey = new PublicKey(poolAddress);
    const dlmm = await DLMM.create(this.connection, poolPubkey);
    this.dlmmCache.set(poolAddress, { dlmm, timestamp: Date.now() });
    return dlmm;
  }

  /**
   * Calculate market score for a pool.
   * Mimics FreesolGames' scoring with 150% threshold.
   */
  calculateMarketScore(pool: MeteoraPairData): MarketScore {
    // Volume score (0-100)
    const volumeHour = pool.volume?.hour_1 || 0;
    const volume24h = pool.trade_volume_24h || 0;
    const volumeScore = Math.min(
      100,
      (volumeHour / 100) * 50 + (volume24h / 10_000) * 50
    );

    // Liquidity score — optimal zone for DLMM LP profitability
    // Sweet spot: enough liquidity for real trades but not so much that
    // LP competition dilutes returns. Volume/Liquidity ratio matters more
    // than raw liquidity, but we score liquidity buckets for base signal.
    const liquidity = parseFloat(pool.liquidity) || 0;
    let liquidityScore = 20;
    if (liquidity >= 500 && liquidity < 5_000) liquidityScore = 90;
    else if (liquidity >= 5_000 && liquidity < 25_000) liquidityScore = 80;
    else if (liquidity >= 25_000 && liquidity < 100_000) liquidityScore = 65;
    else if (liquidity >= 100_000 && liquidity < 500_000) liquidityScore = 50;
    else if (liquidity >= 500_000) liquidityScore = 35;
    else if (liquidity >= 100 && liquidity < 500) liquidityScore = 60;

    // Fee/TVL ratio
    const fees24h = pool.fees_24h || 0;
    const feeTvlRatio = liquidity > 0 ? fees24h / liquidity : 0;
    const feeScore = Math.min(100, feeTvlRatio * 1000);

    // Momentum (APR-based) — scale for real-world APR range
    // Most active Meteora DLMM pools have APR 1-100%, exceptional ones 100-500%
    const apr = pool.apr || 0;
    const momentumScore = Math.min(100, (apr / 50) * 100);

    // Weighted total
    const totalRaw =
      volumeScore * 0.35 +
      liquidityScore * 0.2 +
      feeScore * 0.25 +
      momentumScore * 0.2;

    // Scale to match FreesolGames' 150% threshold
    const scaledScore = totalRaw * 2;
    const meetsThreshold = scaledScore >= this.config.entryScoreThreshold;

    return {
      poolAddress: pool.address,
      poolName: pool.name,
      timestamp: Date.now(),
      volumeScore,
      liquidityScore,
      feeScore,
      momentumScore,
      totalScore: scaledScore,
      meetsThreshold,
      recommendation: meetsThreshold
        ? "ENTER"
        : scaledScore > 100
          ? "WAIT"
          : "SKIP",
    };
  }

  /**
   * Filter pools based on config criteria.
   */
  async filterEligiblePools(config: BotConfig): Promise<MeteoraPairData[]> {
    const pools = await this.fetchAllPools();

    return pools.filter((pool) => {
      if (pool.is_blacklisted) return false;

      if (config.solPairsOnly) {
        const isSOLPair =
          pool.mint_x === SOL_MINT || pool.mint_y === SOL_MINT;
        if (!isSOLPair) return false;
      }

      if (config.blacklist.includes(pool.mint_x)) return false;
      if (config.blacklist.includes(pool.mint_y)) return false;

      if (pool.trade_volume_24h < config.minVolume24h) return false;

      const liquidity = parseFloat(pool.liquidity) || 0;
      if (liquidity < config.minLiquidity) return false;
      if (liquidity > config.maxLiquidity) return false;

      return true;
    });
  }
}
