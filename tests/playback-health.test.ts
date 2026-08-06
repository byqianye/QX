import { describe, expect, it } from "vitest";

import {
  PlaybackFallbackCoordinator,
  PlaybackHealthTracker,
  rankFallbackCandidates,
  type FallbackCandidate,
} from "../src/health/playback-health.js";

function candidate(
  id: string,
  kind: FallbackCandidate["kind"],
  healthScore: number | null = null,
): FallbackCandidate {
  return { id, label: id, kind, healthScore };
}

describe("playback health", () => {
  it("starts with unknown metrics and records a successful playback with explainable score", () => {
    const tracker = new PlaybackHealthTracker({ sourceId: "line-a", now: () => 1_000 });

    expect(tracker.snapshot().firstFrameMs).toMatchObject({ value: null, samples: 0 });
    tracker.beginAttempt(1_000);
    tracker.recordResolve(true, 1_050);
    tracker.recordFirstFrame(2_250);
    tracker.recordPlaybackDuration(42, 3_000);
    tracker.recordCompletion(4_000);

    const snapshot = tracker.snapshot();
    expect(snapshot.resolveSuccess).toMatchObject({ value: true, samples: 1 });
    expect(snapshot.firstFrameMs).toMatchObject({ value: 1_250, samples: 1 });
    expect(snapshot.playbackDuration).toMatchObject({ value: 42, samples: 1 });
    expect(snapshot.completion).toMatchObject({ value: true, samples: 1 });
    expect(snapshot.lastSuccess.value).toBe(4_000);
    expect(snapshot.consecutiveFailures.value).toBe(0);
    expect(snapshot.score.value).not.toBeNull();
    expect(snapshot.score.reasons).toContain("首帧 1250ms");
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "attempt-started",
      "resolve-success",
      "first-frame",
      "playback-duration",
      "completion",
    ]);
  });

  it("does not treat a single short buffer as a fallback trigger", () => {
    const tracker = new PlaybackHealthTracker({ sourceId: "line-a" });
    tracker.beginAttempt(0);
    tracker.recordFirstFrame(500);
    tracker.recordBufferStart(1_000);
    tracker.recordBufferEnd(1_120);

    expect(tracker.shouldTriggerSegmentFailure()).toBe(false);
    expect(tracker.snapshot()).toMatchObject({
      bufferingCount: { value: 1, samples: 1 },
      bufferingDuration: { value: 120, samples: 1 },
      consecutiveFailures: { value: 0 },
    });
  });

  it("counts fatal and consecutive segment failures while user pause and seek stay neutral", () => {
    const tracker = new PlaybackHealthTracker({ sourceId: "line-a" });
    tracker.recordUserPause(100);
    tracker.recordSeek(200);
    tracker.recordSegmentFailure("segment timeout", 300);
    expect(tracker.shouldTriggerSegmentFailure()).toBe(false);
    tracker.recordSegmentFailure("segment timeout", 400);
    expect(tracker.shouldTriggerSegmentFailure()).toBe(true);
    tracker.recordFatalError("HLS_ERROR", 500);

    const snapshot = tracker.snapshot();
    expect(snapshot.segmentFailure).toMatchObject({ value: 2, samples: 2 });
    expect(snapshot.fatalError).toMatchObject({ value: 1, samples: 1 });
    expect(snapshot.consecutiveFailures.value).toBe(3);
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "user-pause",
      "seek",
      "segment-failure",
      "segment-failure",
      "fatal-error",
    ]);
  });

  it("sorts known healthier candidates before unknown candidates without exposing addresses", () => {
    const ordered = rankFallbackCandidates([
      candidate("unknown", "healthier", null),
      candidate("same-content", "same-content", 70),
      candidate("healthier", "healthier", 92),
      candidate("retry", "retry-current"),
      candidate("reparse", "reparse-current"),
    ]);

    expect(ordered.map((item) => item.id)).toEqual([
      "retry",
      "reparse",
      "same-content",
      "healthier",
      "unknown",
    ]);
  });
});

describe("playback fallback coordinator", () => {
  it("uses retry, reparse, same-content, and healthier candidates in order", () => {
    let now = 1_000;
    const coordinator = new PlaybackFallbackCoordinator({
      mode: "auto",
      maxAttempts: 4,
      totalTimeoutMs: 5_000,
      now: () => now,
    });
    coordinator.begin([
      candidate("retry", "retry-current"),
      candidate("reparse", "reparse-current"),
      candidate("same", "same-content"),
      candidate("healthy", "healthier", 90),
    ]);

    let decision = coordinator.trigger("player-fatal", "HLS fatal");
    expect(decision).toMatchObject({ kind: "attempt", candidate: { id: "retry" } });
    coordinator.finishAttempt(false);
    now += 100;
    decision = coordinator.next();
    expect(decision).toMatchObject({ kind: "attempt", candidate: { id: "reparse" } });
    coordinator.finishAttempt(false);
    decision = coordinator.next();
    expect(decision).toMatchObject({ kind: "attempt", candidate: { id: "same" } });
    coordinator.finishAttempt(true);

    expect(coordinator.state).toMatchObject({ status: "recovered", attempts: 3 });
    expect(coordinator.state.tried).toEqual(["retry", "reparse", "same"]);
  });

  it("supports prompt mode, ignores user actions, prevents loops, enforces max attempts and cancellation", () => {
    const coordinator = new PlaybackFallbackCoordinator({ mode: "prompt", maxAttempts: 1, totalTimeoutMs: 100 });
    coordinator.begin([candidate("retry", "retry-current"), candidate("other", "same-content")]);

    expect(coordinator.trigger("user-pause", "用户暂停")).toMatchObject({ kind: "none" });
    expect(coordinator.state.status).toBe("idle");
    expect(coordinator.trigger("startup-timeout", "起播超时")).toMatchObject({ kind: "prompt", candidate: { id: "retry" } });
    expect(coordinator.approveNext()).toMatchObject({ kind: "attempt", candidate: { id: "retry" } });
    coordinator.finishAttempt(false);
    expect(coordinator.next()).toMatchObject({ kind: "stopped" });
    expect(coordinator.trigger("player-fatal", "再次失败")).toMatchObject({ kind: "none" });

    coordinator.begin([candidate("retry", "retry-current"), candidate("other", "same-content")]);
    coordinator.cancel("用户取消");
    expect(coordinator.trigger("player-fatal", "被取消")).toMatchObject({ kind: "none" });
    expect(coordinator.state).toMatchObject({ status: "cancelled", reason: "用户取消" });
  });

  it("stops when the total timeout expires and returns recovered state after success", () => {
    let now = 0;
    const coordinator = new PlaybackFallbackCoordinator({ mode: "auto", totalTimeoutMs: 10, now: () => now });
    coordinator.begin([candidate("retry", "retry-current")]);
    expect(coordinator.trigger("parse-failure", "解析失败")).toMatchObject({ kind: "attempt" });
    coordinator.finishAttempt(false);
    now = 11;
    expect(coordinator.next()).toMatchObject({ kind: "stopped" });
    expect(coordinator.state.status).toBe("stopped");

    coordinator.begin([candidate("retry", "retry-current")]);
    expect(coordinator.trigger("proxy-fatal", "代理失败")).toMatchObject({ kind: "attempt" });
    coordinator.finishAttempt(true);
    expect(coordinator.state.status).toBe("recovered");
  });
});
