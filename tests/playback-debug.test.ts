import { describe, expect, it } from "vitest";

import {
  PlaybackDebugTimeline,
  formatPlaybackDebugJson,
  formatPlaybackDebugText,
} from "../renderer/src/playback-debug.js";
import { createRendererState, type RendererState } from "../renderer/src/state.js";

function playbackState(): RendererState {
  const state = createRendererState();
  state.import.status = "ready";
  state.import.sessionReady = true;
  state.import.selectedSiteKey = "fixture-site";
  state.spider.source = "inline:fixture";
  state.spider.api = "csp_PlayableFixture";
  state.spider.status = "ready";
  state.spider.sidecarRunning = true;
  state.detail.canPlay = true;
  state.detail.playbackCatalog = {
    lines: [{
      index: 1,
      name: "备用线路",
      episodes: [{ index: 2, name: "第三集", id: "episode-3" }],
    }],
  };
  state.detail.playbackSelection = { lineIndex: 1, episodeIndex: 2 };
  state.playback.session = {
    id: "session-private-123",
    host: "embedded",
    lineIndex: 1,
    episodeIndex: 2,
    lineName: "备用线路",
    episodeName: "第三集",
    media: {
      detailId: "vod-private-123",
      title: "测试片",
      url: "https://private.example.invalid/video.m3u8?token=secret",
    },
  };
  state.playback.player.source = {
    parse: 1,
    url: "https://private.example.invalid/resolve?token=secret",
    headers: { Cookie: "session=secret", Authorization: "Bearer secret" },
  };
  state.playback.player.parse = {
    status: "attempting",
    parserId: "fixture-parser",
    attempts: [],
    error: null,
  };
  return state;
}

describe("playback debug timeline", () => {
  it("keeps ordered events bounded and removes sensitive values", () => {
    const timeline = new PlaybackDebugTimeline({ maxEvents: 3, now: () => new Date("2026-08-06T12:00:00.000Z") });
    timeline.record({
      sessionId: "session-private-123",
      phase: "proxy",
      type: "request",
      source: "https://private.example.invalid/__qx_playback/token",
      safeDetails: {
        Cookie: "session=secret",
        Authorization: "Bearer secret",
        privatePath: "C:\\Users\\qiany\\secret.json",
        note: "token=secret",
      },
    });
    timeline.record({ sessionId: "session-private-123", phase: "backend", type: "loading", source: "backend" });
    timeline.record({ sessionId: "session-private-123", phase: "buffer", type: "start", source: "backend" });
    timeline.record({ sessionId: "session-private-123", phase: "buffer", type: "end", source: "backend", durationMs: 240 });

    const snapshot = timeline.snapshot(playbackState());
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.map((event) => event.type)).toEqual(["loading", "start", "end"]);
    expect(snapshot.events[2]).toMatchObject({
      sessionId: expect.stringMatching(/^session-/),
      durationMs: 240,
      safeDetails: {},
    });
    expect(snapshot.events[2]?.sessionId).not.toContain("private-123");
    expect(serialized).not.toContain("private.example.invalid");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("C:\\Users\\qiany");
  });

  it("records playback stages in order without serializing the source URL", () => {
    const timeline = new PlaybackDebugTimeline({
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    const initial = playbackState();
    timeline.recordState(initial, "player", 1_000);

    const resolved = playbackState();
    resolved.playback.player.source = {
      parse: 0,
      url: "http://127.0.0.1:43123/__qx_playback/session/media.m3u8",
      headers: {},
    };
    resolved.playback.player.status = "playing";
    resolved.playback.player.parse = {
      status: "succeeded",
      parserId: "isolated-sniffer",
      attempts: [{ parserId: "fixture-parser", parserType: "json", status: "error", elapsedMs: 20 }],
      error: null,
    };
    timeline.recordState(resolved, null, 1_240);
    expect(timeline.snapshot(resolved).fallback).toBe("已发生");
    timeline.record({
      sessionId: "session-private-123",
      phase: "fallback",
      type: "line.switch",
      source: "fallback",
      safeDetails: { reason: "PLAYBACK_TIMEOUT", url: "http://127.0.0.1/private" },
    });

    const snapshot = timeline.snapshot(resolved);
    const types = snapshot.events.map((event) => event.type);
    expect(types).toContain("state.snapshot");
    expect(types).toContain("playerContent.available");
    expect(types).toContain("parse.succeeded");
    expect(types).toContain("sniff.used");
    expect(types).toContain("localProxy.bypassed");
    expect(types).toContain("backend.playing");
    expect(types).toContain("line.switch");
    expect(snapshot.sniff).toBe("已使用");
    expect(snapshot.backend).toBe("HTMLVideo/HLS");
    expect(snapshot.startupMs).toBe(240);
    expect(snapshot.fallback).toBe("已发生");
    expect(JSON.stringify(snapshot)).not.toContain("43123");
    expect(JSON.stringify(snapshot)).not.toContain("private-123");
  });

  it("exports only the safe snapshot as JSON and text", () => {
    const timeline = new PlaybackDebugTimeline({ now: () => new Date("2026-08-06T12:00:00.000Z") });
    const state = playbackState();
    timeline.recordState(state, "player", 10);
    const snapshot = timeline.snapshot(state);
    const json = formatPlaybackDebugJson(snapshot);
    const text = formatPlaybackDebugText(snapshot);

    expect(JSON.parse(json)).toMatchObject({ source: "inline:fixture", site: "fixture-site" });
    expect(text).toContain("Playback Session");
    expect(text).toContain("fixture-site");
    expect(text).not.toContain("private.example.invalid");
    expect(text).not.toContain("Cookie");
    expect(text).not.toContain("token=secret");
  });

  it("records stream-health and fallback events in the existing debug timeline", () => {
    const timeline = new PlaybackDebugTimeline();
    const state = playbackState();
    state.playback.health.events = [{
      sequence: 1,
      at: 1_000,
      type: "segment-failure",
      safeDetails: { reason: "连续分片错误" },
    }];
    state.playback.fallback = {
      ...state.playback.fallback,
      status: "prompt",
      trigger: "segment-errors",
      reason: "连续分片错误",
      next: { id: "line-1", label: "备用线路", kind: "healthier", healthScore: 88 },
    };
    timeline.recordState(state, null);

    const snapshot = timeline.snapshot(state);
    expect(snapshot.events.map((event) => event.type)).toContain("health.segment-failure");
    expect(snapshot.events.map((event) => event.type)).toContain("fallback.prompt");
    expect(JSON.stringify(snapshot)).not.toContain("line-1");
  });
});
