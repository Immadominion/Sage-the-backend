/**
 * LlmTrader — Multi-tenant Claude trading engine for Aura backend.
 *
 * Adapted from lp-bot/src/engine/claude-trader.ts for the multi-tenant
 * backend context. Key differences from the standalone version:
 *  - Pino structured logging (no console.log)
 *  - API key stored encrypted in DB, decrypted in-memory only
 *  - Daily spend tracked per bot instance (not singleton)
 *  - Emits budget_blocked events instead of crashing
 *  - ESM imports with .js extensions
 *
 * Cost: ~$1/MTok input, ~$5/MTok output (Haiku 4.5)
 * With prompt caching: system prompt cached at 0.1× after first call.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MeteoraPairData, MarketScore } from "./types.js";
import { StrategyType } from "./types.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "llm-trader" });

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmDecision {
  enter: boolean;
  poolAddress: string;
  poolName: string;
  strategy: "Spot" | "Curve" | "BidAsk";
  binHalfWidth: number;
  /** 0–1 */
  confidence: number;
  reasoning: string;
  riskAssessment: string;
  estimatedHoldMinutes: number;
}

export type LlmBatchStatus =
  | "success"
  | "parse_recovered"
  | "parse_failed"
  | "api_error"
  | "budget_blocked";

export interface LlmBatchDecision {
  decisions: LlmDecision[];
  marketSummary: string;
  tokensUsed: { input: number; output: number };
  costUSD: number;
  latencyMs: number;
  status: LlmBatchStatus;
  statusMessage: string;
}

/** Convert LlmDecision strategy string to StrategyType enum */
export function llmStrategyToType(s: "Spot" | "Curve" | "BidAsk"): StrategyType {
  switch (s) {
    case "Curve":
      return StrategyType.Curve;
    case "BidAsk":
      return StrategyType.BidAsk;
    default:
      return StrategyType.Spot;
  }
}

/** Convert LlmBatchDecision entries into MarketScore objects the engine can consume */
export function llmDecisionToScore(d: LlmDecision): MarketScore & {
  llmStrategy?: string;
  llmBinHalfWidth?: number;
  maxHoldTimeMinutesOverride?: number;
} {
  return {
    poolAddress: d.poolAddress,
    poolName: d.poolName,
    timestamp: Date.now(),
    // Confidence maps to totalScore on 0-1000 scale so existing threshold comparisons work
    totalScore: d.confidence * 1000,
    volumeScore: 0,
    liquidityScore: 0,
    feeScore: 0,
    momentumScore: 0,
    meetsThreshold: d.enter,
    recommendation: d.enter ? "ENTER" : "SKIP",
    // LLM-specific hints consumed by trading-engine.ts enterPosition()
    llmStrategy: d.strategy,
    llmBinHalfWidth: d.binHalfWidth,
    maxHoldTimeMinutesOverride: d.estimatedHoldMinutes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt (cached across calls)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Meteora DLMM liquidity provider on Solana. You analyze pool data and decide which pools to LP into.

## DLMM Mechanics
- Liquidity is organized into discrete price bins. Each bin has a fixed price.
- Only the active bin (containing both tokens) earns trading fees.
- Swaps within a single bin have zero slippage.
- Dynamic fees increase during volatility, earning LPs more.
- Total fee = base_fee + variable_fee (volatility-dependent).

## Strategies
- **Spot**: Uniform distribution across bins. Versatile, lower IL risk, good for any market.
- **Curve**: Concentrated around active bin. Max capital efficiency but higher IL risk. Best for stable/ranging markets.
- **BidAsk**: Inverse curve (capital at edges). Captures volatility swings. Needs frequent rebalancing.

## Key LP Metrics
- **Volume/Liquidity ratio**: Higher = more fee income per unit of capital. Target >0.5 for 1h window.
- **Fee efficiency**: fees_1h / liquidity. Shows actual fee generation rate.
- **APR**: Annualized return. >100% is good, >500% is exceptional but may be unsustainable.
- **Bin step**: Price increment between bins. Smaller = more volume captured but tighter range.

## Risk Factors
- **Impermanent Loss (IL)**: Price moves away from entry, leaving you with the less valuable token.
- **Low liquidity**: Hard to exit, potential for large IL.
- **Volume decay**: High volume now doesn't guarantee future volume. Look for sustained patterns.
- **New pools**: Can have explosive volume but also rug risk. Check if tokens are verified.
- **One-sided depletion**: If price moves past your range, you earn zero fees.

## Decision Framework
1. Look for pools with high recent volume relative to liquidity (fee income opportunity)
2. Prefer verified tokens and SOL pairs (safety)
3. Choose strategy based on volatility outlook:
   - Ranging market → Curve (max efficiency)
   - Trending/volatile → Spot (safety) or BidAsk (capture swings)
4. Set bin width based on expected price movement:
   - Tight (3-8 bins): High fee capture if price stays, high IL risk if it moves
   - Medium (8-15 bins): Balanced
   - Wide (15-30 bins): Low IL risk, lower fee concentration
5. Skip pools with volume/liquidity < 0.1 or declining volume trends

## Output Format
Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;

// ─────────────────────────────────────────────────────────────────────────────
// LlmTrader
// ─────────────────────────────────────────────────────────────────────────────

export class LlmTrader {
  private client: Anthropic;
  private model: string;
  private maxPoolsPerCall: number;
  private readonly minConfidence = 0.6;
  private readonly enableCaching = true;
  private readonly maxTokens = 1024;
  private readonly temperature = 0.3;
  private maxUsdPerDay?: number;

  private spentUsdToday = 0;
  private spendDateISO: string = new Date().toISOString().slice(0, 10);

  private totalCalls = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheHits = 0;
  private totalLatencyMs = 0;

  constructor(opts: {
    apiKey: string;
    model?: string;
    maxPoolsPerCall?: number;
    maxUsdPerDay?: number;
  }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-haiku-4-5-20251001";
    this.maxPoolsPerCall = opts.maxPoolsPerCall ?? 10;
    this.maxUsdPerDay = opts.maxUsdPerDay && opts.maxUsdPerDay > 0
      ? opts.maxUsdPerDay
      : undefined;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async evaluatePools(
    pools: MeteoraPairData[],
    currentPositionPools: string[] = [],
    walletBalanceSOL = 10
  ): Promise<LlmBatchDecision> {
    this.rollDailyBudgetIfNeeded();

    if (this.maxUsdPerDay !== undefined && this.spentUsdToday >= this.maxUsdPerDay) {
      const msg = `LLM budget reached: $${this.spentUsdToday.toFixed(4)} / $${this.maxUsdPerDay.toFixed(2)} today`;
      log.warn({ spentUsdToday: this.spentUsdToday, maxUsdPerDay: this.maxUsdPerDay }, msg);
      return {
        decisions: [],
        marketSummary: msg,
        tokensUsed: { input: 0, output: 0 },
        costUSD: 0,
        latencyMs: 0,
        status: "budget_blocked",
        statusMessage: msg,
      };
    }

    const startMs = Date.now();
    const candidatePools = pools.slice(0, this.maxPoolsPerCall);
    const poolSummaries = candidatePools.map((p) => this.compactPoolData(p));

    const userMessage = JSON.stringify({
      task: "Evaluate these Meteora DLMM pools for LP entry. Return decisions for each pool.",
      walletBalanceSOL,
      currentPositionPools,
      maxNewPositions: Math.max(1, 5 - currentPositionPools.length),
      outputRules: [
        "Return ONLY valid JSON (no markdown code fences).",
        'Use this exact shape: {"decisions":[...]}.',
        "Return exactly one decision per candidate pool.",
        "Each decision must include: poolAddress, enter, strategy, binHalfWidth, confidence, reasoning, riskAssessment, estimatedHoldMinutes.",
        "Keep reasoning short (<= 140 chars).",
        "Keep riskAssessment short (<= 140 chars).",
        "estimatedHoldMinutes must be an integer number of minutes.",
      ],
      candidatePools: poolSummaries,
    });

    try {
      const systemContent: Anthropic.Messages.TextBlockParam = {
        type: "text" as const,
        text: SYSTEM_PROMPT,
        ...(this.enableCaching
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      };

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: [systemContent],
        messages: [{ role: "user", content: userMessage }],
      });

      const latencyMs = Date.now() - startMs;
      const usage = response.usage;
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      const cacheHits = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;

      this.totalCalls++;
      this.totalInputTokens += inputTokens;
      this.totalOutputTokens += outputTokens;
      this.totalCacheHits += cacheHits;
      this.totalLatencyMs += latencyMs;

      const isHaiku = this.model.toLowerCase().includes("haiku");
      const inputPerMTok = isHaiku ? 1.0 : 3.0;
      const outputPerMTok = isHaiku ? 5.0 : 15.0;
      const inputCost = (inputTokens / 1_000_000) * inputPerMTok;
      const outputCost = (outputTokens / 1_000_000) * outputPerMTok;
      const cacheSavings = (cacheHits / 1_000_000) * (inputPerMTok * 0.9);
      const costUSD = inputCost + outputCost - cacheSavings;
      this.spentUsdToday += Math.max(0, costUSD);

      const textBlock = response.content.find((b) => b.type === "text");
      const rawText = textBlock
        ? (textBlock as Anthropic.Messages.TextBlock).text
        : "{}";

      let decisions: LlmDecision[] = [];
      let marketSummary = "";
      let status: LlmBatchStatus = "success";
      let statusMessage = "";

      try {
        const jsonText = this.extractJsonPayload(rawText);
        const parsed = JSON.parse(jsonText) as { decisions?: unknown[]; marketSummary?: string; market_summary?: string };
        const rawDecisions = Array.isArray(parsed)
          ? parsed
          : (parsed.decisions ?? []);
        marketSummary =
          typeof parsed.marketSummary === "string"
            ? parsed.marketSummary
            : typeof parsed.market_summary === "string"
              ? parsed.market_summary
              : "";

        decisions = (rawDecisions as unknown[])
          .filter(
            (d): d is Record<string, unknown> =>
              d != null &&
              typeof d === "object" &&
              (typeof (d as Record<string, unknown>).enter === "boolean" ||
                typeof (d as Record<string, unknown>).action === "string" ||
                typeof (d as Record<string, unknown>).decision === "string")
          )
          .map((d) => this.normalizeDecision(d))
          .filter((d) => (d.enter ? d.confidence >= this.minConfidence : true));

        statusMessage = `Parsed ${decisions.length} decision(s)`;
        log.debug({ calls: this.totalCalls, costUSD, decisions: decisions.length }, "LLM batch evaluated");
      } catch {
        decisions = this.extractDecisionsFromMalformedJson(rawText).filter(
          (d) => (d.enter ? d.confidence >= this.minConfidence : true)
        );

        if (decisions.length === 0) {
          status = "parse_failed";
          statusMessage = "LLM returned non-parseable output";
          log.error({ rawText: rawText.slice(0, 400) }, "Failed to parse LLM response");
        } else {
          status = "parse_recovered";
          statusMessage = `Recovered ${decisions.length} decision(s) from malformed JSON`;
          log.warn({ count: decisions.length }, "Recovered decisions from malformed LLM JSON");
        }
      }

      return {
        decisions,
        marketSummary,
        tokensUsed: { input: inputTokens, output: outputTokens },
        costUSD,
        latencyMs,
        status,
        statusMessage,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      log.error({ err: errorMessage }, "LLM API call failed");
      return {
        decisions: [],
        marketSummary: `Error: ${errorMessage}`,
        tokensUsed: { input: 0, output: 0 },
        costUSD: 0,
        latencyMs: Date.now() - startMs,
        status: "api_error",
        statusMessage: errorMessage,
      };
    }
  }

  getStats() {
    this.rollDailyBudgetIfNeeded();
    const avgLatency =
      this.totalCalls > 0 ? this.totalLatencyMs / this.totalCalls : 0;
    const isHaiku = this.model.toLowerCase().includes("haiku");
    const inputPerMTok = isHaiku ? 1.0 : 3.0;
    const outputPerMTok = isHaiku ? 5.0 : 15.0;
    const totalCostUSD =
      (this.totalInputTokens / 1_000_000) * inputPerMTok +
      (this.totalOutputTokens / 1_000_000) * outputPerMTok;

    return {
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheHits: this.totalCacheHits,
      totalCostUSD: +totalCostUSD.toFixed(4),
      spentUsdToday: +this.spentUsdToday.toFixed(4),
      maxUsdPerDay: this.maxUsdPerDay != null ? +this.maxUsdPerDay.toFixed(2) : null,
      budgetRemainingUsd:
        this.maxUsdPerDay != null
          ? +Math.max(0, this.maxUsdPerDay - this.spentUsdToday).toFixed(4)
          : null,
      avgLatencyMs: +avgLatency.toFixed(0),
      model: this.model,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private compactPoolData(pool: MeteoraPairData): Record<string, unknown> {
    const liquidity = parseFloat(pool.liquidity) || 0;
    const vol1h = pool.volume?.hour_1 ?? 0;
    const vol24h = pool.trade_volume_24h ?? 0;
    const fees1h = pool.fees?.hour_1 ?? 0;
    const fees24h = pool.fees_24h ?? 0;

    return {
      address: pool.address,
      name: pool.name,
      binStep: pool.bin_step,
      price: pool.current_price,
      liquidity: +liquidity.toFixed(2),
      volume: {
        "1h": +vol1h.toFixed(2),
        "4h": +(pool.volume?.hour_4 ?? 0).toFixed(2),
        "24h": +vol24h.toFixed(2),
      },
      fees: {
        "1h": +fees1h.toFixed(4),
        "24h": +fees24h.toFixed(4),
      },
      apr: +(pool.apr ?? 0).toFixed(1),
      volToLiq1h: liquidity > 0 ? +(vol1h / liquidity).toFixed(3) : 0,
      feeEfficiency1h: liquidity > 0 ? +(fees1h / liquidity).toFixed(6) : 0,
      verified: pool.is_verified ?? false,
    };
  }

  private normalizeDecision(d: Record<string, unknown>): LlmDecision {
    return {
      enter:
        typeof d.enter === "boolean"
          ? d.enter
          : this.normalizeEnterValue(d.action ?? d.decision),
      poolAddress:
        (d.poolAddress as string) ||
        (d.pool_address as string) ||
        (d.address as string) ||
        "",
      poolName: (d.poolName as string) || (d.pool_name as string) || "",
      strategy: this.normalizeStrategy(d.strategy as string),
      binHalfWidth: Math.max(
        3,
        Math.min(40, Number(d.binHalfWidth ?? d.bin_half_width ?? 10))
      ),
      confidence: Math.max(0, Math.min(1, Number(d.confidence ?? 0))),
      reasoning: (d.reasoning as string) || "",
      riskAssessment:
        (d.riskAssessment as string) || (d.risk_assessment as string) || "",
      estimatedHoldMinutes: this.normalizeHoldMinutes(
        d.estimatedHoldMinutes ?? d.estimated_hold_minutes
      ),
    };
  }

  private normalizeStrategy(s: string): "Spot" | "Curve" | "BidAsk" {
    if (!s) return "Spot";
    const lower = s.toLowerCase();
    if (lower.includes("curve")) return "Curve";
    if (lower.includes("bid") || lower.includes("ask")) return "BidAsk";
    return "Spot";
  }

  private normalizeEnterValue(value: unknown): boolean {
    const v = String(value ?? "").trim().toLowerCase();
    return v === "enter" || v === "open" || v === "buy" || v === "true";
  }

  private normalizeHoldMinutes(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(15, Math.min(24 * 60, Math.round(n))) : 120;
  }

  private extractJsonPayload(raw: string): string {
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

    const firstObj = candidate.indexOf("{");
    const lastObj = candidate.lastIndexOf("}");
    const firstArr = candidate.indexOf("[");
    const lastArr = candidate.lastIndexOf("]");

    if (firstObj !== -1 && lastObj > firstObj) {
      return candidate.slice(firstObj, lastObj + 1);
    }
    if (firstArr !== -1 && lastArr > firstArr) {
      return candidate.slice(firstArr, lastArr + 1);
    }
    return candidate;
  }

  private extractDecisionsFromMalformedJson(raw: string): LlmDecision[] {
    const candidate = this.extractJsonPayload(raw);
    const matches =
      candidate.match(
        /\{[^{}]*(?:"poolAddress"|"pool_address"|"address")[^{}]*\}/gms
      ) ?? [];

    return matches.flatMap((fragment) => {
      try {
        const parsed = JSON.parse(fragment) as Record<string, unknown>;
        return [this.normalizeDecision(parsed)];
      } catch {
        return [];
      }
    });
  }

  private rollDailyBudgetIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.spendDateISO) {
      this.spendDateISO = today;
      this.spentUsdToday = 0;
    }
  }
}
