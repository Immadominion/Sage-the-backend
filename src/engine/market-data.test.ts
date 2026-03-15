/**
 * MarketDataProvider.filterEligiblePools unit tests.
 *
 * Tests pool filtering logic — critical for entry signal quality.
 * Mocks fetchAllPools to avoid network calls; exercises real filter logic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Connection } from "@solana/web3.js";
import { MarketDataProvider } from "./market-data.js";
import type { BotConfig, MeteoraPairData } from "./types.js";
import { SOL_MINT } from "./types.js";

// ── Helpers ─────────────────────────────────────────────

/** Minimal valid pool data for testing */
function makePool(overrides: Partial<MeteoraPairData> = {}): MeteoraPairData {
    return {
        address: "Pool111111111111111111111111111111111111111111",
        name: "SOL-USDC",
        mint_x: SOL_MINT,
        mint_y: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        reserve_x: "1000000000",
        reserve_y: "50000000",
        reserve_x_amount: 1_000_000_000,
        reserve_y_amount: 50_000_000,
        bin_step: 10,
        base_fee_percentage: "0.25",
        max_fee_percentage: "2.5",
        protocol_fee_percentage: "5",
        liquidity: "100000",
        reward_mint_x: "",
        reward_mint_y: "",
        fees_24h: 500,
        today_fees: 500,
        trade_volume_24h: 50000,
        cumulative_trade_volume: "10000000",
        cumulative_fee_volume: "25000",
        current_price: 150.5,
        apr: 45.2,
        apy: 56.1,
        farm_apr: 0,
        farm_apy: 0,
        is_blacklisted: false,
        ...overrides,
    } as MeteoraPairData;
}

/** Default BotConfig for filtering tests */
function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
    return {
        mode: "SIMULATION" as const,
        rpcUrl: "https://api.mainnet-beta.solana.com",
        strategyMode: "rule-based" as const,
        entryScoreThreshold: 150,
        minVolume24h: 10000,
        minLiquidity: 1000,
        maxLiquidity: 10_000_000,
        solPairsOnly: true,
        blacklist: [],
        positionSizeSOL: 1,
        maxConcurrentPositions: 5,
        defaultBinRange: 10,
        cooldownMinutes: 79,
        scanIntervalMs: 30000,
        ...overrides,
    } as BotConfig;
}

// ── Tests ───────────────────────────────────────────────

describe("MarketDataProvider.filterEligiblePools", () => {
    let provider: MarketDataProvider;
    let mockPools: MeteoraPairData[];

    beforeEach(() => {
        const connection = new Connection("https://api.mainnet-beta.solana.com");
        provider = new MarketDataProvider(connection, makeConfig());
        mockPools = [];

        // Spy on fetchAllPools to return our test data without network calls
        vi.spyOn(provider, "fetchAllPools").mockImplementation(async () => mockPools);
    });

    // ── Identity validation ───────────────────────────────

    it("excludes pools with missing address", async () => {
        mockPools = [
            makePool({ address: "" }),
            makePool({ address: "ValidAddr", name: "SOL-USDC" }),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(1);
        expect(result[0].address).toBe("ValidAddr");
    });

    it("excludes pools with missing name", async () => {
        mockPools = [
            makePool({ name: "" }),
            makePool({ name: "SOL-RAY" }),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("SOL-RAY");
    });

    it("excludes pools with null address or name", async () => {
        mockPools = [
            makePool({ address: null as unknown as string }),
            makePool({ name: null as unknown as string }),
            makePool(),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(1);
    });

    // ── Blacklist filtering ───────────────────────────────

    it("excludes blacklisted pools", async () => {
        mockPools = [
            makePool({ is_blacklisted: true }),
            makePool({ is_blacklisted: false }),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(1);
        expect(result[0].is_blacklisted).toBe(false);
    });

    it("excludes pools with blacklisted mint_x", async () => {
        const badMint = "BadMint111111111111111111111111111111111111111";
        mockPools = [
            makePool({ mint_x: badMint, mint_y: SOL_MINT }),
            makePool(),
        ];
        const config = makeConfig({ blacklist: [badMint], solPairsOnly: false });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(1);
    });

    it("excludes pools with blacklisted mint_y", async () => {
        const badMint = "BadMint222222222222222222222222222222222222222";
        mockPools = [
            makePool({ mint_y: badMint }),
            makePool(),
        ];
        const config = makeConfig({ blacklist: [badMint] });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(1);
    });

    // ── SOL pair filter ───────────────────────────────────

    it("filters non-SOL pairs when solPairsOnly is true", async () => {
        mockPools = [
            makePool({ mint_x: SOL_MINT, mint_y: "USDC" }), // SOL pair
            makePool({ mint_x: "RAY", mint_y: SOL_MINT }), // SOL pair (reversed)
            makePool({ mint_x: "RAY", mint_y: "USDC" }),   // non-SOL pair
        ];
        const config = makeConfig({ solPairsOnly: true });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(2);
    });

    it("allows non-SOL pairs when solPairsOnly is false", async () => {
        mockPools = [
            makePool({ mint_x: "RAY", mint_y: "USDC" }),
        ];
        const config = makeConfig({ solPairsOnly: false });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(1);
    });

    // ── Volume threshold ──────────────────────────────────

    it("excludes pools below minimum volume", async () => {
        mockPools = [
            makePool({ trade_volume_24h: 5000 }),  // below 10k
            makePool({ trade_volume_24h: 10000 }), // exactly 10k
            makePool({ trade_volume_24h: 50000 }), // above 10k
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(2);
    });

    it("handles undefined trade_volume_24h", async () => {
        mockPools = [
            makePool({ trade_volume_24h: undefined as unknown as number }),
            makePool({ trade_volume_24h: 20000 }),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(1);
    });

    // ── Liquidity range ───────────────────────────────────

    it("excludes pools below minimum liquidity", async () => {
        mockPools = [
            makePool({ liquidity: "500" }),   // below 1000
            makePool({ liquidity: "1000" }),  // exactly 1000
            makePool({ liquidity: "5000" }),  // above 1000
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(2);
    });

    it("excludes pools above maximum liquidity", async () => {
        mockPools = [
            makePool({ liquidity: "100000" }),     // within range
            makePool({ liquidity: "10000000" }),    // exactly max
            makePool({ liquidity: "99999999999" }), // above max
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(2);
    });

    it("handles non-numeric liquidity string", async () => {
        mockPools = [
            makePool({ liquidity: "not-a-number" }),
            makePool({ liquidity: "50000" }),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        // "not-a-number" parses to NaN/0, below minLiquidity
        expect(result).toHaveLength(1);
    });

    // ── Combined filters ──────────────────────────────────

    it("applies all filters together", async () => {
        const badMint = "BlacklistedMint1111111111111111111111111111";
        mockPools = [
            makePool(),                                         // passes all
            makePool({ is_blacklisted: true }),                 // blacklisted
            makePool({ address: "" }),                          // no address
            makePool({ trade_volume_24h: 100 }),                // low volume
            makePool({ liquidity: "500" }),                     // low liquidity
            makePool({ mint_x: "RAY", mint_y: "USDC" }),       // not SOL pair
            makePool({ mint_y: badMint }),                      // blacklisted mint
        ];
        const config = makeConfig({ blacklist: [badMint] });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(1);
    });

    it("returns empty array when no pools match", async () => {
        mockPools = [
            makePool({ trade_volume_24h: 0, liquidity: "0" }),
        ];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(0);
    });

    it("returns empty array when pool list is empty", async () => {
        mockPools = [];
        const result = await provider.filterEligiblePools(makeConfig());
        expect(result).toHaveLength(0);
    });

    // ── Edge cases ────────────────────────────────────────

    it("zero minVolume24h accepts all volumes", async () => {
        mockPools = [
            makePool({ trade_volume_24h: 0 }),
            makePool({ trade_volume_24h: 1 }),
        ];
        const config = makeConfig({ minVolume24h: 0 });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(2);
    });

    it("handles very large liquidity values", async () => {
        mockPools = [
            makePool({ liquidity: "999999999999" }),
        ];
        const config = makeConfig({ maxLiquidity: 1_000_000_000_000 });
        const result = await provider.filterEligiblePools(config);
        expect(result).toHaveLength(1);
    });
});
