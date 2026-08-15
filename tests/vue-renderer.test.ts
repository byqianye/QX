// @vitest-environment jsdom

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, nextTick, ref } from "vue";
import Hls from "hls.js";
import type { ManifestParsedData } from "hls.js";

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
  type PlayerState,
} from "../renderer/src/state.js";
import App from "../renderer/src/App.vue";
import CategoryTabs from "../renderer/src/CategoryTabs.vue";
import EmbeddedPlayer from "../renderer/src/EmbeddedPlayer.vue";
import CastPanel from "../renderer/src/CastPanel.vue";
import MediaCard from "../renderer/src/MediaCard.vue";
import DetailDrawer from "../renderer/src/DetailDrawer.vue";
import ConfirmDialog from "../renderer/src/ConfirmDialog.vue";
import PlaybackSelector from "../renderer/src/PlaybackSelector.vue";
import PlayerControls from "../renderer/src/PlayerControls.vue";
import PlayerWindow from "../renderer/src/PlayerWindow.vue";
import SpiderView from "../renderer/src/SpiderView.vue";
import SourceSwitcher from "../renderer/src/SourceSwitcher.vue";
import TopSearchBar from "../renderer/src/TopSearchBar.vue";
import { displaySource } from "../renderer/src/safe-display.js";
import LiveSourcesView from "../renderer/src/LiveSourcesView.vue";
import { EMPTY_LIVE_UI_STATE, type LiveUiState } from "../src/live/live-types.js";
import { EMPTY_DANMAKU_UI_STATE } from "../src/danmaku/danmaku-types.js";
import type { CastUiState } from "../src/cast/cast-types.js";

const shakaMocks = vi.hoisted(() => ({
  installAll: vi.fn(),
  isBrowserSupported: vi.fn(() => true),
  load: vi.fn(async () => undefined),
  getVariantTracks: vi.fn(() => [] as Array<{ id: number; height: number; bandwidth: number }>),
  getTextTracks: vi.fn(() => [] as Array<{ id: number; language: string; label: string | null; forced: boolean; active: boolean; kind: string | null }>),
  configure: vi.fn(),
  selectVariantTrack: vi.fn(),
  selectTextTrack: vi.fn(),
  destroy: vi.fn(async () => undefined),
}));

vi.mock("shaka-player", () => {
  class MockPlayer {
    public static isBrowserSupported(): boolean {
      return shakaMocks.isBrowserSupported();
    }

    public constructor(_element: HTMLVideoElement) {}

    public addEventListener(): void {}

    public load(...args: Parameters<typeof shakaMocks.load>): ReturnType<typeof shakaMocks.load> {
      return shakaMocks.load(...args);
    }

    public getVariantTracks(): ReturnType<typeof shakaMocks.getVariantTracks> {
      return shakaMocks.getVariantTracks();
    }

    public getTextTracks(): ReturnType<typeof shakaMocks.getTextTracks> {
      return shakaMocks.getTextTracks();
    }

    public configure(...args: Parameters<typeof shakaMocks.configure>): ReturnType<typeof shakaMocks.configure> {
      return shakaMocks.configure(...args);
    }

    public selectVariantTrack(...args: Parameters<typeof shakaMocks.selectVariantTrack>): ReturnType<typeof shakaMocks.selectVariantTrack> {
      return shakaMocks.selectVariantTrack(...args);
    }

    public selectTextTrack(...args: Parameters<typeof shakaMocks.selectTextTrack>): ReturnType<typeof shakaMocks.selectTextTrack> {
      return shakaMocks.selectTextTrack(...args);
    }

    public destroy(...args: Parameters<typeof shakaMocks.destroy>): ReturnType<typeof shakaMocks.destroy> {
      return shakaMocks.destroy(...args);
    }
  }

  return {
    default: {
      polyfill: { installAll: shakaMocks.installAll },
      Player: MockPlayer,
    },
  };
});

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

  it("normalizes sparse Tauri desktop list snapshots", () => {
    const envelope = readyEnvelope();
    envelope.state = {
      ...envelope.state!,
      localMedia: { folders: [], items: [{ id: "local-1" }] } as unknown as NonNullable<RendererEnvelope["state"]>["localMedia"],
      downloads: {} as NonNullable<RendererEnvelope["state"]>["downloads"],
    } as unknown as NonNullable<RendererEnvelope["state"]>;

    expect(() => applyRendererEnvelope(createRendererState(), envelope)).not.toThrow();
  });

  it("renders the local media page and emits opaque media actions", async () => {
    const state = createRendererState();
    state.localMedia = {
      ...state.localMedia,
      ready: true,
      items: [{
        id: "local-item-1",
        pathIdentity: "local-file:local-item-1",
        fileReference: "local-file:local-item-1",
        displayName: "fixture.mp4",
        extension: "mp4",
        size: 12,
        modifiedAt: 1,
        mediaType: "video",
        createdAt: 1,
        updatedAt: 1,
        missing: false,
        rootId: null,
        subtitleTracks: [],
      }],
    };
    const wrapper = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialNavigation: "local" },
    });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="local-media-page"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="local-media-page"]')).toBeTruthy();
    await wrapper.get('[data-action="local-open-file"]').trigger("click");
    expect(wrapper.emitted("localOpenFile")).toEqual([[]]);
    await wrapper.get('[data-testid="local-media-list"] .button-primary').trigger("click");
    expect(wrapper.emitted("localPlay")).toEqual([["local-item-1", undefined]]);
  });

  it("renders DLNA discovery and session controls with device status", async () => {
    const device = {
      deviceId: "uuid:fixture-renderer",
      friendlyName: "Fixture TV",
      location: "http://127.0.0.1:43123/description.xml",
      model: "Fixture Model",
      manufacturer: "Fixture Manufacturer",
      lastSeen: 1,
      capabilities: {
        setAvTransportUri: true,
        play: true,
        pause: true,
        stop: true,
        seek: true,
        getTransportInfo: true,
        getPositionInfo: true,
      },
    };
    const cast: CastUiState = {
      discoveryStatus: "ready",
      devices: [device],
      session: {
        device,
        media: { title: "Fixture Movie", contentType: "video/mp4" },
        state: "playing",
        startedAt: 1,
        lastPosition: 42,
        error: null,
      },
      error: null,
    };
    const wrapper = mount(CastPanel, { props: { state: cast, pending: null } });

    expect(wrapper.get('[data-testid="cast-discovery-status"]').text()).toBe("Devices");
    expect(wrapper.get('[data-testid="cast-devices"]').text()).toContain("Fixture TV");
    expect(wrapper.get('[data-testid="cast-session"]').text()).toContain("Playing");
    const searching = mount(CastPanel, {
      props: { state: { ...cast, discoveryStatus: "searching", session: null }, pending: null },
    });
    expect(searching.get('[data-testid="cast-discovery-status"]').text()).toBe("Searching");
    const error = mount(CastPanel, {
      props: {
        state: { ...cast, discoveryStatus: "error", session: null, error: { code: "DLNA_TIMEOUT", message: "timeout" } },
        pending: null,
      },
    });
    expect(error.get('[data-testid="cast-discovery-status"]').text()).toBe("Error");
    expect(error.get('[data-testid="cast-error"]').text()).toContain("DLNA_TIMEOUT");
    await wrapper.get('[data-action="cast-discover"]').trigger("click");
    await wrapper.get('[data-action="cast-device-uuid:fixture-renderer"]').trigger("click");
    await wrapper.get('[data-action="cast-stop"]').trigger("click");
    await wrapper.get('[data-action="cast-disconnect"]').trigger("click");
    expect(wrapper.emitted("discover")).toEqual([[]]);
    expect(wrapper.emitted("cast")).toEqual([["uuid:fixture-renderer"]]);
    expect(wrapper.emitted("stop")).toEqual([[]]);
    expect(wrapper.emitted("disconnect")).toEqual([[]]);
  });

  it("offers history removal without guessing a missing local file", async () => {
    const state = createRendererState();
    state.localMedia = {
      ...state.localMedia,
      ready: true,
      items: [{
        id: "missing-local-item",
        pathIdentity: "local-file:missing-local-item",
        fileReference: "local-file:missing-local-item",
        displayName: "missing.mp4",
        extension: "mp4",
        size: 12,
        modifiedAt: 1,
        mediaType: "video",
        createdAt: 1,
        updatedAt: 1,
        missing: true,
        rootId: null,
        subtitleTracks: [],
      }],
    };
    state.history = {
      paused: false,
      items: [{
        identity: "local-history-1",
        sourceId: "local-source",
        vodId: "missing-local-item",
        seasonId: null,
        episodeId: "missing-local-item",
        title: "missing.mp4",
        poster: null,
        episode: null,
        episodeName: "missing.mp4",
        playbackLine: "本地媒体",
        position: 12,
        duration: 100,
        updatedAt: 1,
        completed: false,
        sourceDisplayName: "本地媒体",
        sourceType: "local",
      }],
    };
    const wrapper = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialNavigation: "local" },
    });
    await vi.waitFor(() => expect(wrapper.find('[data-action="local-remove-history"]').exists()).toBe(true));
    await wrapper.get('[data-action="local-remove-history"]').trigger("click");
    expect(wrapper.emitted("localRemoveHistory")).toEqual([["local-history-1"]]);
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

  it("keeps search empty state actionable and renders the configured site name", async () => {
    const state = createRendererState();
    state.ready = true;
    state.import.status = "ready";
    state.import.sessionReady = true;
    state.import.selectedSiteKey = "douban";
    state.import.sites = [{ key: "douban", name: "豆瓣影视", api: "csp_Douban" }];
    state.spider.source = "inline:fixture";
    state.spider.api = "csp_Douban";
    state.spider.status = "ready";
    state.browse.page = "search";
    state.browse.items = [];

    const wrapper = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward" },
    });

    expect(wrapper.get('[data-testid="source-switcher"]').text()).toContain("豆瓣影视");
    expect(wrapper.get('[data-testid="app-sidebar"]').text()).toContain("豆瓣影视");
    expect(wrapper.get(".workspace-header h1").text()).toBe("豆瓣影视");
    expect(wrapper.text()).not.toContain("csp_Douban");
    expect(wrapper.get('[data-testid="empty-state"]').text()).toContain("没有找到匹配内容");
    expect(wrapper.get('[data-testid="empty-state"] .button-secondary').text()).toBe("清除搜索");
    await wrapper.get('[data-testid="empty-state"] .button-secondary').trigger("click");
    expect(wrapper.emitted("home")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps internal source API keys out of user-facing source context", () => {
    const topSearch = mount(TopSearchBar, {
      props: { source: "inline:fixture", sourceName: "豆瓣影视", api: "csp_Douban", pending: false },
    });
    const switcher = mount(SourceSwitcher, {
      props: { source: "inline:fixture", sourceName: "豆瓣影视", api: "csp_Douban", status: "ready", pending: false },
    });

    expect(topSearch.get('[data-testid="source-context"]').text()).toBe("来源豆瓣影视");
    expect(switcher.get('[data-testid="source-switcher"]').text()).not.toContain("csp_Douban");

    topSearch.unmount();
    switcher.unmount();
  });

  it("traps focus in ConfirmDialog and restores the triggering focus", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const dialog = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { title: "删除来源", message: "确认删除吗？", danger: true },
    });
    await nextTick();
    const buttons = dialog.findAll("button");
    expect(document.activeElement).toBe(buttons[0]!.element);

    buttons[1]!.element.focus();
    await buttons[1]!.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]!.element);
    buttons[0]!.element.focus();
    await buttons[0]!.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons[1]!.element);

    dialog.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
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
    expect(wrapper.get('[data-testid="first-launch-guide"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="first-launch-guide"]').text()).not.toMatch(/本地媒体|Jellyfin|Emby/u);
    await wrapper.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="desktop-spider-ui"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="search-form"]')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/import/confirm", expect.objectContaining({ method: "POST" }));
    wrapper.unmount();
  });

  it("enters the Spider renderer when confirmation succeeds but the first source request fails", async () => {
    const initial = readyEnvelope();
    initial.import = {
      ...initial.import!,
      status: "confirmation_required",
      warning: "Confirm this import",
      trusted: false,
      sessionReady: false,
    };
    initial.state = null;
    const confirmed = readyEnvelope();
    confirmed.state = { ...confirmed.state!, page: "home", items: [], sidecarRunning: true };
    confirmed.error = "SourceUnavailable: SOURCE_SESSION_REQUEST_FAILED";
    confirmed.errorCode = "SOURCE_SESSION_REQUEST_FAILED";
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": initial,
      "/api/import/confirm": confirmed,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? confirmed,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="desktop-spider-ui"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="error-state"]').text()).toContain("SOURCE_SESSION_REQUEST_FAILED");
    expect((fetchMock.mock.calls as unknown as Array<[string]>).map(([path]) => path)).not.toContain("/api/open");
    wrapper.unmount();
  });

  it("shows the local startup splash until the initial state is ready", async () => {
    let resolveState!: (response: { ok: boolean; json: () => Promise<RendererEnvelope> }) => void;
    const fetchMock = vi.fn(() => new Promise<{ ok: boolean; json: () => Promise<RendererEnvelope> }>((resolve) => {
      resolveState = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await Promise.resolve();
    expect(wrapper.get('[data-testid="launch-splash"]')).toBeTruthy();

    resolveState({ ok: true, json: async () => readyEnvelope() });
    await flushPromises();
    expect(wrapper.find('[data-testid="launch-splash"]').exists()).toBe(false);
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
    await flushPromises();

    expect(wrapper.get('[data-testid="vue-renderer"]').attributes("data-theme")).toBe("dark");
    expect(wrapper.get('[data-testid="desktop-spider-ui"]').attributes("data-theme")).toBe("dark");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="epg-sources"]').exists()).toBe(true));
    expect(wrapper.findAll('[data-testid="settings-section"]')).toHaveLength(8);
    expect(wrapper.get('[data-testid="about-panel"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="cache-management"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="storage-management"]')).toBeTruthy();
    expect((wrapper.get("#search-key").element as HTMLInputElement).value).toBe("蜘蛛侠");
    expect(wrapper.get('[data-testid="diagnostic-panel"]').text()).toContain("STATE_PERSISTENCE_CORRUPT");

    await wrapper.get('[data-action="theme-mode"]').setValue("light");
    await flushPromises();
    expect((fetchMock.mock.calls as unknown as Array<[string]>).some(([path]) => path === "/api/view-state")).toBe(true);
    await wrapper.get('[data-action="cache-refresh"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="cache-clear-all"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="storage-open"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="storage-switch-portable"]').trigger("click");
    await flushPromises();
    await wrapper.get('[role="dialog"] .button-primary').trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/api/cache/refresh", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/cache/clear", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ scope: "all" }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/storage/open", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/storage/switch", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ mode: "portable", confirmed: true }),
    }));
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

  it("opens a freshly confirmed source before the first browse request", async () => {
    const initial = readyEnvelope();
    initial.import = {
      ...initial.import!,
      status: "confirmation_required",
      trusted: false,
      warning: "需要确认",
      sessionReady: false,
    };
    initial.state = null;
    const confirmed = readyEnvelope();
    confirmed.state = { ...confirmed.state!, status: "idle", sidecarRunning: false, items: [] };
    const opened = readyEnvelope();
    const home = readyEnvelope();
    home.state = { ...home.state!, items: [{ vod_id: "msearch:first-home", vod_name: "Fresh Home" }] };
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": initial,
      "/api/import/confirm": confirmed,
      "/api/open": opened,
      "/api/home": home,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? home,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const calledPaths = (fetchMock.mock.calls as unknown as Array<[string]>).map(([path]) => path);
    expect(calledPaths).toContain("/api/open");
    expect(calledPaths).toContain("/api/home");
    expect(wrapper.get('[data-testid="vod-list"]').text()).toContain("Fresh Home");
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

  it("uses the live line index when the parent selection has not caught up", () => {
    const selector = mount(PlaybackSelector, {
      props: {
        catalog: {
          lines: [
            { index: 0, name: "primary", episodes: [{ index: 0, name: "episode one", id: "episode-1" }] },
            { index: 1, name: "backup", episodes: [{ index: 0, name: "movie", id: "direct-mp4" }] },
          ],
        },
        selection: { lineIndex: 0, episodeIndex: 0 },
        lineIndex: 1,
        order: "forward",
        retryable: false,
      },
    });

    expect(selector.find('[data-testid="current-line"]').text()).toContain("backup");
    expect(selector.find('[data-action="playback-line"][data-line-index="1"]').attributes("aria-selected")).toBe("true");
    expect(selector.find('[data-play-id="direct-mp4"]').isVisible()).toBe(true);
    expect(selector.find('[data-play-id="episode-1"]').isVisible()).toBe(false);
    selector.unmount();
  });

  it("loads a playback source when the player was mounted before source resolution", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    const state = ref<PlayerState>({
      status: "idle",
      source: null,
      currentTime: 0,
      duration: 0,
      volume: 1,
      muted: false,
      fullscreen: false,
      error: null,
    });
    const player = mount({
      setup: () => () => h(EmbeddedPlayer, { state: state.value }),
    });

    expect(player.find('[data-testid="embedded-player"]').exists()).toBe(false);
    state.value = {
      status: "loading",
      source: { parse: 0, url: "http://127.0.0.1/video.mp4", headers: {} },
      currentTime: 0,
      duration: 0,
      volume: 1,
      muted: false,
      fullscreen: false,
      error: null,
    };
    await nextTick();
    await flushPromises();

    const video = player.get<HTMLVideoElement>('[data-testid="embedded-player"]');
    expect(video.element.getAttribute("src")).toBe("http://127.0.0.1/video.mp4");
    player.unmount();
  });

  it("clears a stale startup error when the media element starts playing", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    const player = mount(EmbeddedPlayer, {
      props: {
        state: {
          status: "error",
          source: { parse: 0, url: "http://127.0.0.1/video.mp4", headers: {} },
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: { code: "PLAYBACK_STARTUP_TIMEOUT", message: "起播超时" },
        },
      },
    });

    const video = player.get<HTMLVideoElement>("[data-testid=embedded-player]");
    video.element.dispatchEvent(new Event("playing"));
    await nextTick();

    expect(player.get('[data-testid="player-status"]').text()).toContain("播放中");
    expect(player.find('[data-testid="player-error"]').exists()).toBe(false);
    player.unmount();
  });

  it("uses Hls.js for HLS sources when native canPlayType reports maybe", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(Hls, "isSupported").mockReturnValue(true);
    const loadSource = vi.spyOn(Hls.prototype, "loadSource").mockImplementation(() => undefined);
    const attachMedia = vi.spyOn(Hls.prototype, "attachMedia").mockImplementation(() => undefined);
    const player = mount(EmbeddedPlayer, {
      props: {
        state: {
          status: "loading",
          source: { parse: 0, url: "http://127.0.0.1:43123/video.m3u8", headers: {}, mediaType: "hls" },
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: null,
        },
      },
    });
    await nextTick();
    await flushPromises();

    const video = player.get<HTMLVideoElement>("[data-testid=embedded-player]");
    expect(loadSource).toHaveBeenCalledWith("http://127.0.0.1:43123/video.m3u8");
    expect(attachMedia).toHaveBeenCalledWith(video.element);
    expect(video.element.crossOrigin).toBe("anonymous");
    expect(video.element.getAttribute("src")).toBeNull();
    player.unmount();
  });

  it("switches Hls.js variants and returns to automatic quality selection", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(Hls, "isSupported").mockReturnValue(true);
    vi.spyOn(Hls.prototype, "destroy").mockImplementation(() => undefined);
    vi.spyOn(Hls.prototype, "loadSource").mockImplementation(function (this: Hls) {
      Object.defineProperty(this, "levels", {
        configurable: true,
        value: [
          { height: 360, bitrate: 600_000 },
          { height: 720, bitrate: 1_800_000 },
        ],
      });
      this.emit(Hls.Events.MANIFEST_PARSED, Hls.Events.MANIFEST_PARSED, {
        levels: this.levels,
      } as ManifestParsedData);
    });
    const currentLevel = vi.spyOn(Hls.prototype, "currentLevel", "set");
    const player = mount(EmbeddedPlayer, {
      props: {
        state: {
          status: "loading",
          source: { parse: 0, url: "http://127.0.0.1:43123/video.m3u8", headers: {}, mediaType: "hls" },
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: null,
        },
      },
    });
    await nextTick();
    await flushPromises();

    const quality = player.get<HTMLSelectElement>('[data-action="player-quality"]');
    expect([...quality.element.options].map((option) => option.value)).toEqual(["auto", "0", "1"]);
    await quality.setValue("1");
    expect(currentLevel).toHaveBeenLastCalledWith(1);
    await quality.setValue("auto");
    expect(currentLevel).toHaveBeenLastCalledWith(-1);
    player.unmount();
  });

  it("switches Shaka variants and toggles ABR for automatic quality", async () => {
    shakaMocks.getVariantTracks.mockReturnValue([
      { id: 10, height: 360, bandwidth: 600_000 },
      { id: 20, height: 720, bandwidth: 1_800_000 },
    ]);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const player = mount(EmbeddedPlayer, {
      props: {
        state: {
          status: "loading",
          source: { parse: 0, url: "http://127.0.0.1:43123/video.mpd", headers: {}, mediaType: "dash" },
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: null,
        },
      },
    });
    await nextTick();
    await flushPromises();

    const quality = player.get<HTMLSelectElement>('[data-action="player-quality"]');
    expect([...quality.element.options].map((option) => option.value)).toEqual(["auto", "10", "20"]);
    await quality.setValue("20");
    expect(shakaMocks.configure).toHaveBeenCalledWith({ abr: { enabled: false } });
    expect(shakaMocks.selectVariantTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 20 }),
      true,
    );
    await quality.setValue("auto");
    expect(shakaMocks.configure).toHaveBeenLastCalledWith({ abr: { enabled: true } });
    player.unmount();
  });

  it("exposes Shaka text tracks and delegates subtitle selection to Shaka", async () => {
    shakaMocks.getVariantTracks.mockReturnValue([]);
    shakaMocks.getTextTracks.mockReturnValue([
      { id: 31, language: "en", label: "English", forced: false, active: false, kind: "subtitles" },
      { id: 32, language: "fr", label: "Français", forced: false, active: false, kind: "subtitles" },
    ]);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const player = mount(EmbeddedPlayer, {
      props: {
        state: {
          status: "loading",
          source: { parse: 0, url: "http://127.0.0.1:43123/video.mpd", headers: {}, mediaType: "dash" },
          currentTime: 0,
          duration: 0,
          volume: 1,
          muted: false,
          fullscreen: false,
          error: null,
        },
      },
    });
    await nextTick();
    await flushPromises();

    const subtitles = player.get<HTMLSelectElement>('[data-action="subtitle-track"]');
    expect([...subtitles.element.options].map((option) => option.textContent)).toEqual(["关闭", "English", "Français"]);
    await subtitles.setValue("shaka-32");
    expect(shakaMocks.selectTextTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 32, language: "fr" }));
    await subtitles.setValue("");
    expect(shakaMocks.selectTextTrack).toHaveBeenLastCalledWith(undefined);
    player.unmount();
  });

  it("exposes an automatic quality option and emits a selected quality", async () => {
    const controls = mount(PlayerControls, {
      props: {
        currentTime: 0,
        duration: 60,
        volume: 1,
        muted: false,
        qualityId: "auto",
        qualityOptions: [
          { id: "auto", label: "自动" },
          { id: "0", label: "360p" },
          { id: "1", label: "720p" },
        ],
      },
    });

    const quality = controls.get<HTMLSelectElement>('[data-action="player-quality"]');
    expect(quality.element.value).toBe("auto");
    await quality.setValue("1");
    expect(controls.emitted("quality")).toEqual([["1"]]);
    controls.unmount();
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
    const vodCard = card.get('[data-testid="vod-card"]');
    expect(vodCard.attributes("role")).toBe("button");
    expect(vodCard.attributes("tabindex")).toBe("0");
    expect(card.find('[data-action="detail"]').exists()).toBe(false);
    await vodCard.trigger("click");
    await vodCard.trigger("keydown", { key: "Enter" });
    await vodCard.trigger("keydown", { key: " " });
    expect(card.emitted("open")).toEqual([["long-title"], ["long-title"], ["long-title"]]);

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

  it("renders a media poster when vod_pic is present", () => {
    const card = mount(MediaCard, {
      props: {
        item: {
          vod_id: "poster-1",
          vod_name: "Poster fixture",
          vod_pic: "https://image.example.invalid/poster.jpg",
        },
      },
    });

    const poster = card.get('[data-testid="vod-poster"]');
    expect(poster.element.tagName).toBe("IMG");
    expect(poster.attributes("src")).toBe("https://image.example.invalid/poster.jpg");
    expect(poster.attributes("alt")).toBe("Poster fixture 海报");
  });

  it("uses the shared detail poster fallback and lets the user select a playback source", async () => {
    const drawer = mount(DetailDrawer, {
      props: {
        detail: { vod_id: "meta-1", vod_name: "欢迎来龙餐厅" },
        canPlay: false,
        playbackLabel: "Douban：无正片播放源",
        canSearchPlayback: true,
        playbackSources: null,
        playbackSourcePending: false,
      },
    });

    expect(drawer.find('[data-testid="detail-poster"]').exists()).toBe(false);
    expect(drawer.find(".detail-cover span").text()).toBe("欢");
    await drawer.get('[data-action="find-playback-source"]').trigger("click");
    expect(drawer.emitted("findPlaybackSource")).toEqual([[]]);

    drawer.unmount();
    const selectedDrawer = mount(DetailDrawer, {
      props: {
        detail: { vod_id: "meta-1", vod_name: "欢迎来龙餐厅" },
        canPlay: false,
        playbackLabel: "Douban：无正片播放源",
        canSearchPlayback: true,
        playbackSources: {
        query: "欢迎来龙餐厅",
        searchedSites: ["playable"],
        successfulSites: ["playable"],
        failedSites: [],
        diagnostics: {
          configSiteCount: 2,
          searchableSites: 1,
          runtimeSupportedSites: 1,
          unsupportedSiteCount: 0,
          searchedSites: ["playable"],
          searchSuccessSites: ["playable"],
          searchFailedSites: [],
          searchResultCount: 1,
          matchedCandidateCount: 1,
          detailSuccessCount: 1,
          playableCandidateCount: 1,
          sites: [],
        },
        candidates: [{
          siteKey: "playable",
          siteName: "Playable",
          vod: { id: "play-1", name: "欢迎来龙餐厅", raw: {}, vod_id: "play-1" },
          score: 140,
          playable: true,
          hasPlayFrom: true,
          hasPlayUrl: true,
        }],
        },
        playbackSourcePending: false,
      },
    });
    await selectedDrawer.get('[data-action="playback-source-select"]').trigger("click");
    expect(selectedDrawer.emitted("selectPlaybackSource")).toEqual([["playable", "play-1"]]);
    selectedDrawer.unmount();

    const emptyDrawer = mount(DetailDrawer, {
      props: {
        detail: { vod_id: "meta-1", vod_name: "欢迎来龙餐厅" },
        canPlay: false,
        playbackLabel: "Douban：无正片播放源",
        canSearchPlayback: true,
        playbackSources: {
          query: "欢迎来龙餐厅",
          searchedSites: [],
          successfulSites: [],
          failedSites: [],
          diagnostics: {
            configSiteCount: 5,
            searchableSites: 4,
            runtimeSupportedSites: 1,
            unsupportedSiteCount: 3,
            searchedSites: [],
            searchSuccessSites: [],
            searchFailedSites: [],
            searchResultCount: 0,
            matchedCandidateCount: 0,
            detailSuccessCount: 0,
            playableCandidateCount: 0,
            sites: [],
          },
          candidates: [],
        },
        playbackSourcePending: false,
      },
    });
    expect(emptyDrawer.find('[data-testid="playback-source-empty"]').exists()).toBe(true);
    expect(emptyDrawer.find('[data-testid="playback-source-diagnostics"]').text()).toContain("多数来源因当前 Spider Runtime 尚未支持而被跳过");
    emptyDrawer.unmount();
  });

  it("falls back after a detail poster request fails", async () => {
    const drawer = mount(DetailDrawer, {
      props: {
        detail: { vod_id: "poster-1", vod_name: "Poster fixture", vod_pic: "http://127.0.0.1/poster.jpg" },
        canPlay: false,
        playbackLabel: "无播放源",
      },
    });

    await drawer.get('[data-testid="detail-poster"]').trigger("error");
    expect(drawer.find('[data-testid="detail-poster"]').exists()).toBe(false);
    expect(drawer.find(".detail-cover span").text()).toBe("P");
    drawer.unmount();
  });

  it("renders the Open Design desktop shell and recoverable playback states", async () => {
    const envelope = formalDesignEnvelope();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => envelope }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(App);
    await flushPromises();
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
    expect(wrapper.findAll('[data-action$="-placeholder"]')).toHaveLength(0);
    expect(wrapper.get('[data-action="live-sources"]')).toBeTruthy();
    expect(wrapper.get('[data-action="history"]')).toBeTruthy();
    expect(wrapper.get('[data-action="favorites"]')).toBeTruthy();
    expect(wrapper.get('[data-action="downloads"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="detail-drawer"]').text()).toContain("导演");
    await wrapper.get('[data-action="settings"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="settings-section"]').length).toBeGreaterThanOrEqual(5);
    expect(wrapper.get('[data-testid="epg-sources"]')).toBeTruthy();
    expect(wrapper.get('[data-action="epg-source-preview"]')).toBeTruthy();
    expect(wrapper.find('[data-testid="media-grid"]').exists()).toBe(false);
    const themeMode = wrapper.get('[data-action="theme-mode"]');
    await themeMode.setValue("dark");
    expect(wrapper.get('[data-testid="desktop-spider-ui"]').attributes("data-theme")).toBe("dark");
    await themeMode.setValue("system");
    expect(wrapper.get('[data-testid="desktop-spider-ui"]').attributes("data-theme-mode")).toBe("system");
    await wrapper.get('[data-action="live-sources"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="live-sources"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="live-sources"]')).toBeTruthy();
    expect(wrapper.get('[data-action="live-source-preview"]')).toBeTruthy();
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

  it("renders Smart Channels and emits management intents", async () => {
    const state: LiveUiState = {
      ...EMPTY_LIVE_UI_STATE,
      catalog: {
        groups: [],
        recent: [],
        channels: [
          {
            id: "live-a",
            sourceId: "source-a",
            sourceName: "Source A",
            name: "News",
            group: null,
            logo: null,
            channelNumber: null,
            streamCount: 1,
            streams: [{ id: "stream-a", label: "Main", protocol: "HLS", status: "ready" }],
            epgStatus: "unmapped",
            currentProgramme: null,
            nextProgramme: null,
            health: null,
          },
          {
            id: "live-b",
            sourceId: "source-b",
            sourceName: "Source B",
            name: "News",
            group: null,
            logo: null,
            channelNumber: null,
            streamCount: 1,
            streams: [{ id: "stream-b", label: "Main", protocol: "HLS", status: "ready" }],
            epgStatus: "unmapped",
            currentProgramme: null,
            nextProgramme: null,
            health: null,
          },
        ],
      },
      smartSuggestions: [{
        id: "suggestion-news",
        name: "News",
        memberIds: ["live-a", "live-b"],
        reason: "exact-tvg-id",
        confidence: "exact",
      }],
      smartChannels: [{
        id: "smart-news",
        name: "News Smart",
        logo: null,
        group: "Favorites",
        sortOrder: 0,
        preferredMemberId: "member-a",
        currentMemberId: "member-a",
        currentSourceName: "Source A",
        available: true,
        members: [
          {
            id: "member-a",
            smartChannelId: "smart-news",
            liveChannelId: "live-a",
            priority: 0,
            enabled: true,
            channelName: "News",
            sourceName: "Source A",
            available: true,
            healthScore: 90,
          },
          {
            id: "member-b",
            smartChannelId: "smart-news",
            liveChannelId: "live-b",
            priority: 1,
            enabled: true,
            channelName: "News",
            sourceName: "Source B",
            available: true,
            healthScore: null,
          },
        ],
        epg: {
          mode: "unmapped",
          sourceId: null,
          channelId: null,
          sourceName: null,
          channelName: null,
          currentProgramme: null,
          nextProgramme: null,
        },
      }],
    };
    const wrapper = mount(LiveSourcesView, { props: { state, pending: null, danmaku: EMPTY_DANMAKU_UI_STATE } });

    await wrapper.get('[data-action="live-tab-smart"]').trigger("click");
    expect(wrapper.get('[data-testid="smart-channel-create"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="smart-channel-suggestions"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="smart-channel-list"]')).toBeTruthy();

    await wrapper.get('[data-action="smart-suggestion-create"]').trigger("click");
    expect(wrapper.emitted("smartCreate")).toEqual([[
      { name: "News", group: null, memberIds: ["live-a", "live-b"] },
    ]]);
    await wrapper.get('input[type="number"]').setValue("7");
    expect(wrapper.emitted("smartMemberUpdate")).toEqual([[
      { smartChannelId: "smart-news", memberId: "member-a", priority: 7 },
    ]]);
    await wrapper.get('[data-action="smart-channel-play"]').trigger("click");
    expect(wrapper.emitted("smartPlay")).toEqual([[
      { smartChannelId: "smart-news", memberId: "member-a" },
    ]]);
    await wrapper.get('[data-action="smart-channel-member-enable"]').trigger("click");
    expect(wrapper.emitted("smartMemberUpdate")).toEqual([
      [{ smartChannelId: "smart-news", memberId: "member-a", priority: 7 }],
      [{ smartChannelId: "smart-news", memberId: "member-a", enabled: false }],
    ]);
    wrapper.unmount();
  });

  it("renders live health details and failover actions", async () => {
    const candidate = {
      id: "live:channel-a:line-1",
      channelId: "channel-a",
      streamId: "line-1",
      sourceId: "source-a",
      sourceName: "Source A",
      channelName: "News",
      streamLabel: "线路 1",
      memberId: null,
      smartChannelId: null,
      healthScore: 42,
    };
    const state: LiveUiState = {
      ...EMPTY_LIVE_UI_STATE,
      health: {
        streamId: "line-1",
        sourceId: "source-a",
        startupSuccess: { value: true, samples: 1 },
        firstFrameMs: { value: 320, samples: 1 },
        playlistRefreshFailure: { value: 0, samples: 1 },
        segmentFailure: { value: 2, samples: 2 },
        bufferCount: { value: 1, samples: 1 },
        bufferDuration: { value: 9_000, samples: 1 },
        fatalError: { value: 0, samples: 1 },
        disconnectCount: { value: 0, samples: 1 },
        uptimeMs: { value: 10_000, samples: 1 },
        lastSuccessAt: 1_000,
        lastFailureAt: 2_000,
        consecutiveFailures: 2,
        score: 42,
        scoreReasons: ["segment failures 2"],
        cooldownUntil: 3_000,
      },
      failover: {
        ...EMPTY_LIVE_UI_STATE.failover,
        status: "prompt",
        trigger: "segment-errors",
        reason: "连续分片失败",
        current: candidate,
        next: { ...candidate, id: "live:channel-a:line-2", streamId: "line-2", streamLabel: "线路 2" },
        attempts: 0,
        maxAttempts: 3,
        tried: [candidate.id],
        manualOverrideUntil: 4_000,
      },
    };
    const wrapper = mount(LiveSourcesView, { props: { state, pending: null, danmaku: EMPTY_DANMAKU_UI_STATE } });

    expect(wrapper.get('[data-testid="live-health-summary"]').text()).toContain("评分 42");
    expect(wrapper.get('[data-testid="live-failover-prompt"]').text()).toContain("连续分片失败");
    expect(wrapper.get('[data-testid="live-debug-panel"]').text()).toContain("Manual override");
    await wrapper.get('[data-action="live-failover-mode"]').setValue("auto");
    await wrapper.get('[data-action="live-failover-approve"]').trigger("click");
    await wrapper.get('[data-action="live-failover-cancel"]').trigger("click");
    await wrapper.get('[data-action="live-failover-stay"]').trigger("click");
    await wrapper.get('[data-action="live-failover-return"]').trigger("click");
    expect(wrapper.emitted("failoverMode")).toEqual([["auto"]]);
    expect(wrapper.emitted("failoverApprove")).toHaveLength(1);
    expect(wrapper.emitted("failoverCancel")).toHaveLength(1);
    expect(wrapper.emitted("failoverStay")).toHaveLength(1);
    expect(wrapper.emitted("failoverReturn")).toHaveLength(1);
    wrapper.unmount();
  });

  it("renders the formal history page and confirms destructive actions", async () => {
    const envelope = readyEnvelope();
    envelope.state = {
      ...envelope.state!,
      history: {
        paused: false,
        items: [{
          identity: "history-1",
          sourceId: "source-1",
          vodId: "vod-1",
          seasonId: null,
          episodeId: "episode-1",
          title: "Fixture history",
          poster: null,
          episode: 1,
          episodeName: "第一集",
          playbackLine: "主线",
          position: 42,
          duration: 100,
          updatedAt: Date.now(),
          completed: false,
          sourceDisplayName: "Fixture source",
        }],
      },
    };
    const state = applyRendererEnvelope(createRendererState(), envelope);
    const wrapper = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialNavigation: "history" },
    });

    expect(wrapper.get('[data-testid="history-page"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="history-list"]').text()).toContain("Fixture history");
    await wrapper.get('[data-action="history-delete-progress"]').trigger("click");
    expect(wrapper.get('[data-testid="history-confirm"]')).toBeTruthy();
    await wrapper.get('[data-action="history-confirm"]').trigger("click");
    expect(wrapper.emitted("historyDeleteProgress")).toEqual([["history-1"]]);
    await wrapper.get('[data-action="history-delete"]').trigger("click");
    expect(wrapper.get('[data-testid="history-confirm"]')).toBeTruthy();
    await wrapper.get('[data-action="history-confirm"]').trigger("click");
    expect(wrapper.emitted("historyDelete")).toEqual([["history-1"]]);
    wrapper.unmount();

    const browseEnvelope = formalDesignEnvelope();
    const history = envelope.state?.history;
    if (!history) throw new Error("Expected history state");
    browseEnvelope.state = {
      ...browseEnvelope.state!,
      history,
      historyResume: {
        ...history.items[0]!,
        lineIndex: 0,
        episodeIndex: 0,
        lineName: "主线",
        canResume: true,
      },
    };
    const browseState = applyRendererEnvelope(createRendererState(), browseEnvelope);
    const browse = mount(SpiderView, {
      props: { state: browseState, pending: null, lineIndex: 0, order: "forward" },
    });
    expect(browse.get('[data-testid="history-resume-prompt"]')).toBeTruthy();
    expect(browse.get('[data-action="history-resume"]')).toBeTruthy();
    expect(browse.get('[data-action="history-beginning"]')).toBeTruthy();
    expect(browse.get('[data-action="history-delete-progress"]')).toBeTruthy();
    expect(browseState.playback.player.currentTime).toBe(0);
    browse.unmount();
  });

  it("renders localhost Push settings, explicit confirmation, and LAN boundary", async () => {
    const envelope = readyEnvelope();
    envelope.state = {
      ...envelope.state!,
      push: {
        ...createRendererState().push,
        enabled: true,
        listening: true,
        configuredPort: 0,
        port: 43123,
        endpoint: "http://127.0.0.1:43123/push",
        pending: [{
          id: "push-confirm-1",
          type: "url",
          title: "Fixture Push",
          targetHost: "media.example.test",
          requestedBy: "localhost",
          createdAt: 1,
        }],
        recent: [{
          id: "push-confirm-1",
          type: "url",
          title: "Fixture Push",
          status: "pending-confirmation",
          requestedBy: "localhost",
          createdAt: 1,
          sessionId: null,
          error: null,
        }],
      },
    };
    const state = applyRendererEnvelope(createRendererState(), envelope);
    const wrapper = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialNavigation: "settings" },
    });

    expect(wrapper.get('[data-testid="push-settings"]').text()).toContain("127.0.0.1:43123/push");
    expect(wrapper.get('[data-testid="push-pending-list"]').text()).toContain("Fixture Push");
    expect(wrapper.text()).toContain("Requires G68 LAN Control");
    await wrapper.get('[data-action="push-confirm-push-confirm-1"]').trigger("click");
    expect(wrapper.emitted("pushConfirm")).toEqual([["push-confirm-1"]]);
    await wrapper.get('[data-action="push-clear"]').trigger("click");
    expect(wrapper.emitted("pushClear")).toHaveLength(1);
    wrapper.unmount();
  });

  it("renders favorites, group actions, source availability, and detail favorite controls", async () => {
    const envelope = readyEnvelope();
    envelope.state = {
      ...envelope.state!,
      favorites: {
        defaultGroupId: "default",
        groups: [
          { groupId: "default", name: "默认收藏", sortOrder: 0, createdAt: 1, updatedAt: 1, count: 2 },
          { groupId: "group-1", name: "周末观看", sortOrder: 1, createdAt: 1, updatedAt: 1, count: 0 },
        ],
        items: [
          {
            favoriteId: "favorite-1",
            sourceId: "source-a",
            vodId: "vod-1",
            title: "Fixture favorite",
            poster: null,
            year: "2026",
            category: "电影",
            sourceName: "Fixture source",
            groupId: "default",
            sortOrder: 0,
            metadata: null,
            addedAt: 1,
            updatedAt: 1,
            sourceAvailable: true,
            recentWatchedAt: null,
          },
          {
            favoriteId: "favorite-2",
            sourceId: "source-b",
            vodId: "vod-2",
            title: "Unavailable favorite",
            poster: null,
            year: null,
            category: null,
            sourceName: "Other source",
            groupId: "default",
            sortOrder: 1,
            metadata: null,
            addedAt: 2,
            updatedAt: 2,
            sourceAvailable: false,
            recentWatchedAt: null,
          },
        ],
      },
    };
    const state = applyRendererEnvelope(createRendererState(), envelope);
    const wrapper = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialNavigation: "favorites" },
    });

    expect(wrapper.get('[data-testid="favorites-page"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="favorites-list"]').text()).toContain("Fixture favorite");
    await wrapper.get('[data-action="favorite-group-create"]').trigger("click");
    expect(wrapper.emitted("favoriteCreateGroup")).toBeUndefined();
    await wrapper.get('[data-testid="favorite-group-name"]').setValue("新分组");
    await wrapper.get('[data-action="favorite-group-create"]').trigger("click");
    expect(wrapper.emitted("favoriteCreateGroup")).toEqual([["新分组"]]);
    await wrapper.get('[data-action="favorite-open"]').trigger("click");
    expect(wrapper.emitted("favoriteOpen")).toEqual([["favorite-1"]]);
    await wrapper.get('[data-action="favorite-move"]').setValue("group-1");
    expect(wrapper.emitted("favoriteMove")).toEqual([[{ favoriteId: "favorite-1", groupId: "group-1" }]]);
    await wrapper.findAll('.favorites-group-button')[1]!.trigger("click");
    await wrapper.get('[aria-label="重命名分组"]').setValue("周末精选");
    await wrapper.get('[data-action="favorite-group-rename"]').trigger("click");
    expect(wrapper.emitted("favoriteRenameGroup")).toEqual([[{ groupId: "group-1", name: "周末精选" }]]);
    await wrapper.get('[data-action="favorite-group-delete"]').trigger("click");
    await wrapper.get('[data-action="favorite-confirm"]').trigger("click");
    expect(wrapper.emitted("favoriteDeleteGroup")).toEqual([[{ groupId: "group-1", disposition: undefined }]]);
    await wrapper.findAll('.favorites-group-button')[0]!.trigger("click");
    await wrapper.get('[data-action="favorite-delete"]').trigger("click");
    await wrapper.get('[data-action="favorite-confirm"]').trigger("click");
    expect(wrapper.emitted("favoriteDelete")).toEqual([["favorite-1"]]);
    await wrapper.get('[data-action="favorite-search"]').trigger("click");
    expect(wrapper.emitted("search")).toEqual([["Unavailable favorite"]]);
    expect(wrapper.find('[data-testid="favorites-page"]').exists()).toBe(false);
    wrapper.unmount();

    const browse = mount(SpiderView, {
      props: {
        state: applyRendererEnvelope(createRendererState(), {
          ...envelope,
          state: { ...envelope.state!, detail: { vod_id: "vod-1", vod_name: "Fixture favorite" }, favoriteDetail: state.favorites.items[0] ?? null },
        }),
        pending: null,
        lineIndex: 0,
        order: "forward",
      },
    });
    await browse.get('[data-action="favorite-toggle-detail"]').trigger("click");
    expect(browse.emitted("favoriteToggle")).toHaveLength(1);
    browse.unmount();
  });

  it("renders follow updates, source failures, badges, and detail follow actions", async () => {
    const envelope = readyEnvelope();
    envelope.state = {
      ...envelope.state!,
      page: "detail",
      detail: { vod_id: "vod-1", vod_name: "Fixture follow" },
      follow: {
        checking: false,
        updateCount: 1,
        items: [
          {
            identity: "follow-1",
            sourceId: "source-a",
            vodId: "vod-1",
            title: "Fixture follow",
            poster: null,
            latestEpisodeId: "episode-2",
            latestEpisodeName: "Episode 2",
            watchedEpisodeId: "episode-1",
            watchedEpisodeName: "Episode 1",
            knownEpisodeCount: 2,
            lastCheckedAt: 2,
            lastUpdatedAt: 2,
            updateAvailable: true,
            checkError: null,
            enabled: true,
            sourceAvailable: true,
            status: "updated",
          },
          {
            identity: "follow-2",
            sourceId: "source-b",
            vodId: "vod-2",
            title: "Unavailable follow",
            poster: null,
            latestEpisodeId: "episode-1",
            latestEpisodeName: "Episode 1",
            watchedEpisodeId: "episode-1",
            watchedEpisodeName: "Episode 1",
            knownEpisodeCount: 1,
            lastCheckedAt: null,
            lastUpdatedAt: 1,
            updateAvailable: false,
            checkError: "SOURCE_CIRCUIT_OPEN",
            enabled: true,
            sourceAvailable: false,
            status: "error",
          },
        ],
      },
      followDetail: null,
    };
    const state = applyRendererEnvelope(createRendererState(), envelope);
    const follow = mount(SpiderView, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialNavigation: "follow" },
    });

    expect(follow.get('[data-testid="follow-page"]')).toBeTruthy();
    expect(follow.get('[data-testid="follow-list"]').text()).toContain("Fixture follow");
    expect(follow.get('[data-testid="follow-list"]').text()).toContain("SOURCE_CIRCUIT_OPEN");
    expect(follow.get('[data-action="follow-refresh"]')).toBeTruthy();
    expect(follow.get('[data-action="follow-mark-watched"]')).toBeTruthy();
    expect(follow.get('[data-action="follow-delete"]')).toBeTruthy();
    await follow.get('[data-action="follow-refresh"]').trigger("click");
    expect(follow.emitted("followRefresh")).toHaveLength(1);
    await follow.get('[data-action="follow-open"]').trigger("click");
    expect(follow.emitted("followOpen")).toEqual([["follow-1"]]);
    await follow.get('[data-action="follow-mark-watched"]').trigger("click");
    expect(follow.emitted("followMarkWatched")).toEqual([["follow-1"]]);
    await follow.get('[data-action="follow-delete"]').trigger("click");
    await follow.get('[data-action="follow-confirm"]').trigger("click");
    expect(follow.emitted("followDelete")).toEqual([["follow-1"]]);
    follow.unmount();

    const detailState = applyRendererEnvelope(createRendererState(), {
      ...envelope,
      state: {
        ...envelope.state!,
        follow: { items: [], checking: false, updateCount: 0 },
        followDetail: null,
      },
    });
    const detail = mount(SpiderView, {
      props: { state: detailState, pending: null, lineIndex: 0, order: "forward" },
    });
    await detail.get('[data-action="follow-toggle-detail"]').trigger("click");
    expect(detail.emitted("followToggle")).toHaveLength(1);
    await detail.get('[data-action="follow-and-favorite-detail"]').trigger("click");
    expect(detail.emitted("followAndFavorite")).toHaveLength(1);
    detail.unmount();
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
      cache: { totalBytes: 0, maxBytes: 512 * 1024 * 1024, entries: 0, byType: [] },
      storage: { mode: "normal", dataRoot: "…/user-data", normalRoot: "…/user-data", portableRoot: "…/data", databaseBytes: 0, cacheBytes: 0, totalBytes: 0, historyCount: 0, favoritesCount: 0, followCount: 0, writable: true, switching: false, error: null },
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
