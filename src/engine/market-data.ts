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
import { lpAgentService } from "../services/lp-agent.js";

const log = logger.child({ module: "market-data" });

// CJS interop: DLMM (and its anchor dep) has CJS-ESM issues on Node v24.
// Load via require() to use the CJS path cleanly.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DLMM: any = _require("@meteora-ag/dlmm").default ?? _require("@meteora-ag/dlmm");

export class MarketDataProvider implements IMarketDataProvider {
  private static lpAgentCache: {
    pools: MeteoraPairData[];
    updatedAt: number;
  } | null = null;
  private static readonly LP_AGENT_CACHE_TTL_MS = 45_000;

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
    // LP Agent can replace the direct discovery path when configured.
    // Keep Meteora fallback for resiliency and parity during rollout.
    if (lpAgentService.isConfigured) {
      const now = Date.now();
      const cached = MarketDataProvider.lpAgentCache;
      if (cached && now - cached.updatedAt < MarketDataProvider.LP_AGENT_CACHE_TTL_MS) {
        return cached.pools;
      }

      try {
        const raw = await lpAgentService.discoverPools({
          chain: "SOL",
          page: 1,
          pageSize: 50,
          sortBy: "vol_24h",
          sortOrder: "desc",
        }) as {
          data?: Array<Record<string, unknown>>;
        };

        const mapped = (raw.data ?? [])
          .map((row) => this.mapLpAgentPool(row))
          .filter((pool): pool is MeteoraPairData => pool !== null);

        if (mapped.length > 0) {
          MarketDataProvider.lpAgentCache = {
            pools: mapped,
            updatedAt: now,
          };
          log.debug({ count: mapped.length }, "Got pools from LP Agent cache/API");
          return mapped;
        }

        log.warn("LP Agent returned no pool data — falling back to Meteora cache");
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "LP Agent pool discovery failed — falling back to Meteora cache"
        );
      }
    }

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

  private mapLpAgentPool(row: Record<string, unknown>): MeteoraPairData | null {
    const address = String(row.pool ?? "").trim();
    if (!address) return null;

    const token0Symbol = String(row.token0_symbol ?? "TOKEN0");
    const token1Symbol = String(row.token1_symbol ?? "TOKEN1");
    const token0Mint = String(row.token0 ?? "").trim();
    const token1Mint = String(row.token1 ?? "").trim();

    const vol1h = Number(row.vol_1h ?? 0);
    const vol24h = Number(row.vol_24h ?? 0);
    const tvl = Number(row.tvl ?? 0);
    const feePct = Number(row.fee ?? 0);
    const fee24h = vol24h * (feePct / 100);
    const price = Number(row.quote_price ?? row.base_price ?? 0);

    return {
      address,
      name: `${token0Symbol}-${token1Symbol}`,
      mint_x: token0Mint,
      mint_y: token1Mint,
      reserve_x: "0",
      reserve_y: "0",
      reserve_x_amount: 0,
      reserve_y_amount: 0,
      bin_step: Number(row.bin_step ?? 1),
      base_fee_percentage: String(feePct || 0),
      max_fee_percentage: String(feePct || 0),
      protocol_fee_percentage: "0",
      liquidity: String(tvl || 0),
      reward_mint_x: "",
      reward_mint_y: "",
      fees_24h: Number.isFinite(fee24h) ? fee24h : 0,
      today_fees: Number.isFinite(fee24h) ? fee24h : 0,
      trade_volume_24h: Number.isFinite(vol24h) ? vol24h : 0,
      cumulative_trade_volume: "0",
      cumulative_fee_volume: "0",
      current_price: Number.isFinite(price) ? price : 0,
      apr: 0,
      apy: 0,
      farm_apr: 0,
      farm_apy: 0,
      hide: false,
      is_blacklisted: false,
      fees: {
        min_30: 0,
        hour_1: 0,
        hour_2: 0,
        hour_4: 0,
        hour_12: 0,
        hour_24: Number.isFinite(fee24h) ? fee24h : 0,
      },
      volume: {
        min_30: 0,
        hour_1: Number.isFinite(vol1h) ? vol1h : 0,
        hour_2: 0,
        hour_4: 0,
        hour_12: 0,
        hour_24: Number.isFinite(vol24h) ? vol24h : 0,
      },
      is_verified: true,
    };
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
   *
   * Throws a clear error if the pool doesn't exist on-chain.
   * This typically happens when RPC points to devnet but pool addresses
   * come from the mainnet Meteora API.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDLMM(poolAddress: string): Promise<any> {
    const cached = this.dlmmCache.get(poolAddress);
    if (cached && Date.now() - cached.timestamp < this.DLMM_CACHE_TTL_MS) {
      return cached.dlmm;
    }

    const poolPubkey = new PublicKey(poolAddress);

    // Pre-check: verify the account exists on-chain before DLMM.create
    const accountInfo = await this.connection.getAccountInfo(poolPubkey);
    if (!accountInfo) {
      throw new Error(
        `LB Pair account ${poolAddress} not found on-chain. ` +
        `This usually means the RPC is on devnet but the pool exists on mainnet. ` +
        `Check SOLANA_NETWORK and SOLANA_RPC_URL in your .env.`
      );
    }

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
      // Skip pools missing essential identity fields
      if (!pool.address || !pool.name) return false;

      if (pool.is_blacklisted) return false;

      if (config.solPairsOnly) {
        const isSOLPair =
          pool.mint_x === SOL_MINT || pool.mint_y === SOL_MINT;
        if (!isSOLPair) return false;
      }

      // Simulator only handles mint_y=WSOL pools (SOL-USDC has mint_x=SOL,
      // mint_y=USDC and would be rejected at openPosition). Pre-filter here.
      if (config.requireSolQuote && pool.mint_y !== SOL_MINT) return false;

      if (pool.mint_x && config.blacklist.includes(pool.mint_x)) return false;
      if (pool.mint_y && config.blacklist.includes(pool.mint_y)) return false;

      if ((pool.trade_volume_24h ?? 0) < config.minVolume24h) return false;

      const liquidity = parseFloat(pool.liquidity) || 0;
      if (liquidity < config.minLiquidity) return false;
      if (liquidity > config.maxLiquidity) return false;

      return true;
    });
  }
}
