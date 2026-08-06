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
import CategoryTabs from "../renderer/src/CategoryTabs.vue";
import EmbeddedPlayer from "../renderer/src/EmbeddedPlayer.vue";
import MediaCard from "../renderer/src/MediaCard.vue";
import PlaybackSelector from "../renderer/src/PlaybackSelector.vue";
import PlayerWindow from "../renderer/src/PlayerWindow.vue";
import SpiderView from "../renderer/src/SpiderView.vue";
import { displaySource } from "../renderer/src/safe-display.js";

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
    expect(codedError.error.error).toMatchObject({
      code: "PLAYBACK_FORMAT_INVALID",
      message: "PLAYBACK_FORMAT_INVALID: playback selection index is invalid",
      title: "播放信息格式无效",
      source: "player",
      retryable: false,
    });
    expect(codedError.error.error?.diagnosticId).toMatch(/^diag-/);
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

  it("redacts source addresses before they reach user-facing context", () => {
    expect(displaySource("https://media.example/internal/path?token=secret")).toBe("https://media.example/…");
    expect(displaySource("inline:fixture")).toBe("inline:fixture");
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

  it("restores persisted theme, settings navigation and search context", async () => {
    const envelope = readyEnvelope();
    envelope.persistence = {
      theme: "dark",
      navigation: "settings",
      siteKey: null,
      category: { typeId: "hot_gaia", page: 2 },
      search: { key: "蜘蛛侠", page: 3 },
      scrollTop: 240,
      recentDetailId: null,
      diagnostic: { code: "STATE_PERSISTENCE_CORRUPT", message: "已回退安全默认值" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => envelope }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get('[data-testid="desktop-spider-ui"]').attributes("data-theme")).toBe("dark");
    expect(wrapper.findAll('[data-testid="settings-section"]')).toHaveLength(6);
    expect((wrapper.get("#search-key").element as HTMLInputElement).value).toBe("蜘蛛侠");
    expect(wrapper.get('[data-testid="diagnostic-panel"]').text()).toContain("STATE_PERSISTENCE_CORRUPT");

    await wrapper.get('[data-action="theme-mode"]').setValue("light");
    await flushPromises();
    expect((fetchMock.mock.calls as unknown as Array<[string]>).some(([path]) => path === "/api/view-state")).toBe(true);
    wrapper.unmount();
  });

  it("keeps request failures actionable and copies the same redacted diagnostic", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network request failed");
    }));

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get('[data-testid="error-state"]').text()).toContain("界面请求失败");
    expect(wrapper.get('[data-action="error-retry"]')).toBeTruthy();
    await wrapper.get('[data-action="copy-diagnostic"]').trigger("click");
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain("RENDERER_REQUEST_ERROR");
    expect(wrapper.get('[data-testid="diagnostic-copy-status"]').text()).toContain("已复制");
    wrapper.unmount();
  });

  it("reopens a persisted search page only when the imported site key matches", async () => {
    const persisted = {
      theme: "light" as const,
      navigation: "search" as const,
      siteKey: "douban",
      category: { typeId: "hot_gaia", page: 2 },
      search: { key: "蜘蛛侠", page: 3 },
      scrollTop: 0,
      recentDetailId: null,
    };
    const initial = readyEnvelope();
    initial.import = {
      ...initial.import!,
      status: "confirmation_required",
      trusted: false,
      warning: "需要确认",
      sessionReady: false,
    };
    initial.state = null;
    initial.persistence = persisted;
    const confirmed = readyEnvelope();
    confirmed.state = { ...confirmed.state!, status: "idle", page: "home" };
    confirmed.persistence = persisted;
    const opened = readyEnvelope();
    opened.persistence = persisted;
    const searched = readyEnvelope();
    searched.state = {
      ...searched.state!,
      page: "search",
      items: [{ vod_id: "msearch:restored", vod_name: "恢复后的搜索结果" }],
    };
    searched.persistence = persisted;
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": initial,
      "/api/import/confirm": confirmed,
      "/api/open": opened,
      "/api/search": searched,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? searched,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const calledPaths = (fetchMock.mock.calls as unknown as Array<[string]>).map(([path]) => path);
    expect(calledPaths).toContain("/api/open");
    expect(calledPaths).toContain("/api/search");
    expect(wrapper.get('[data-testid="vod-list"]').text()).toContain("恢复后的搜索结果");
    wrapper.unmount();
  });

  it("renders selectable lines, episodes and the complete embedded-player control surface", async () => {
    const selector = mount(PlaybackSelector, {
      attachTo: document.body,
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

  it("moves the single player host without leaving an embedded video behind", async () => {
    const envelope = formalDesignEnvelope();
    envelope.state = {
      ...envelope.state!,
      player: {
        status: "paused",
        source: { parse: 0, url: "http://127.0.0.1/video.mp4", headers: {} },
        currentTime: 42,
        duration: 90,
        volume: 0.35,
        muted: true,
        fullscreen: false,
        error: null,
      },
      playerHost: "detached",
      playbackSession: {
        id: "session-1",
        host: "detached",
        lineIndex: 0,
        episodeIndex: 0,
        lineName: "主线路",
        episodeName: "正片",
        media: { detailId: "fixture:movie-1", title: "星际航线", url: "http://127.0.0.1/video.mp4" },
      },
    };
    const state = applyRendererEnvelope(createRendererState(), envelope);
    const main = mount(SpiderView, { props: { state, pending: null, lineIndex: 0, order: "forward" } });

    expect(main.get('[data-testid="detached-player-panel"]')).toBeTruthy();
    expect(main.find('[data-testid="embedded-player"]').exists()).toBe(false);
    expect(main.get('[data-testid="detached-player-status"]').text()).toContain("不会后台播放");
    await main.get('[data-action="player-attach"]').trigger("click");
    expect(main.emitted("playerAttach")).toHaveLength(1);
    main.unmount();

    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    const responses = [envelope, { ...envelope, state: { ...envelope.state!, playerHost: "embedded", playbackSession: { ...envelope.state!.playbackSession!, host: "embedded" } } }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input) === "/api/player/attach" ? responses[1] : responses[0],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const child = mount(PlayerWindow);
    await flushPromises();
    expect(child.get('[data-testid="player-window"]')).toBeTruthy();
    expect(child.get('[data-testid="player-window-line"]').text()).toContain("主线路");
    expect(child.get('[data-testid="embedded-player"]')).toBeTruthy();
    expect(child.get('[data-action="player-fullscreen"]')).toBeTruthy();
    await child.get('[data-action="player-attach"]').trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/api/player/attach", expect.objectContaining({ method: "POST" }));
    child.unmount();
  });

  it("keeps long titles, many episodes and keyboard focus reachable", async () => {
    const longTitle = "一部用于验证桌面工作台长标题布局的超长影视名称不会被业务层截断";
    const card = mount(MediaCard, {
      props: { item: { vod_id: "long-title", vod_name: longTitle } },
    });
    expect(card.text()).toContain(longTitle);

    const selector = mount(PlaybackSelector, {
      props: {
        catalog: {
          lines: [
            {
              index: 0,
              name: "主线路",
              protocol: "HLS",
              status: "ready",
              episodes: Array.from({ length: 48 }, (_, index) => ({
                index,
                name: `第${index + 1}集`,
                id: `episode-${index + 1}`,
              })),
            },
            { index: 1, name: "备用线", episodes: [] },
          ],
        },
        selection: { lineIndex: 0, episodeIndex: 0 },
        order: "forward",
        retryable: false,
      },
    });
    expect(selector.findAll('[data-action="player-episode"]')).toHaveLength(48);
    const lineTabs = selector.findAll('[data-action="playback-line"]');
    const lineFocus = vi.spyOn(lineTabs[1]!.element as HTMLElement, "focus");
    await lineTabs[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(selector.emitted("line")).toEqual([[1]]);
    expect(lineFocus).toHaveBeenCalledOnce();

    const categoryTabs = mount(CategoryTabs, { attachTo: document.body, props: { active: "home" } });
    const homeTab = categoryTabs.get('[data-action="home-tab"]');
    const categoryTab = categoryTabs.get('[data-action="category-tab"]');
    const categoryFocus = vi.spyOn(categoryTab.element as HTMLElement, "focus");
    await homeTab.trigger("keydown", { key: "ArrowRight" });
    expect(categoryTabs.emitted("select")).toEqual([["category"]]);
    expect(categoryFocus).toHaveBeenCalledOnce();

    categoryTabs.unmount();
    selector.unmount();
    card.unmount();
  });

  it("renders the Open Design desktop shell and recoverable playback states", async () => {
    const envelope = formalDesignEnvelope();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => envelope }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get('[data-testid="app-sidebar"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="top-search-bar"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="source-switcher"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="category-tabs"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="media-grid"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="detail-drawer"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="playback-selector"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="playback-lines"]').text()).toContain("HLS");
    expect(wrapper.findAll('[data-od-id]').length).toBeGreaterThan(10);
    expect(wrapper.find('[data-play-url]').exists()).toBe(false);
    expect(wrapper.findAll('[data-diagnostic-step]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-action$="-placeholder"]')).toHaveLength(5);
    expect(wrapper.get('[data-testid="detail-drawer"]').text()).toContain("导演");
    await wrapper.get('[data-action="settings"]').trigger("click");
    expect(wrapper.findAll('[data-testid="settings-section"]').length).toBeGreaterThanOrEqual(5);
    const themeMode = wrapper.get('[data-action="theme-mode"]');
    await themeMode.setValue("dark");
    expect(wrapper.get('[data-testid="desktop-spider-ui"]').attributes("data-theme")).toBe("dark");
    await themeMode.setValue("system");
    expect(wrapper.get('[data-testid="desktop-spider-ui"]').attributes("data-theme-mode")).toBe("system");
    wrapper.unmount();

    const proxyState = applyRendererEnvelope(createRendererState(), {
      ...envelope,
      state: {
        ...envelope.state!,
        error: { code: "PLAYBACK_PROXY_REQUIRED", message: "需要代理才能播放" },
      },
      errorCode: "PLAYBACK_PROXY_REQUIRED",
    });
    const proxy = mount(SpiderView, {
      props: { state: proxyState, pending: null, lineIndex: 0, order: "forward" },
    });
    expect(proxy.get('[data-testid="error-state"]').text()).toContain("需要代理才能播放");
    expect(proxy.find('[data-action="error-retry"]').exists()).toBe(false);
    expect(proxy.find('[data-action="copy-diagnostic"]').exists()).toBe(true);
    proxy.unmount();

    const unavailableState = applyRendererEnvelope(createRendererState(), {
      ...envelope,
      state: {
        ...envelope.state!,
        error: { code: "PLAYBACK_UNAVAILABLE", message: "当前线路暂时无法播放" },
      },
      errorCode: "PLAYBACK_UNAVAILABLE",
    });
    const unavailable = mount(SpiderView, {
      props: { state: unavailableState, pending: null, lineIndex: 0, order: "forward" },
    });
    expect(unavailable.get('[data-testid="error-state"]').text()).toContain("当前线路暂时无法播放");
    expect(unavailable.find('[data-action="switch-line"]').exists()).toBe(true);
    unavailable.unmount();
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

function formalDesignEnvelope(): RendererEnvelope {
  const envelope = readyEnvelope();
  envelope.state = {
    ...envelope.state!,
    api: "csp_PlayableFixture",
    items: [
      { vod_id: "fixture:movie-1", vod_name: "星际航线", vod_remarks: "MP4 · 电影" },
      { vod_id: "fixture:movie-2", vod_name: "城市放映室", vod_remarks: "HLS · 剧集" },
    ],
    detail: {
      vod_id: "fixture:movie-1",
      vod_name: "星际航线",
      vod_content: "受控播放测试媒体",
      vod_score: "8.2",
      vod_year: "2025",
      vod_area: "中国大陆",
      vod_class: "剧情",
      vod_director: "测试导演",
      vod_actor: "测试演员",
    },
    playbackCatalog: {
      lines: [
        { index: 0, name: "主线路", protocol: "HLS", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] },
      ],
    },
    playbackSelection: { lineIndex: 0, episodeIndex: 0 },
    canPlay: true,
  };
  return envelope;
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
