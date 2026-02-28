/**
 * MLPredictor — HTTP client for the Python ML prediction service.
 *
 * Sends feature arrays to the FastAPI sidecar and returns predictions.
 * Handles health checks, timeouts, and graceful degradation.
 *
 * ⚠️ FINANCIAL SYSTEM: On failure, returns conservative "skip" — never enters blindly.
 */

import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "ml-predictor" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface MLPrediction {
  poolAddress?: string;
  probability: number;
  recommendation: "enter" | "skip";
  confidence: "high" | "medium" | "low";
}

export interface MLServiceHealth {
  status: string;
  model: string;
  version: string;
  threshold: number;
  featureNames: string[];
  metrics: Record<string, number>;
}

export interface MLPredictorConfig {
  /** Base URL of the ML prediction server */
  baseUrl: string;
  /** Request timeout in ms (default: 5000) */
  timeoutMs: number;
  /** Optimal threshold from model metadata (overrides server-side if set) */
  threshold?: number;
  /** Whether to enable ML predictions (can be toggled at runtime) */
  enabled: boolean;
  /** API key for authenticating with the ML prediction service */
  apiKey?: string;
}

const DEFAULT_CONFIG: MLPredictorConfig = {
  baseUrl: "http://127.0.0.1:8100",
  timeoutMs: 5000,
  enabled: true,
};

// ═══════════════════════════════════════════════════════════════
// MLPredictor
// ═══════════════════════════════════════════════════════════════

export class MLPredictor {
  private config: MLPredictorConfig;
  private healthy = false;
  private lastHealthCheck = 0;
  private readonly HEALTH_CHECK_INTERVAL_MS = 30_000;

  constructor(config?: Partial<MLPredictorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(
      { url: this.config.baseUrl, enabled: this.config.enabled },
      "ML Predictor initialized"
    );
  }

  // ── Health ──

  /**
   * Check if the ML service is healthy and model is loaded.
   * Caches the result for HEALTH_CHECK_INTERVAL_MS.
   */
  async checkHealth(): Promise<MLServiceHealth | null> {
    try {
      const response = await this.fetch("/health", { method: "GET" });

      if (!response.ok) {
        this.healthy = false;
        log.warn(
          { status: response.status },
          "ML service unhealthy"
        );
        return null;
      }

      const data = await response.json() as {
        status: string;
        model: string;
        version: string;
        threshold: number;
        feature_names: string[];
        metrics: Record<string, number>;
      };

      this.healthy = true;
      this.lastHealthCheck = Date.now();

      const health: MLServiceHealth = {
        status: data.status,
        model: data.model,
        version: data.version,
        threshold: data.threshold,
        featureNames: data.feature_names,
        metrics: data.metrics,
      };

      log.info(
        { model: health.model, threshold: health.threshold },
        "ML service healthy"
      );

      return health;
    } catch (error) {
      this.healthy = false;
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "ML service unreachable"
      );
      return null;
    }
  }

  /**
   * Whether the ML service is currently available.
   * Uses cached health check result.
   */
  get isHealthy(): boolean {
    if (Date.now() - this.lastHealthCheck > this.HEALTH_CHECK_INTERVAL_MS) {
      // Stale — trigger async refresh (non-blocking)
      this.checkHealth().catch(() => {});
    }
    return this.healthy;
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── Prediction ──

  /**
   * Get ML prediction for a single pool's features.
   * Returns null on failure (conservative — never enter blindly).
   */
  async predict(
    featureArray: number[],
    poolAddress?: string
  ): Promise<MLPrediction | null> {
    const results = await this.predictBatch(
      [featureArray],
      poolAddress ? [poolAddress] : undefined
    );
    return results?.[0] ?? null;
  }

  /**
   * Get ML predictions for a batch of pools.
   * Returns null on failure — caller should fall back to rule-based.
   */
  async predictBatch(
    featureArrays: number[][],
    poolAddresses?: string[]
  ): Promise<MLPrediction[] | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      const body = JSON.stringify({
        features: featureArrays,
        pool_addresses: poolAddresses,
      });

      const response = await this.fetch("/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        log.error(
          { status: response.status, body: errorText },
          "ML prediction request failed"
        );
        return null;
      }

      const data = await response.json() as {
        predictions: Array<{
          probability: number;
          recommendation: string;
          confidence: string;
          pool_address: string | null;
        }>;
        model: string;
        threshold: number;
      };

      this.healthy = true;
      this.lastHealthCheck = Date.now();

      const threshold = this.config.threshold ?? data.threshold;

      return data.predictions.map((p) => ({
        poolAddress: p.pool_address ?? undefined,
        probability: p.probability,
        recommendation: p.probability >= threshold ? "enter" : "skip",
        confidence: p.confidence as "high" | "medium" | "low",
      }));
    } catch (error) {
      this.healthy = false;
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "ML prediction failed — falling back to rule-based"
      );
      return null;
    }
  }

  // ── Configuration ──

  /**
   * Update threshold at runtime.
   */
  setThreshold(threshold: number): void {
    this.config.threshold = threshold;
    log.info({ threshold }, "ML threshold updated");
  }

  /**
   * Enable or disable ML predictions at runtime.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    log.info({ enabled }, "ML predictor toggled");
  }

  // ── Internals ──

  private async fetch(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    // Merge headers, injecting API key if configured
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> || {}),
    };
    if (this.config.apiKey) {
      headers["X-ML-API-Key"] = this.config.apiKey;
    }

    try {
      return await globalThis.fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
