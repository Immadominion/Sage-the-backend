/**
 * Quick validation: Compare TypeScript XGBoost evaluator against Python reference values.
 * Run: npx tsx scripts/verify-xgboost.ts
 */
import { XGBoostPredictor } from "../src/engine/xgboost.js";

const model = XGBoostPredictor.loadFromFile("models/lp_predictor_v3_latest.json");

// Test vectors from Python model.predict_proba()
const testCases: number[][] = [
    [500, 1200, 2000, 4000, 20000, 50, 120, 2000, 0.0012, 100000, 150, 0.012],
    [5000, 15000, 25000, 50000, 200000, 500, 1500, 25000, 0.015, 1000000, 500, 0.015],
    [10, 30, 50, 100, 500, 1, 3, 50, 0.00003, 100000, 10, 0.0003],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1000, 3000, 5000, 10000, 50000, 300, 900, 5000, 0.09, 10000, 800, 0.3],
];

const pythonExpected = [
    0.9909108281135559,
    0.990797758102417,
    0.3989565372467041,
    0.02343856729567051,
    0.9515671730041504,
];

console.log("XGBoost TypeScript vs Python Validation");
console.log("═".repeat(60));

let maxDiff = 0;
let allPass = true;

for (let i = 0; i < testCases.length; i++) {
    const tsProb = model.predictProbability(testCases[i]);
    const pyProb = pythonExpected[i];
    const diff = Math.abs(tsProb - pyProb);
    maxDiff = Math.max(maxDiff, diff);
    const pass = diff < 1e-4; // Allow tiny floating point difference

    console.log(
        `  Case ${i}: TS=${tsProb.toFixed(6)} PY=${pyProb.toFixed(6)} diff=${diff.toExponential(2)} ${pass ? "✅" : "❌"}`
    );

    if (!pass) allPass = false;
}

console.log("═".repeat(60));
console.log(`Max diff: ${maxDiff.toExponential(2)}`);
console.log(allPass ? "✅ All cases match!" : "❌ MISMATCH DETECTED");

process.exit(allPass ? 0 : 1);
