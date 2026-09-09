// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import EmbeddedPlayer from "../renderer/src/EmbeddedPlayer.vue";
import MediaGrid from "../renderer/src/MediaGrid.vue";
import PlaybackHealthPanel from "../renderer/src/PlaybackHealthPanel.vue";
import { createRendererState } from "../renderer/src/state.js";
import { DEFAULT_SOURCE_URL, shouldLoadDefaultSource } from "../renderer/src/default-source.js";
import { DEFAULT_DESKTOP_STATE, normalizeDesktopState } from "../src/desktop/state-persistence.js";

afterEach(() => vi.restoreAllMocks());

describe("cinema viewing experience", () => {
  it("starts dark and preserves an explicitly saved theme", () => {
    expect(DEFAULT_DESKTOP_STATE.theme).toBe("dark");
    expect(normalizeDesktopState({ version: 1, theme: "light" }).theme).toBe("light");
    expect(normalizeDesktopState({ version: 1, theme: "system" }).theme).toBe("system");
  });

  it("keeps subtitles and playback speed inside the fullscreen stage", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const state = createRendererState().playback.player;
    state.source = { parse: 0, url: "http://127.0.0.1/fixture.mp4", headers: {} };
    const player = mount(EmbeddedPlayer, { props: { state } });
    await flushPromises();
    const stage = player.get('[data-testid="embedded-player-stage"]');
    expect(stage.find('[data-testid="subtitle-track-panel"]').exists()).toBe(true);
    expect(stage.find('[data-action="subtitle-local-file"]').exists()).toBe(true);
    const video = stage.get<HTMLVideoElement>("video").element;
    await stage.get('[data-action="player-rate"]').setValue("1.5");
    expect(video.playbackRate).toBe(1.5);
    video.playbackRate = 1;
    await stage.get("video").trigger("loadedmetadata");
    expect(video.playbackRate).toBe(1.5);
    player.unmount();
  });

  it("does not emit idle progress when a resolving placeholder fails and unmounts", () => {
    const state = createRendererState().playback.player;
    const player = mount(EmbeddedPlayer, { props: { state } });
    player.unmount();
    expect(player.emitted("sync")).toBeUndefined();
  });

  it("keeps fallback approval outside collapsed diagnostics", async () => {
    const state = createRendererState().playback;
    const panel = mount(PlaybackHealthPanel, { props: {
      compact: true, health: state.health, fallback: { ...state.fallback, status: "prompt" },
    } });
    expect(panel.get("details").attributes("open")).toBeUndefined();
    const approve = panel.get('[data-action="playback-fallback-approve"]');
    expect(approve.element.closest("details")).toBeNull();
    await approve.trigger("click");
    expect(panel.emitted("approve")).toHaveLength(1);
    panel.unmount();
  });

  it("distinguishes failed loading from empty results and keeps content while refreshing", async () => {
    const grid = mount(MediaGrid, { props: { items: [], loading: true, failed: false, page: "search" } });
    expect(grid.attributes("aria-busy")).toBe("true");
    expect(grid.find('[data-testid="empty-state"]').exists()).toBe(false);
    await grid.setProps({ loading: false, failed: true } as any);
    expect(grid.find('[data-testid="empty-state"]').exists()).toBe(false);
    await grid.setProps({ failed: false } as any);
    expect(grid.text()).toContain("没有找到匹配内容");
    await grid.setProps({ items: [{ vod_id: "1", vod_name: "保留的内容" }], loading: true } as any);
    expect(grid.get('[data-testid="vod-card"]').text()).toContain("保留的内容");
    grid.unmount();
  });
});

describe("default desktop source", () => {
  const fresh = { desktop: true, ready: true, status: "empty", savedSource: null, persistenceError: false, requested: false, playerWindow: false };
  it("uses the requested address once on a fresh desktop", () => {
    expect(DEFAULT_SOURCE_URL).toBe("http://xn--z7x900a.net/");
    expect(shouldLoadDefaultSource(fresh)).toBe(true);
  });
  it.each([
    { savedSource: "https://example.test/mine.json" }, { persistenceError: true },
    { requested: true }, { playerWindow: true }, { status: "cancelled" },
    { ready: false }, { desktop: false },
  ])("does not overwrite or repeat a user session: %j", (override) => {
    expect(shouldLoadDefaultSource({ ...fresh, ...override })).toBe(false);
  });
});
