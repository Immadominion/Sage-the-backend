/**
 * MLPredictor — In-process XGBoost inference for LP profitability.
 *
 * Loads the V3 model JSON (exported from Python) at startup and runs tree
 * evaluation directly in Node.js. No Python sidecar, no HTTP, no API keys.
 *
 * The model is ~150KB JSON with 100 trees × ~17 nodes each — trivial memory.
 * Inference for 30 pools takes <1ms (pure arithmetic, no I/O).
 *
 * ⚠️ FINANCIAL SYSTEM: On failure, returns conservative "skip" — never enters blindly.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../middleware/logger.js";
import { XGBoostPredictor } from "./xgboost.js";
import { V3_FEATURE_NAMES } from "./ml-features.js";

const log = logger.child({ module: "ml-predictor" });

// ═══════════════════════════════════════════════════════════════
// Types (unchanged — same interface for trading-engine.ts)
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
  /** Path to model JSON file (relative to project root or absolute) */
  modelPath?: string;
  /** Path to model metadata JSON */
  metadataPath?: string;
  /** Optimal threshold override (uses metadata value if not set) */
  threshold?: number;
  /** Whether to enable ML predictions (can be toggled at runtime) */
  enabled: boolean;
}

interface ModelMetadata {
  version: string;
  optimal_threshold: number;
  feature_columns: string[];
  metrics: Record<string, number>;
  training_info?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Resolve model paths — works in dev (src/) and prod (dist/)
// ═══════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Walk up from engine/ dir to find the models/ folder */
function findModelsDir(): string {
  // In dev: src/engine/ → project root → models/
  // In prod: dist/engine/ → project root → models/
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "models");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  // Fallback: assume project root
  return join(dirname(dirname(__dirname)), "models");
}

const DEFAULT_MODELS_DIR = findModelsDir();
const DEFAULT_MODEL_PATH = join(DEFAULT_MODELS_DIR, "lp_predictor_v3_latest.json");

function findLatestMetadata(modelsDir: string): string | null {
  try {
    const files = readdirSync(modelsDir)
      .filter((f: string) => f.match(/lp_predictor_v3_.*_metadata\.json$/))
      .sort();
    if (files.length === 0) return null;
    return join(modelsDir, files[files.length - 1]);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// MLPredictor — in-process inference
// ═══════════════════════════════════════════════════════════════

export class MLPredictor {
  private model: XGBoostPredictor | null = null;
  private metadata: ModelMetadata | null = null;
  private threshold: number = 0.5;
  private enabled: boolean;
  private modelPath: string;
  private metadataPath: string | null;

  constructor(config?: Partial<MLPredictorConfig>) {
    this.enabled = config?.enabled ?? true;
    this.modelPath = config?.modelPath ?? DEFAULT_MODEL_PATH;
    this.metadataPath = config?.metadataPath ?? findLatestMetadata(DEFAULT_MODELS_DIR);

    if (config?.threshold != null) {
      this.threshold = config.threshold;
    }

    // Load model eagerly at construction (fast — just JSON parse)
    this.loadModel();
  }

  private loadModel(): void {
    try {
      if (!existsSync(this.modelPath)) {
        log.error(
          { path: this.modelPath },
          "XGBoost model file not found — ML predictions will be unavailable"
        );
        return;
      }

      this.model = XGBoostPredictor.loadFromFile(this.modelPath);

      // Load metadata for threshold + metrics
      if (this.metadataPath && existsSync(this.metadataPath)) {
        const raw = readFileSync(this.metadataPath, "utf-8");
        this.metadata = JSON.parse(raw) as ModelMetadata;
        // Use metadata threshold unless explicitly overridden
        if (this.metadata.optimal_threshold && this.threshold === 0.5) {
          this.threshold = this.metadata.optimal_threshold;
        }
        log.info(
          {
            model: this.model.modelName,
            threshold: this.threshold.toFixed(4),
            roc_auc: this.metadata.metrics?.roc_auc?.toFixed(4),
            precision: this.metadata.metrics?.precision?.toFixed(4),
          },
          "ML model loaded (in-process, no Python sidecar needed)"
        );
      } else {
        log.info(
          { model: this.model.modelName, threshold: this.threshold },
          "ML model loaded (no metadata file found)"
        );
      }
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Failed to load XGBoost model"
      );
      this.model = null;
    }
  }

  // ── Health ──

  /**
   * Check if the ML model is loaded and ready for predictions.
   * No network calls — just checks in-memory state.
   */
  async checkHealth(): Promise<MLServiceHealth | null> {
    if (!this.model) {
      log.warn("ML model not loaded — checkHealth returning null");
      return null;
    }

    const info = this.model.getInfo();
    return {
      status: "ok",
      model: info.model,
      version: this.metadata?.version ?? "v3",
      threshold: this.threshold,
      featureNames: [...V3_FEATURE_NAMES],
      metrics: this.metadata?.metrics ?? {},
    };
  }

  /**
   * Whether the ML model is loaded and ready.
   */
  get isHealthy(): boolean {
    return this.model !== null;
  }

  get isEnabled(): boolean {
    return this.enabled;
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
   * Batch predict — runs XGBoost tree evaluation in-process.
   * No HTTP calls, no latency, no API keys.
   */
  async predictBatch(
    featureArrays: number[][],
    poolAddresses?: string[]
  ): Promise<MLPrediction[] | null> {
    if (!this.enabled || !this.model) {
      return null;
    }

    try {
      // Clean input — replace NaN/Inf with 0 (same as Python serve.py)
      const cleaned = featureArrays.map((row) =>
        row.map((v) => (isFinite(v) ? v : 0))
      );

      const probabilities = this.model.predictBatch(cleaned);

      return probabilities.map((prob, i) => {
        // Confidence levels (same logic as Python serve.py)
        let confidence: "high" | "medium" | "low";
        if (prob >= 0.95 || prob <= 0.05) {
          confidence = "high";
        } else if (prob >= this.threshold || prob <= (1 - this.threshold)) {
          confidence = "medium";
        } else {
          confidence = "low";
        }

        return {
          poolAddress: poolAddresses?.[i],
          probability: Math.round(prob * 1e6) / 1e6, // 6 decimal places
          recommendation: prob >= this.threshold ? "enter" : "skip",
          confidence,
        };
      });
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "ML prediction failed — model evaluation error"
      );
      return null;
    }
  }

  // ── Configuration ──

  /**
   * Update threshold at runtime.
   */
  setThreshold(threshold: number): void {
    this.threshold = threshold;
    log.info({ threshold }, "ML threshold updated");
  }

  /**
   * Enable or disable ML predictions at runtime.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    log.info({ enabled }, "ML predictor toggled");
  }

  /**
   * Hot-reload the model from disk (e.g., after retraining).
   */
  reloadModel(): { success: boolean; model?: string; error?: string } {
    try {
      this.loadModel();
      if (this.model) {
        return { success: true, model: this.model.modelName };
      }
      return { success: false, error: "Model file not found" };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
