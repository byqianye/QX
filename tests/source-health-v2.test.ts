import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SourceHealthService } from "../src/health/source-health.js";

describe("source health v2", () => {
  it("persists safe counters, applies cooldown, and restores them", () => {
    const root = mkdtempSync(join(tmpdir(), "qx-health-v2-"));
    const path = join(root, "source-health.json");
    let now = 1_000;
    try {
      const service = new SourceHealthService({ storePath: path, failureThreshold: 3, cooldownMs: 100, now: () => now });
      service.recordSearchSuccess("jianpian", 50);
      service.recordDetailSuccess("jianpian", 80);
      service.recordPlayerSuccess("jianpian", 120);
      service.recordPlaybackSuccess("jianpian", 200);
      expect(service.getHealth("jianpian").score).toBeGreaterThan(0);
      service.recordSearchFailure("bad", Object.assign(new Error("token=secret"), { code: "SOURCE_TIMEOUT" }), 500);
      service.recordSearchFailure("bad", Object.assign(new Error("failed"), { code: "SOURCE_TIMEOUT" }), 500);
      service.recordSearchFailure("bad", Object.assign(new Error("failed"), { code: "SOURCE_TIMEOUT" }), 500);
      expect(service.canRun("bad")).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("sources.0.lastError");
      now += 101;
      const restored = new SourceHealthService({ storePath: path, failureThreshold: 3, cooldownMs: 100, now: () => now });
      expect(restored.getHealth("jianpian").successCount).toBe(4);
      expect(restored.getHealth("bad").lastFailureCode).toBe("SOURCE_TIMEOUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ranks title match before health and does not auto-select auth sources", () => {
    const service = new SourceHealthService();
    service.recordSearchSuccess("healthy", 100);
    service.recordDetailSuccess("healthy", 100);
    service.recordPlayerSuccess("healthy", 100);
    const ranked = service.getRankedSources([
      { sourceId: "wrong-title", matchScore: 20, compatibilityStatus: "FULLY_PLAYABLE" },
      { sourceId: "healthy", matchScore: 100, compatibilityStatus: "SEARCH_DETAIL_ONLY" },
      { sourceId: "auth", matchScore: 100, compatibilityStatus: "FULLY_PLAYABLE", requiresAuth: true, authenticated: false },
    ]);
    expect(ranked[0]?.sourceId).toBe("healthy");
    expect(ranked.find((item) => item.sourceId === "auth")).toMatchObject({ eligible: false, reason: "AUTH_REQUIRED" });
  });

  it("resets an old source history when its config fingerprint changes", () => {
    const service = new SourceHealthService();
    service.setConfigFingerprint("source", "sha-a");
    service.recordSearchFailure("source", { code: "SOURCE_TIMEOUT" }, 100);
    service.setConfigFingerprint("source", "sha-b");
    expect(service.getHealth("source")).toMatchObject({ failureCount: 0, consecutiveFailures: 0 });
  });
});
