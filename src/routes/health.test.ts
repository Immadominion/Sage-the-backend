/**
 * Health endpoint integration test.
 *
 * Tests the health route's response structure and degradation behavior.
 * When DB/RPC are unavailable, the endpoint should degrade gracefully
 * (not crash) — this is the real production behavior.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import healthRoutes from "../routes/health.js";

describe("GET /health", () => {
    const app = new Hono();
    app.route("/health", healthRoutes);

    it("returns 200 with valid JSON structure", async () => {
        const res = await app.request("/health");
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toHaveProperty("status");
        expect(body).toHaveProperty("timestamp");
        expect(body).toHaveProperty("version");
        expect(body).toHaveProperty("uptime");
        expect(typeof body.uptime).toBe("number");
        expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    it("returns ISO timestamp", async () => {
        const res = await app.request("/health");
        const body = await res.json();
        // Must be a valid ISO date string
        const date = new Date(body.timestamp);
        expect(date.getTime()).not.toBeNaN();
    });

    it("reports version string", async () => {
        const res = await app.request("/health");
        const body = await res.json();
        expect(typeof body.version).toBe("string");
        expect(body.version.length).toBeGreaterThan(0);
    });

    it("returns status as ok or degraded (never crashes)", async () => {
        const res = await app.request("/health");
        const body = await res.json();
        // In test env without real DB/RPC, expect degraded
        expect(["ok", "degraded"]).toContain(body.status);
    });

    it("reports solana connectivity status", async () => {
        const res = await app.request("/health");
        const body = await res.json();
        // Should have either "connected" or "error" — never undefined
        expect(["connected", "error"]).toContain(body.solana);
    });

    it("reports database connectivity status", async () => {
        const res = await app.request("/health");
        const body = await res.json();
        expect(["connected", "error"]).toContain(body.database);
    });

    it("reports ML service status", async () => {
        const res = await app.request("/health");
        const body = await res.json();
        expect(["loaded", "not-loaded", "error"]).toContain(body.mlService);
    });

    it("never returns 503 for degraded status", async () => {
        // Railway kills replicas on non-2xx, so degraded must still be 200
        const res = await app.request("/health");
        expect(res.status).toBe(200);
    });
});
