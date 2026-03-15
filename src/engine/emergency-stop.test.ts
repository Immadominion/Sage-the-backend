/**
 * EmergencyStop unit tests.
 *
 * Tests the financial safety kill switch logic — critical for capital protection.
 * No external dependencies needed (no DB, no network).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    EmergencyStop,
    type EmergencyStopState,
} from "./emergency-stop.js";

describe("EmergencyStop", () => {
    let stop: EmergencyStop;

    beforeEach(() => {
        stop = new EmergencyStop("test-bot");
    });

    // ── canTrade gate ─────────────────────────────────────

    describe("canTrade()", () => {
        it("allows trading in initial state", () => {
            const result = stop.canTrade();
            expect(result.allowed).toBe(true);
        });

        it("blocks trading after kill switch activation", () => {
            stop.setKillSwitch(true);
            const result = stop.canTrade();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("Kill switch");
        });

        it("blocks trading after daily loss limit exceeded", () => {
            // Default maxDailyLossSOL = 2
            stop.recordTradeResult(-1.0);
            expect(stop.canTrade().allowed).toBe(true);

            stop.recordTradeResult(-1.1);
            const result = stop.canTrade();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("Daily loss limit");
        });

        it("blocks trading after total loss limit exceeded", () => {
            // Use higher daily limit so total limit triggers first
            const s = new EmergencyStop("total-test", {
                maxDailyLossSOL: 10,
                maxTotalLossSOL: 5,
                maxConsecutiveLosses: 100, // don't interfere
            });

            s.recordTradeResult(-2.0);
            s.recordTradeResult(-2.0);
            // Total P&L: -4.0, still under 5
            expect(s.canTrade().allowed).toBe(true);

            s.recordTradeResult(-2.0); // total now -6.0
            const result = s.canTrade();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("Total loss limit");
        });

        it("blocks trading after consecutive losses", () => {
            // Default maxConsecutiveLosses = 5
            for (let i = 0; i < 4; i++) {
                stop.recordTradeResult(-0.01); // small losses
            }
            expect(stop.canTrade().allowed).toBe(true);

            stop.recordTradeResult(-0.01); // 5th consecutive
            const result = stop.canTrade();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("consecutive losses");
        });

        it("resets consecutive losses on a win", () => {
            for (let i = 0; i < 3; i++) {
                stop.recordTradeResult(-0.01);
            }
            stop.recordTradeResult(0.1); // win resets counter
            for (let i = 0; i < 4; i++) {
                stop.recordTradeResult(-0.01);
            }
            // Only 4 consecutive losses, not 5
            expect(stop.canTrade().allowed).toBe(true);
        });

        it("blocks on tx failure spike", () => {
            // Default maxTxFailuresPerHour = 10
            for (let i = 0; i < 10; i++) {
                stop.recordTxFailure();
            }
            const result = stop.canTrade();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("tx failures");
        });

        it("blocks on API error spike", () => {
            // Default maxApiErrorsPerHour = 50
            for (let i = 0; i < 50; i++) {
                stop.recordApiError();
            }
            const result = stop.canTrade();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("API errors");
        });
    });

    // ── Manual controls ───────────────────────────────────

    describe("manual controls", () => {
        it("manualTrigger blocks trading", () => {
            stop.manualTrigger("testing");
            expect(stop.isTriggered).toBe(true);
            expect(stop.triggerReason).toContain("Manual: testing");
            expect(stop.canTrade().allowed).toBe(false);
        });

        it("reset clears trigger but preserves P&L", () => {
            stop.recordTradeResult(-0.5);
            stop.manualTrigger("test");
            expect(stop.isTriggered).toBe(true);

            stop.reset();
            expect(stop.isTriggered).toBe(false);
            // P&L state preserved
            const state = stop.getState();
            expect(state.totalPnlSOL).toBe(-0.5);
        });

        it("fullReset clears everything", () => {
            stop.recordTradeResult(-1.0);
            stop.recordTxFailure();
            stop.manualTrigger("test");

            stop.fullReset();
            const state = stop.getState();
            expect(state.isTriggered).toBe(false);
            expect(state.totalPnlSOL).toBe(0);
            expect(state.txFailures).toEqual([]);
        });
    });

    // ── Callbacks ─────────────────────────────────────────

    describe("callbacks", () => {
        it("fires callback when triggered", () => {
            let firedReason = "";
            stop.onTrigger((reason) => {
                firedReason = reason;
            });

            stop.manualTrigger("test callback");
            expect(firedReason).toContain("Manual: test callback");
        });

        it("does not fire callback on second trigger", () => {
            let callCount = 0;
            stop.onTrigger(() => { callCount++; });

            stop.manualTrigger("first");
            stop.manualTrigger("second");
            expect(callCount).toBe(1);
        });
    });

    // ── Serialization / Deserialization ───────────────────

    describe("serialization", () => {
        it("round-trips state correctly", () => {
            stop.recordTradeResult(-0.5);
            stop.recordTxFailure();

            const json = stop.serializeState();
            const restored = EmergencyStop.deserializeState(json);

            expect(restored).not.toBeNull();
            expect(restored!.totalPnlSOL).toBe(-0.5);
            expect(restored!.dailyPnlSOL).toBe(-0.5);
            expect(restored!.txFailures.length).toBe(1);
        });

        it("returns null on invalid JSON", () => {
            const result = EmergencyStop.deserializeState("not json");
            expect(result).toBeNull();
        });

        it("returns null on missing essential fields", () => {
            const result = EmergencyStop.deserializeState(
                JSON.stringify({ foo: "bar" })
            );
            expect(result).toBeNull();
        });

        it("sanitizes corrupt txFailures array", () => {
            const corrupt = JSON.stringify({
                isTriggered: false,
                triggerReason: null,
                triggerTimestamp: null,
                dailyPnlSOL: 0,
                totalPnlSOL: 0,
                consecutiveLosses: 0,
                dailyResetDate: "2026-01-01",
                txFailures: ["not-a-number", -1, 9999999999999999],
                apiErrors: null,
                totalTriggers: 0,
            });

            const result = EmergencyStop.deserializeState(corrupt);
            expect(result).not.toBeNull();
            expect(result!.txFailures).toEqual([]);
            expect(result!.apiErrors).toEqual([]);
        });

        it("preserves valid recent timestamps", () => {
            const recentTs = Date.now() - 5 * 60 * 1000; // 5 min ago
            const state: EmergencyStopState = {
                isTriggered: false,
                triggerReason: null,
                triggerTimestamp: null,
                dailyPnlSOL: -0.3,
                totalPnlSOL: -0.3,
                consecutiveLosses: 2,
                dailyResetDate: new Date().toISOString().slice(0, 10),
                txFailures: [recentTs],
                apiErrors: [recentTs, recentTs + 1000],
                totalTriggers: 1,
            };

            const json = JSON.stringify(state);
            const restored = EmergencyStop.deserializeState(json);

            expect(restored).not.toBeNull();
            expect(restored!.txFailures.length).toBe(1);
            expect(restored!.apiErrors.length).toBe(2);
            expect(restored!.dailyPnlSOL).toBe(-0.3);
            expect(restored!.consecutiveLosses).toBe(2);
        });

        it("filters out future timestamps", () => {
            const futureTs = Date.now() + 60_000; // 1 min in future
            const state = {
                isTriggered: false,
                triggerReason: null,
                triggerTimestamp: null,
                dailyPnlSOL: 0,
                totalPnlSOL: 0,
                consecutiveLosses: 0,
                dailyResetDate: "2026-03-13",
                txFailures: [futureTs],
                apiErrors: [futureTs],
                totalTriggers: 0,
            };

            const result = EmergencyStop.deserializeState(JSON.stringify(state));
            expect(result!.txFailures).toEqual([]);
            expect(result!.apiErrors).toEqual([]);
        });
    });

    // ── Custom config ─────────────────────────────────────

    describe("custom config", () => {
        it("respects custom loss limits", () => {
            const strict = new EmergencyStop("strict", {
                maxDailyLossSOL: 0.5,
                maxConsecutiveLosses: 2,
            });

            strict.recordTradeResult(-0.3);
            expect(strict.canTrade().allowed).toBe(true);

            strict.recordTradeResult(-0.3);
            const result = strict.canTrade();
            expect(result.allowed).toBe(false);
        });

        it("restores from saved state", () => {
            const savedState: EmergencyStopState = {
                isTriggered: true,
                triggerReason: "Previous session halt",
                triggerTimestamp: Date.now() - 3600_000,
                dailyPnlSOL: -1.5,
                totalPnlSOL: -3.0,
                consecutiveLosses: 4,
                dailyResetDate: new Date().toISOString().slice(0, 10),
                txFailures: [],
                apiErrors: [],
                totalTriggers: 2,
            };

            const restored = new EmergencyStop("restored", {}, savedState);
            expect(restored.isTriggered).toBe(true);
            expect(restored.triggerReason).toBe("Previous session halt");

            const state = restored.getState();
            expect(state.totalPnlSOL).toBe(-3.0);
            expect(state.totalTriggers).toBe(2);
        });
    });

    // ── Summary ───────────────────────────────────────────

    describe("getSummary()", () => {
        it("returns accurate summary", () => {
            stop.recordTradeResult(-0.1);
            stop.recordTradeResult(0.3);
            stop.recordTxFailure();

            const summary = stop.getSummary();
            expect(summary.isTriggered).toBe(false);
            expect(summary.dailyPnlSOL).toBeCloseTo(0.2, 10);
            expect(summary.totalPnlSOL).toBeCloseTo(0.2, 10);
            expect(summary.consecutiveLosses).toBe(0);
            expect(summary.txFailuresLastHour).toBe(1);
            expect(summary.totalTriggers).toBe(0);
        });
    });
});
