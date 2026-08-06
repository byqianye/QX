// @vitest-environment jsdom

import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import PlaybackDebugPanel from "../renderer/src/PlaybackDebugPanel.vue";
import SpiderView from "../renderer/src/SpiderView.vue";
import type { PlaybackDebugSnapshot } from "../renderer/src/playback-debug.js";
import { createRendererState, type RendererState } from "../renderer/src/state.js";

function snapshot(): PlaybackDebugSnapshot {
  return {
    source: "inline:fixture",
    engine: "csp_PlayableFixture",
    site: "fixture-site",
    playbackSession: "session-1234abcd",
    line: "主线",
    episode: "第一集",
    playerContent: "已返回媒体地址",
    parse: "succeeded · fixture-parser",
    rules: "已应用",
    sniff: "未使用",
    localProxy: "未要求",
    backend: "HTMLVideo/HLS",
    startupMs: 240,
    buffering: "1 次 · 120 ms",
    error: "无",
    fallback: "未发生",
    capability: "可播放 · 引擎在线",
    events: [{
      timestamp: "2026-08-06T12:00:00.000Z",
      sessionId: "session-1234abcd",
      phase: "backend",
      type: "backend.playing",
      source: "backend",
      safeDetails: {},
    }],
  };
}

function rendererState(error = false): RendererState {
  const state = createRendererState();
  state.import.status = "ready";
  state.import.sessionReady = true;
  state.import.selectedSiteKey = "fixture-site";
  state.spider.source = "inline:fixture";
  state.spider.api = "csp_PlayableFixture";
  state.spider.status = error ? "error" : "ready";
  state.spider.sidecarRunning = true;
  state.browse.page = "detail";
  state.detail.canPlay = true;
  state.detail.playbackCatalog = {
    lines: [{ index: 0, name: "主线", episodes: [{ index: 0, name: "第一集", id: "episode-1" }] }],
  };
  state.detail.playbackSelection = { lineIndex: 0, episodeIndex: 0 };
  state.playback.player.source = { parse: 0, url: "http://127.0.0.1:43123/media/fixture.m3u8", headers: {} };
  state.playback.player.status = error ? "error" : "playing";
  state.playback.session = {
    id: "session-private-1",
    host: "embedded",
    lineIndex: 0,
    episodeIndex: 0,
    lineName: "主线",
    episodeName: "第一集",
    media: { detailId: "vod-private-1", title: "Fixture", url: "http://127.0.0.1:43123/media/fixture.m3u8" },
  };
  if (error) {
    state.error.error = {
      code: "MPV_TIMEOUT",
      title: "mpv playback timeout",
      message: "mpv did not respond",
      source: "player",
      retryable: true,
      diagnosticId: "diag-12345678",
      timestamp: "2026-08-06T12:00:00.000Z",
      safeDetails: {},
    };
  }
  return state;
}

describe("playback debug panel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all fields and copies/exports only the safe snapshot", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const createObjectUrl = vi.fn(() => "blob:debug");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const wrapper = mount(PlaybackDebugPanel, { props: { snapshot: snapshot() } });

    expect(wrapper.findAll("[data-debug-field]")).toHaveLength(17);
    expect(wrapper.get('[data-debug-field="playbackSession"]').text()).toContain("session-1234abcd");
    expect(wrapper.get('[data-testid="playback-debug-timeline"]').text()).toContain("backend.playing");

    await wrapper.get('[data-action="copy-playback-debug"]').trigger("click");
    expect(writeText).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="playback-debug-action-status"]').text()).toContain("已复制");
    await wrapper.get('[data-action="export-playback-debug-json"]').trigger("click");
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("opens with D, ignores D from inputs, and supports settings/error entries", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    const wrapper = mount(SpiderView, {
      props: { state: rendererState(), pending: null, lineIndex: 0, order: "forward" },
    });
    expect(wrapper.find('[data-testid="playback-debug-panel"]').exists()).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-testid="playback-debug-panel"]').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-testid="playback-debug-panel"]').exists()).toBe(false);

    const search = wrapper.get("#search-key");
    await search.trigger("focus");
    search.element.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-testid="playback-debug-panel"]').exists()).toBe(false);

    await wrapper.get('[data-action="settings"]').trigger("click");
    await nextTick();
    await wrapper.get('[data-action="open-playback-debug"]').trigger("click");
    expect(wrapper.find('[data-testid="playback-debug-panel"]').exists()).toBe(true);
    wrapper.unmount();

    const errorWrapper = mount(SpiderView, {
      props: { state: rendererState(true), pending: null, lineIndex: 0, order: "forward" },
    });
    const debugButtons = errorWrapper.findAll('[data-action="open-playback-debug"]');
    expect(debugButtons.length).toBeGreaterThan(0);
    await debugButtons[0]!.trigger("click");
    expect(errorWrapper.find('[data-testid="playback-debug-panel"]').exists()).toBe(true);
    errorWrapper.unmount();
  });
});
