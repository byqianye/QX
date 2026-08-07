import { describe, expect, it } from "vitest";

import {
  LiveFailoverCoordinator,
  LiveHealthRegistry,
  LiveStreamCircuitBreaker,
  LiveStreamHealthTracker,
} from "../src/live/live-health.js";
import type { LiveFailoverCandidateUiState } from "../src/live/live-types.js";

describe("live stream health", () => {
  it("keeps explainable metrics and ignores user controls as failures", () => {
    let now = 1_000;
    const tracker = new LiveStreamHealthTracker({
      streamId: "stream-a",
      sourceId: "source-a",
      now: () => now,
    });

    expect(tracker.snapshot().score).toBeNull();
    tracker.beginAttempt(1_000);
    tracker.recordFirstFrame(1_350);
    tracker.recordSegmentFailure("fragment failure", 2_000);
    expect(tracker.shouldTriggerSegmentFailure()).toBe(false);
    tracker.recordUserPause(2_100);
    tracker.recordSeek(2_200);
    tracker.recordBufferStart(3_000);
    now = 12_000;
    expect(tracker.recordBufferEnd(12_000)).toBe(9_000);
    const snapshot = tracker.snapshot(12_000);

    expect(snapshot.startupSuccess).toMatchObject({ value: true, samples: 1 });
    expect(snapshot.firstFrameMs).toMatchObject({ value: 350, samples: 1 });
    expect(snapshot.segmentFailure).toMatchObject({ value: 1, samples: 1 });
    expect(snapshot.bufferDuration).toMatchObject({ value: 9_000, samples: 1 });
    expect(snapshot.score).not.toBeNull();
    expect(snapshot.scoreReasons).toEqual(expect.arrayContaining(["recent success"]));
    expect(snapshot.events.filter((event) => event.type === "user-pause")).toHaveLength(1);
    expect(snapshot.events.filter((event) => event.type === "seek")).toHaveLength(1);
    expect(tracker.shouldTriggerLongBuffer(9_000)).toBe(true);
  });

  it("hydrates and batches persistence without one write per event", () => {
    const records = new Map<string, unknown>([["stream-a", {
      streamId: "stream-a",
      sourceId: "source-a",
      startupSuccess: { value: true, samples: 1 },
      firstFrameMs: { value: 120, samples: 1 },
      lastSuccessAt: 900,
    }]]);
    const writes: Array<readonly { id: string; sourceId: string; snapshot: unknown; updatedAt: number }[]> = [];
    const registry = new LiveHealthRegistry({
      now: () => 1_000,
      persistDebounceMs: 0,
      store: {
        readStream: (id) => records.get(id) ?? null,
        upsertStream: () => { throw new Error("single-row persistence was not expected"); },
        upsertStreams: (batch) => writes.push(batch),
      },
    });
    const tracker = registry.tracker("stream-a", "source-a");
    expect(tracker.snapshot().firstFrameMs.value).toBe(120);
    tracker.recordSegmentFailure("one", 1_010);
    tracker.recordSegmentFailure("two", 1_020);
    registry.markDirty("stream-a");
    registry.flush();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(1);
    expect((writes[0]?.[0]?.snapshot as { segmentFailure: { value: number } }).segmentFailure.value).toBe(2);
    registry.close();
  });
});

describe("live failover coordination", () => {
  const candidate = (id: string): LiveFailoverCandidateUiState => ({
    id,
    channelId: "channel-a",
    streamId: id,
    sourceId: "source-a",
    sourceName: "Fixture",
    channelName: "News",
    streamLabel: id,
    memberId: null,
    smartChannelId: null,
    healthScore: null,
  });

  it("asks before trying, never repeats a tried candidate, and honors the attempt cap", () => {
    const coordinator = new LiveFailoverCoordinator({ mode: "ask", maxAttempts: 1, now: () => 1_000 });
    coordinator.begin([candidate("a"), candidate("b"), candidate("c")], "a");
    expect(coordinator.trigger("segment-errors", "two segment failures")).toMatchObject({ kind: "prompt", candidate: { id: "b" } });
    expect(coordinator.approve()).toMatchObject({ kind: "attempt", candidate: { id: "b" } });
    expect(coordinator.next()).toMatchObject({ kind: "stopped" });
    expect(coordinator.state.tried).toEqual(["a", "b"]);
  });

  it("supports auto and off modes", () => {
    const auto = new LiveFailoverCoordinator({ mode: "auto", maxAttempts: 2, now: () => 1_000 });
    auto.begin([candidate("a"), candidate("b"), candidate("c")], "a");
    expect(auto.trigger("fatal-error", "fatal")).toMatchObject({ kind: "attempt", candidate: { id: "b" } });
    expect(auto.trigger("fatal-error", "fatal again")).toMatchObject({ kind: "attempt", candidate: { id: "c" } });
    expect(auto.trigger("fatal-error", "fatal third")).toMatchObject({ kind: "stopped" });

    const off = new LiveFailoverCoordinator({ mode: "off" });
    off.begin([candidate("a"), candidate("b")], "a");
    expect(off.trigger("startup-failure", "failed")).toMatchObject({ kind: "none", reason: "failover-disabled" });
    expect(off.state.status).toBe("disabled");
  });

  it("opens a temporary circuit and allows recovery", () => {
    let now = 10_000;
    const circuit = new LiveStreamCircuitBreaker({ cooldownMs: 1_000, now: () => now });
    expect(circuit.open("stream-a")).toBe(11_000);
    expect(circuit.isCoolingDown("stream-a")).toBe(true);
    now = 11_001;
    expect(circuit.isCoolingDown("stream-a")).toBe(false);
    circuit.open("stream-a");
    circuit.recover("stream-a");
    expect(circuit.cooldownUntil("stream-a")).toBeNull();
  });
});
