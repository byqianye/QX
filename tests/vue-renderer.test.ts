// @vitest-environment jsdom

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSpiderSessionPort, DesktopSpiderView } from "../src/desktop/spider-ui.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
} from "../src/desktop/spider-ui.js";
import type { SpiderResponse } from "../src/spider/rpc.js";
import {
  applyRendererEnvelope,
  createRendererState,
  type RendererEnvelope,
} from "../renderer/src/state.js";
import App from "../renderer/src/App.vue";
import EmbeddedPlayer from "../renderer/src/EmbeddedPlayer.vue";
import PlaybackSelector from "../renderer/src/PlaybackSelector.vue";

describe("Vue renderer", () => {
  const servers: DesktopSpiderUiServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (servers.length > 0) await servers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps the API envelope into typed import, spider, browse, detail, playback and error state", () => {
    const envelope: RendererEnvelope = {
      import: {
        status: "ready",
        loading: false,
        inputKind: "json",
        source: "inline:fixture",
        sourceKind: "inline",
        warning: null,
        error: null,
        trusted: true,
        summary: null,
        sites: [{ key: "douban", name: "Douban", api: "csp_Douban" }],
        selectedSiteKey: "douban",
        selectedApi: "csp_Douban",
        sessionReady: true,
      },
      state: {
        page: "detail",
        source: "inline:fixture",
        api: "csp_PlayableFixture",
        status: "error",
        loading: false,
        warning: null,
        error: { code: "PLAYBACK_UPSTREAM_ERROR", message: "播放失败" },
        sidecarRunning: true,
        playback: {
          available: true,
          label: "Playable source",
          message: "resolved",
          parse: 0,
          url: "http://127.0.0.1:43123/media/fixture.m3u8",
          headers: {},
        },
        player: {
          status: "error",
          source: null,
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: { code: "PLAYBACK_UPSTREAM_ERROR", message: "播放失败" },
        },
        canPlay: true,
        items: [{ vod_id: "fixture:movie-1", vod_name: "Fixture" }],
        detail: { vod_id: "fixture:movie-1", vod_name: "Fixture" },
        playbackCatalog: {
          lines: [{
            index: 0,
            name: "主线",
            episodes: [{ index: 0, name: "第一集", id: "episode-1" }],
          }],
        },
        playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      },
    };

    const state = applyRendererEnvelope(createRendererState(), envelope);

    expect(state).toMatchObject({
      ready: true,
      import: { status: "ready", selectedApi: "csp_Douban" },
      spider: { status: "error", api: "csp_PlayableFixture", sidecarRunning: true },
      browse: { page: "detail", items: [{ vod_id: "fixture:movie-1" }] },
      detail: { detail: { vod_id: "fixture:movie-1" }, playbackSelection: { lineIndex: 0, episodeIndex: 0 } },
      playback: { playback: { available: true }, player: { status: "error" } },
      error: { error: { code: "PLAYBACK_UPSTREAM_ERROR" } },
    });

    const codedError = applyRendererEnvelope(createRendererState(), {
      state: null,
      error: "PLAYBACK_FORMAT_INVALID: playback selection index is invalid",
      errorCode: "PLAYBACK_FORMAT_INVALID",
    });
    expect(codedError.error.error).toEqual({
      code: "PLAYBACK_FORMAT_INVALID",
      message: "PLAYBACK_FORMAT_INVALID: playback selection index is invalid",
    });
  });

  it("serves the Vue artifact with a local-only script CSP and local assets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-vue-renderer-"));
    directories.push(directory);
    writeFileSync(join(directory, "index.html"), "<!doctype html><div id=app>Vue renderer</div>", "utf8");
    mkdirAsset(directory, "index.js", "console.log('local renderer');");

    const ui = new DesktopSpiderUiController({ session: new RendererFixtureSession() });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture",
      rendererDirectory: directory,
    });
    servers.push(server);
    await server.start();

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
    expect(await page.text()).toContain("Vue renderer");

    const asset = await fetch(new URL("/index.js", server.url));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("local renderer");
  });

  it("mounts the import/trust flow and switches to the Spider renderer", async () => {
    const ready = readyEnvelope();
    const responses: RendererEnvelope[] = [
      {
        import: {
          ...ready.import!,
          status: "confirmation_required",
          warning: "Confirm this import",
          trusted: false,
          sessionReady: false,
        },
        state: null,
      },
      ready,
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? ready,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[data-testid="config-import-form"]')).toBeTruthy();
    await wrapper.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="desktop-spider-ui"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="search-form"]')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/import/confirm", expect.objectContaining({ method: "POST" }));
    wrapper.unmount();
  });

  it("renders selectable lines, episodes and the complete embedded-player control surface", async () => {
    const selector = mount(PlaybackSelector, {
      props: {
        catalog: {
          lines: [
            { index: 0, name: "主线", episodes: [{ index: 0, name: "第一集", id: "episode-1" }] },
            { index: 1, name: "备用线", episodes: [{ index: 0, name: "电影", id: "direct-mp4" }] },
          ],
        },
        selection: null,
        order: "forward",
        retryable: false,
      },
    });
    expect(selector.find('[data-play-id="direct-mp4"]').exists()).toBe(true);
    await selector.find('[data-play-id="episode-1"]').trigger("click");
    expect(selector.emitted("episode")).toEqual([[0, 0]]);

    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    const player = mount(EmbeddedPlayer, {
      props: {
        state: {
          status: "loading",
          source: { parse: 0, url: "http://127.0.0.1/video.mp4", headers: {} },
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: null,
        },
      },
    });
    expect(player.get('[data-testid="player-seek"]')).toBeTruthy();
    expect(player.get('[data-testid="player-time"]')).toBeTruthy();
    expect(player.get('[data-action="player-mute"]').text()).toContain("静音");
    await player.get('[data-action="player-mute"]').trigger("click");
    expect(player.get('[data-action="player-mute"]').text()).toContain("取消静音");
    player.unmount();
    selector.unmount();
  });
});

function readyEnvelope(): RendererEnvelope {
  return {
    import: {
      status: "ready",
      loading: false,
      inputKind: "json",
      source: "inline:fixture",
      sourceKind: "inline",
      warning: null,
      error: null,
      trusted: true,
      summary: null,
      sites: [{ key: "douban", name: "Douban", api: "csp_Douban" }],
      selectedSiteKey: "douban",
      selectedApi: "csp_Douban",
      sessionReady: true,
    },
    state: {
      page: "home",
      source: "inline:fixture",
      api: "csp_Douban",
      status: "ready",
      loading: false,
      warning: null,
      error: null,
      sidecarRunning: true,
      playback: { available: false, label: "Douban：无正片播放源", message: "no playback" },
      player: {
        status: "idle",
        source: null,
        currentTime: 0,
        duration: 0,
        volume: 1,
        muted: false,
        fullscreen: false,
        error: null,
      },
      canPlay: false,
      items: [{ vod_id: "msearch:home", vod_name: "Fixture" }],
      detail: null,
      playbackCatalog: null,
      playbackSelection: null,
    },
  };
}

function mkdirAsset(directory: string, name: string, content: string): void {
  writeFileSync(join(directory, name), content, "utf8");
}

class RendererFixtureSession implements DesktopSpiderSessionPort {
  public view: DesktopSpiderView = {
    source: "inline:fixture",
    api: "csp_Douban",
    status: "confirmation_required",
    warning: "Confirm this import",
    error: null,
    sidecarRunning: false,
    playback: {
      available: false,
      label: "Douban：无正片播放源",
      message: "no playback",
    },
  };

  public confirmImport(): void {
    this.view.status = "idle";
    this.view.warning = null;
  }

  public async open(): Promise<SpiderResponse> {
    this.view.status = "ready";
    this.view.sidecarRunning = true;
    return { id: "fixture", ok: true, result: { initialized: true } };
  }

  public async homeContent(): Promise<SpiderResponse> {
    return { id: "fixture", ok: true, result: { list: [] } };
  }

  public async categoryContent(): Promise<SpiderResponse> {
    return { id: "fixture", ok: true, result: { list: [] } };
  }

  public async searchContent(): Promise<SpiderResponse> {
    return { id: "fixture", ok: true, result: { list: [] } };
  }

  public async detailContent(): Promise<SpiderResponse> {
    return { id: "fixture", ok: true, result: { list: [] } };
  }

  public async playerContent(): Promise<SpiderResponse> {
    return { id: "fixture", ok: true, result: { parse: 0, url: "" } };
  }

  public async destroy(): Promise<void> {
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}
