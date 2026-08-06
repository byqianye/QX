import { describe, expect, it } from "vitest";

import { sanitizeHealthMessage, SourceHealthRegistry } from "../src/health/source-health.js";
import { AggregateSearchCoordinator } from "../src/search/aggregate-search.js";
import type { VodPage } from "../src/source/media-source.js";

const page: VodPage = {
  page: 1,
  items: [{ id: "1", name: "one", raw: { id: "1", name: "one" } }],
  raw: {},
};

describe("source health and circuit breaker", () => {
  it("records operation timings, timeouts, crashes, and opens a temporary circuit", async () => {
    const health = new SourceHealthRegistry({ failureThreshold: 2, cooldownMs: 1000 });
    await health.track("source", "search", async () => page);
    await expect(health.track("source", "detail", async () => {
      const error = new Error("request timeout") as Error & { code: string };
      error.code = "PYTHON_TIMEOUT";
      throw error;
    })).rejects.toMatchObject({ code: "PYTHON_TIMEOUT" });
    health.markSidecarCrash("source", new Error("sidecar crashed"));
    await expect(health.track("source", "player", async () => {
      throw new Error("sidecar crashed");
    })).rejects.toThrow("sidecar crashed");

    const snapshot = health.get("source");
    expect(snapshot.circuit).toBe("open");
    expect(snapshot.timeoutCount).toBe(1);
    expect(snapshot.sidecarCrashCount).toBe(2);
    expect(snapshot.operations.search.successes).toBe(1);
    expect(snapshot.operations.search.averageMs).not.toBeNull();
    expect(health.canRun("source")).toBe(false);

    health.retry("source");
    expect(health.canRun("source")).toBe(true);
    expect(health.get("source").circuit).toBe("closed");
  });

  it("causes aggregate search to skip a cooling source", async () => {
    const health = new SourceHealthRegistry({ failureThreshold: 1, cooldownMs: 1000 });
    health.recordFailure("cooling", "search", new Error("failed"), 4);
    const coordinator = new AggregateSearchCoordinator([
      { id: "cooling", search: async () => page },
      { id: "healthy", search: async () => page },
    ]);

    const result = await coordinator.search("q", { health });
    expect(result.total).toBe(1);
    expect(result.sources).toMatchObject([
      { id: "cooling", status: "skipped", error: "Source is cooling down" },
      { id: "healthy", status: "success" },
    ]);
  });

  it("does not retain credentials in health error summaries", () => {
    const health = new SourceHealthRegistry();
    health.recordFailure(
      "source",
      "search",
      new Error("GET https://private.example/search?token=secret&q=movie Authorization: Bearer abc"),
      2,
    );
    expect(health.get("source").lastError).toBe(
      "GET https://private.example/search Authorization: Bearer [redacted]",
    );
    expect(sanitizeHealthMessage("https://private.example/path?api_key=secret")).toBe("https://private.example/path");
    expect(sanitizeHealthMessage("Cookie: session-secret Authorization: Basic base64-secret")).toBe(
      "Cookie: [redacted] Authorization: Basic [redacted]",
    );
  });
});
