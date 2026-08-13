import { describe, expect, it } from "vitest";

import { isAutoFallbackRetryable, limitAutoFallbackCandidates, type FallbackCandidate } from "../src/health/playback-health.js";

function candidate(id: string, sourceId: string, lineKey: string): FallbackCandidate {
  return { id, label: id, kind: "same-content", sourceId, lineKey };
}

describe("auto fallback v2", () => {
  it("accepts only retryable failure classes", () => {
    expect(isAutoFallbackRetryable("HLS_SEGMENT_FAILED")).toBe(true);
    expect(isAutoFallbackRetryable("MEDIA_HTTP_403")).toBe(true);
    expect(isAutoFallbackRetryable("AUTH_REQUIRED")).toBe(false);
    expect(isAutoFallbackRetryable("DRM_REQUIRED")).toBe(false);
    expect(isAutoFallbackRetryable("USER_CANCELLED")).toBe(false);
  });

  it("bounds sources and lines without hiding the current retry/reparse pair", () => {
    const candidates: FallbackCandidate[] = [
      { id: "retry", label: "retry", kind: "retry-current" },
      { id: "reparse", label: "reparse", kind: "reparse-current", parseAttempt: 1 },
      ...Array.from({ length: 4 }, (_, index) => candidate(`line-${index}`, "source-a", `line-${index}`)),
      ...Array.from({ length: 6 }, (_, index) => candidate(`source-${index}`, `source-${index}`, "line-1")),
    ];
    const limited = limitAutoFallbackCandidates(candidates, { maxSources: 5, maxLinesPerSource: 3 });
    expect(limited.slice(0, 2).map((item) => item.id)).toEqual(["retry", "reparse"]);
    expect(limited.filter((item) => item.sourceId === "source-a")).toHaveLength(3);
    expect(new Set(limited.filter((item) => item.sourceId?.startsWith("source-") && item.sourceId !== "source-a").map((item) => item.sourceId)).size).toBe(4);
  });
});
