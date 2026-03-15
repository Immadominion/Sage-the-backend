/**
 * XGBoost Tree Evaluator — Pure TypeScript inference for XGBoost JSON models.
 *
 * Loads the native XGBoost JSON format (exported via model.save_model("x.json"))
 * and evaluates predictions in-process — no Python sidecar needed.
 *
 * Supports: binary:logistic objective, gbtree booster.
 * Model size: ~150KB JSON, ~100 trees × ~17 nodes each = trivial memory.
 *
 * ⚠️ FINANCIAL SYSTEM: This directly drives trading decisions.
 *    The evaluator must produce identical results to Python's model.predict_proba().
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../middleware/logger.js";

const log = logger.child({ module: "xgboost" });

// ═══════════════════════════════════════════════════════════════
// Types — mirrors XGBoost JSON schema
// ═══════════════════════════════════════════════════════════════

interface XGBTree {
    /** Feature index used at each node (-1 for leaves in some versions) */
    split_indices: number[];
    /** Split threshold (for internal nodes) or leaf weight (for leaves) */
    split_conditions: number[];
    /** Left child index (-1 = leaf sentinel in children arrays) */
    left_children: number[];
    /** Right child index (-1 = leaf sentinel in children arrays) */
    right_children: number[];
    /** Whether to go left when feature value is missing (NaN) */
    default_left: number[];
    /** Leaf/node weight values */
    base_weights: number[];
}

interface XGBModel {
    learner: {
        gradient_booster: {
            model: {
                trees: XGBTree[];
                gbtree_model_param: {
                    num_trees: string;
                };
            };
        };
        learner_model_param: {
            base_score: string; // e.g. "[5E-1]" or "0.5"
            num_feature: string;
        };
        objective: {
            name: string; // "binary:logistic"
        };
        feature_names?: string[];
    };
}

// ═══════════════════════════════════════════════════════════════
// Sigmoid — logistic transform for binary:logistic
// ═══════════════════════════════════════════════════════════════

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

// ═══════════════════════════════════════════════════════════════
// XGBoostPredictor
// ═══════════════════════════════════════════════════════════════

export class XGBoostPredictor {
    private trees: XGBTree[];
    private baseScore: number;
    private numFeatures: number;
    private objective: string;

    /** Model file name (for health/status reporting) */
    readonly modelName: string;

    private constructor(
        model: XGBModel,
        modelName: string
    ) {
        this.trees = model.learner.gradient_booster.model.trees;
        this.objective = model.learner.objective.name;
        this.modelName = modelName;

        // Parse base_score — XGBoost uses formats like "[5E-1]", "0.5", etc.
        const rawScore = model.learner.learner_model_param.base_score;
        const cleaned = rawScore.replace(/[\[\]]/g, "");
        this.baseScore = parseFloat(cleaned);
        if (isNaN(this.baseScore)) {
            this.baseScore = 0.5;
        }

        this.numFeatures = parseInt(
            model.learner.learner_model_param.num_feature,
            10
        );

        if (this.objective !== "binary:logistic") {
            log.warn(
                { objective: this.objective },
                "XGBoost model objective is not binary:logistic — predictions may be incorrect"
            );
        }
    }

    /**
     * Load a model from a JSON file path.
     * Call once at startup — the model stays in memory.
     */
    static loadFromFile(filePath: string): XGBoostPredictor {
        const absPath = resolve(filePath);
        const raw = readFileSync(absPath, "utf-8");
        const model: XGBModel = JSON.parse(raw);
        const name = absPath.split("/").pop() ?? "unknown";

        const predictor = new XGBoostPredictor(model, name);

        log.info(
            {
                model: name,
                trees: predictor.trees.length,
                features: predictor.numFeatures,
                baseScore: predictor.baseScore,
                objective: predictor.objective,
            },
            "XGBoost model loaded (in-process)"
        );

        return predictor;
    }

    /**
     * Evaluate a single tree for one feature row.
     * Walks from root (node 0) to a leaf, returns the leaf weight.
     */
    private evaluateTree(tree: XGBTree, features: number[]): number {
        let nodeIdx = 0;

        // Walk until we hit a leaf (left_children[nodeIdx] === -1)
        while (tree.left_children[nodeIdx] !== -1) {
            const featureIdx = tree.split_indices[nodeIdx];
            const threshold = tree.split_conditions[nodeIdx];
            const featureVal = features[featureIdx];

            // Handle missing (NaN) values — follow default direction
            if (featureVal === undefined || isNaN(featureVal)) {
                nodeIdx = tree.default_left[nodeIdx]
                    ? tree.left_children[nodeIdx]
                    : tree.right_children[nodeIdx];
            } else if (featureVal < threshold) {
                nodeIdx = tree.left_children[nodeIdx];
            } else {
                nodeIdx = tree.right_children[nodeIdx];
            }
        }

        // Leaf node — return the base_weights value (not split_conditions for leaves)
        return tree.base_weights[nodeIdx];
    }

    /**
     * Predict probability for a single feature row.
     * Returns P(class=1) for binary:logistic.
     *
     * Algorithm:
     *   raw_score = base_score_logit + sum(tree_leaf_weights)
     *   probability = sigmoid(raw_score)
     *
     * Note: XGBoost internally stores base_score in logit space when
     * boost_from_average=1 (default). For base_score=0.5, logit = 0.
     */
    predictProbability(features: number[]): number {
        // base_score=0.5 → logit space = 0 (since sigmoid(0) = 0.5)
        // XGBoost with boost_from_average=1 uses logit(base_score) internally
        const baseLogit = Math.log(this.baseScore / (1 - this.baseScore));

        let rawScore = baseLogit;

        for (const tree of this.trees) {
            rawScore += this.evaluateTree(tree, features);
        }

        return sigmoid(rawScore);
    }

    /**
     * Batch predict probabilities for multiple feature rows.
     */
    predictBatch(featureRows: number[][]): number[] {
        return featureRows.map((row) => this.predictProbability(row));
    }

    /**
     * Get model info for health/status endpoints.
     */
    getInfo() {
        return {
            model: this.modelName,
            trees: this.trees.length,
            features: this.numFeatures,
            objective: this.objective,
        };
    }
}
