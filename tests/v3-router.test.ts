// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import App from "../renderer/src/App.vue";
import { RendererApi } from "../renderer/src/api.js";
import CoreShell from "../renderer/src/CoreShell.vue";
import { coreRoutes, router, ROUTER_ENABLED_KEY } from "../renderer/src/router.js";
import { createRendererState, type RendererEnvelope, type RendererState } from "../renderer/src/state.js";

function readyState(): RendererState {
  const state = createRendererState();
  state.ready = true;
  state.import = {
    ...state.import,
    status: "ready",
    trusted: true,
    sessionReady: true,
    selectedSiteKey: "source-a",
    selectedApi: "https://source.example.test/api",
    sites: [{ key: "source-a", name: "已授权来源", api: "https://source.example.test/api" }],
  };
  state.spider = {
    ...state.spider,
    source: "config-1",
    api: "https://source.example.test/api",
    status: "ready",
    sidecarRunning: true,
    capabilities: {
      home: true,
      category: true,
      search: true,
      detail: true,
      playback: true,
      localProxy: true,
      filters: true,
      pagination: true,
      engine: "http",
    },
  };
  state.browse = {
    categories: [],
    filters: [],
    page: "home",
    loading: false,
    items: [{ vod_id: "media-1", vod_name: "真实来源返回的媒体", vod_pic: null }],
  };
  return state;
}

function toEnvelope(state: RendererState): RendererEnvelope {
  return {
    import: state.import,
    state: {
      page: state.browse.page,
      source: state.spider.source,
      api: state.spider.api,
      status: state.spider.status,
      loading: state.browse.loading,
      warning: state.spider.warning,
      error: state.error.error,
      sidecarRunning: state.spider.sidecarRunning,
      capabilities: state.spider.capabilities,
      playback: state.playback.playback,
      player: state.playback.player,
      canPlay: state.detail.canPlay,
      items: state.browse.items,
      categories: state.browse.categories,
      filters: state.browse.filters,
      detail: state.detail.detail,
      playbackCatalog: state.detail.playbackCatalog,
      playbackSelection: state.detail.playbackSelection,
      playbackSources: state.playbackSources,
      playbackHealth: state.playback.health,
      fallback: state.playback.fallback,
      history: state.history,
      historyResume: state.historyResume,
      favorites: state.favorites,
      follow: state.follow,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function mountShell(state = readyState(), options: { attrs?: Record<string, unknown> } = {}) {
  await router.push({ name: "home" });
  await router.isReady();
  const mountingOptions = {
    props: {
      state,
      pending: null,
      lineIndex: 0,
      order: "forward",
    },
    global: { plugins: [router] },
    ...(options.attrs ? { attrs: options.attrs } : {}),
  };
  return mount(CoreShell, mountingOptions);
}

describe("V3 core router renderer", () => {
  beforeEach(async () => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: () => undefined });
    Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: () => undefined });
    await router.replace({ name: "home" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses window-internal routes for browse, search and source switching", async () => {
    const wrapper = await mountShell();

    expect(wrapper.get('[data-testid="core-app-shell"]').attributes("data-route")).toBe("home");
    expect(wrapper.get('[data-testid="core-app-shell"]').attributes("data-theme")).toBe("dark");
    expect(wrapper.find('[data-testid="source-switcher"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="source-context"]').text()).toContain("已授权来源");
    expect(wrapper.get('[data-testid="sidebar-source"]').text()).toContain("已授权来源");
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="sources"]').text()).toContain("来源中心");
    expect(wrapper.get('[data-testid="sidebar-source"][data-action="sidebar-source-status"]')).toBeTruthy();
    expect(wrapper.find('[data-testid="app-sidebar"] [data-action="open"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-sidebar"] [data-action="switch"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="core-browse-page"] .core-page-header')).toHaveLength(0);
    expect(wrapper.find('[data-testid="core-app-shell"] .workspace-header').exists()).toBe(false);
    expect(wrapper.find('[data-testid="core-recommendations"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="source-warning"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="home"]').classes()).toContain("selected");
    expect(wrapper.get('[data-testid="core-recommendations"]').text()).toContain("发现好内容");
    await wrapper.get('[data-action="category"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("category");

    await wrapper.get("#search-key").setValue("真实关键词");
    await wrapper.get('[data-action="search-form"]').trigger("submit");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("search");
    expect(router.currentRoute.value.query.q).toBe("真实关键词");
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="home"]').classes()).toContain("selected");

    await wrapper.get('[data-action="sources"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("sources");
    expect(wrapper.find('[data-testid="core-source-switch-page"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders a home source warning banner from spider.warning", async () => {
    const state = readyState();
    state.spider.warning = "肥猫主站暂不可达，已切换到可用来源。";
    const wrapper = await mountShell(state);
    expect(wrapper.get('[data-testid="source-warning"]').text()).toBe("肥猫主站暂不可达，已切换到可用来源。");
    wrapper.unmount();
  });

  it("shows only the latest continue-watching item for the same title", async () => {
    const state = readyState();
    state.history.items = [
      {
        identity: "source-a:media-1:episode-1",
        sourceId: "source-a",
        vodId: "media-1",
        seasonId: null,
        episodeId: "episode-1",
        title: "同一部剧",
        poster: null,
        episode: 1,
        episodeName: "第一集",
        playbackLine: "主线路",
        position: 12,
        duration: 100,
        updatedAt: 10,
        completed: false,
        sourceDisplayName: "已授权来源",
      },
      {
        identity: "source-a:media-1:episode-2",
        sourceId: "source-a",
        vodId: "media-1",
        seasonId: null,
        episodeId: "episode-2",
        title: "同一部剧",
        poster: null,
        episode: 2,
        episodeName: "第二集",
        playbackLine: "主线路",
        position: 34,
        duration: 100,
        updatedAt: 20,
        completed: false,
        sourceDisplayName: "已授权来源",
      },
      {
        identity: "source-a:media-2:episode-1",
        sourceId: "source-a",
        vodId: "media-2",
        seasonId: null,
        episodeId: "episode-1",
        title: "另一部剧",
        poster: null,
        episode: 1,
        episodeName: "第一集",
        playbackLine: "主线路",
        position: 8,
        duration: 100,
        updatedAt: 15,
        completed: false,
        sourceDisplayName: "已授权来源",
      },
    ];
    const wrapper = await mountShell(state);
    const cards = wrapper.findAll('[data-testid="core-continue-watching"] [data-action="core-continue-detail"]');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.text()).join(" ")).toContain("第二集");
    expect(cards.filter((card) => card.text().includes("同一部剧第一集"))).toHaveLength(0);
    wrapper.unmount();
  });

  it("groups search results by source and caps each source at five cards", async () => {
    const state = readyState();
    state.import.sites = [
      ...state.import.sites,
      { key: "source-b", name: "备用来源", api: "https://backup.example.test/api" },
    ];
    state.browse.page = "search";
    state.browse.items = [
      ...Array.from({ length: 7 }, (_, index) => ({
        vod_id: `source-a-${index + 1}`,
        vod_name: `来源 A 结果 ${index + 1}`,
        __qx_source_key: "source-a",
        __qx_source_name: "已授权来源",
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        vod_id: `source-b-${index + 1}`,
        vod_name: `来源 B 结果 ${index + 1}`,
        __qx_source_key: "source-b",
        __qx_source_name: "备用来源",
      })),
    ];
    const wrapper = await mountShell(state);
    await router.push({ name: "search", query: { q: "关键词" } });
    await flushPromises();

    const rows = wrapper.findAll('[data-testid="core-search-source-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.attributes("data-source-key")).toBe("source-a");
    expect(rows[0]?.findAll('[data-testid="vod-card"]')).toHaveLength(5);
    expect(rows[1]?.attributes("data-source-key")).toBe("source-b");
    expect(rows[1]?.findAll('[data-testid="vod-card"]')).toHaveLength(3);
    expect(wrapper.get('[data-testid="core-search-source-results"]').text()).toContain("已授权来源");
    expect(wrapper.get('[data-testid="core-search-source-results"]').text()).toContain("备用来源");
    wrapper.unmount();
  });

  it("deduplicates title variants within each search source", async () => {
    const state = readyState();
    state.import.sites = [
      ...state.import.sites,
      { key: "source-b", name: "备用来源", api: "https://backup.example.test/api" },
    ];
    state.browse.page = "search";
    state.browse.items = [
      { vod_id: "a-1", vod_name: "立刻播放 花开锦绣", __qx_source_key: "source-a", __qx_source_name: "已授权来源" },
      { vod_id: "a-2", vod_name: "花开锦绣2026", __qx_source_key: "source-a", __qx_source_name: "已授权来源" },
      { vod_id: "a-3", vod_name: "花开锦绣 [臻彩]", __qx_source_key: "source-a", __qx_source_name: "已授权来源" },
      { vod_id: "b-1", vod_name: "花开锦绣", __qx_source_key: "source-b", __qx_source_name: "备用来源" },
      { vod_id: "b-2", vod_name: "花开锦绣 4K", __qx_source_key: "source-b", __qx_source_name: "备用来源" },
    ];

    const wrapper = await mountShell(state);
    await router.push({ name: "search", query: { q: "花开锦绣" } });
    await flushPromises();

    const rows = wrapper.findAll('[data-testid="core-search-source-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.findAll('[data-testid="vod-card"]')).toHaveLength(1);
    expect(rows[1]?.findAll('[data-testid="vod-card"]')).toHaveLength(1);
    expect(rows[0]?.text()).toContain("立刻播放 花开锦绣");
    wrapper.unmount();
  });

  it("keeps the search field synchronized with the current route query", async () => {
    const wrapper = await mountShell();

    await router.push({ name: "search", query: { q: "第一组关键词" } });
    await flushPromises();
    expect((wrapper.get("#search-key").element as HTMLInputElement).value).toBe("第一组关键词");

    await router.push({ name: "search", query: { q: "第二组关键词" } });
    await flushPromises();
    expect((wrapper.get("#search-key").element as HTMLInputElement).value).toBe("第二组关键词");

    wrapper.unmount();
  });

  it("keeps the navigation rail fixed while allowing a focus view", async () => {
    const wrapper = await mountShell();

    const shell = wrapper.get('[data-testid="core-app-shell"]');
    const toggle = wrapper.get('[data-action="toggle-sidebar"]');
    expect(shell.classes()).not.toContain("sidebar-collapsed");
    expect(toggle.attributes("aria-expanded")).toBe("true");

    await toggle.trigger("click");
    expect(shell.classes()).toContain("sidebar-collapsed");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.attributes("aria-label")).toBe("显示侧栏");
    expect(wrapper.get('[data-testid="app-sidebar"]').attributes("aria-hidden")).toBe("true");
    expect(wrapper.get('[data-testid="app-sidebar"]').attributes("inert")).toBe("");

    await toggle.trigger("click");
    expect(shell.classes()).not.toContain("sidebar-collapsed");
    expect(wrapper.get('[data-testid="app-sidebar"]').attributes("aria-hidden")).toBeUndefined();
    wrapper.unmount();
  });

  it("renders legacy settings inside the CoreShell without duplicating navigation chrome", async () => {
    const wrapper = await mountShell();

    await router.push({ name: "legacy-settings" });
    await flushPromises();

    expect(wrapper.get('[data-testid="core-app-shell"]').attributes("data-route")).toBe("legacy-settings");
    expect(wrapper.get('[data-testid="desktop-spider-ui"]')).toBeTruthy();
    expect(wrapper.findAll('[data-testid="app-sidebar"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="top-search-bar"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="settings-advanced"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="settings"]').classes()).toContain("selected");

    wrapper.unmount();
  });

  it("keeps legacy local and download actions on the CoreShell event boundary", async () => {
    const downloadRefresh = vi.fn();
    const wrapper = await mountShell(readyState(), { attrs: { onDownloadRefresh: downloadRefresh } });

    await router.push({ name: "legacy-local" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="local-media-page"]').exists()).toBe(true));
    await wrapper.get('[data-action="local-open-file"]').trigger("click");
    expect(wrapper.emitted("localOpenFile")).toEqual([[]]);

    await router.push({ name: "legacy-downloads" });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="downloads-page"]').exists()).toBe(true));
    await wrapper.get('[data-action="download-refresh"]').trigger("click");
    expect(downloadRefresh).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("keeps browser back/forward semantics and restores saved scroll positions", async () => {
    const memoryRouter = createRouter({
      history: createMemoryHistory(),
      routes: coreRoutes,
      ...(router.options.scrollBehavior ? { scrollBehavior: router.options.scrollBehavior } : {}),
    });
    const routerHost = mount({ render: () => h("div") }, { global: { plugins: [memoryRouter] } });
    await memoryRouter.push({ name: "home" });
    await memoryRouter.push({ name: "search", query: { q: "真实关键词" } });
    await memoryRouter.push({ name: "media", params: { mediaId: "media-1" } });

    memoryRouter.back();
    await flushPromises();
    expect(memoryRouter.currentRoute.value.name).toBe("search");
    expect(memoryRouter.currentRoute.value.query.q).toBe("真实关键词");

    memoryRouter.forward();
    await flushPromises();
    expect(memoryRouter.currentRoute.value.name).toBe("media");

    const scrollBehavior = memoryRouter.options.scrollBehavior;
    if (!scrollBehavior) throw new Error("V3 router must define scrollBehavior");
    await memoryRouter.push({ name: "search", query: { q: "真实关键词" } });
    const search = memoryRouter.currentRoute.value;
    await memoryRouter.push({ name: "home" });
    const home = memoryRouter.currentRoute.value;
    expect(scrollBehavior?.(search, home, { left: 0, top: 240 })).toEqual({ left: 0, top: 240 });
    expect(scrollBehavior?.(search, home, null)).toEqual({ top: 0 });
    routerHost.unmount();
  });

  it("renders only category and filter options returned by the source", async () => {
    const state = readyState();
    state.browse.categories = [{ id: "movie", name: "电影" }, { id: "series", name: "剧集" }];
    state.browse.filters = [{ id: "year", name: "年份", options: [{ id: "2026", name: "2026" }] }];
    const wrapper = await mountShell(state);

    await router.push({ name: "category" });
    await flushPromises();
    expect(wrapper.get('[data-testid="core-category-options"]')).toBeTruthy();
    expect(wrapper.findAll('[data-action="source-category"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="core-category-filters"] select').attributes("data-filter-id")).toBe("year");

    await wrapper.get('[data-action="source-category"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.type).toBe("movie");
    wrapper.unmount();
  });

  it("lets the source page select an already imported source directly", async () => {
    const state = readyState();
    state.import.sites = [
      ...state.import.sites,
      { key: "source-b", name: "备用来源", api: "https://backup.example.test/api" },
    ];
    const wrapper = await mountShell(state);
    await router.push({ name: "sources" });
    await flushPromises();

    await wrapper.get('[data-action="core-select-source"]').trigger("click");
    expect(wrapper.emitted("selectSource")).toEqual([["source-b"]]);
    wrapper.unmount();
  });

  it("waits for the source switch result before refreshing the current route", async () => {
    const current = readyState();
    current.import.sites = [
      ...current.import.sites,
      { key: "source-b", name: "备用来源", api: "https://backup.example.test/api" },
    ];
    const switched = readyState();
    switched.import.sites = current.import.sites;
    switched.import.selectedSiteKey = "source-b";
    switched.import.selectedApi = "https://backup.example.test/api";
    switched.browse.items = [{ vod_id: "source-b-media", vod_name: "备用来源内容", vod_pic: null }];
    let resolveSwitch: ((value: Response) => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/switch") {
        return new Promise<Response>((resolve) => { resolveSwitch = resolve; });
      }
      return Promise.resolve({
        ok: true,
        json: async () => path === "/api/state" ? toEnvelope(current) : toEnvelope(current),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-action="sources"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-action="core-source-switch"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("sources");
    expect(wrapper.get('[data-action="core-source-switch"]').attributes("disabled")).toBeDefined();

    const finishSwitch = resolveSwitch as ((value: Response) => void) | null;
    if (!finishSwitch) throw new Error("source switch request was not pending");
    finishSwitch({
      ok: true,
      json: async () => toEnvelope(switched),
    } as Response);
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("home");
    expect(wrapper.get('[data-testid="core-browse-page"]').text()).toContain("备用来源内容");
    wrapper.unmount();
  });

  it("reparses the player when selecting another playback line", async () => {
    const current = readyState();
    current.detail = {
      detail: { vod_id: "media-1", vod_name: "正在播放的媒体" },
      playbackCatalog: {
        lines: [
          { index: 0, name: "VIP线路", protocol: "HLS", status: "ready", episodes: [{ index: 0, name: "第一集", id: "episode-1" }] },
          { index: 1, name: "蓝光线路", protocol: "HLS", status: "ready", episodes: [{ index: 0, name: "第一集", id: "episode-1-blue" }] },
        ],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    const switched = readyState();
    switched.detail = {
      ...current.detail,
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": toEnvelope(current),
      "/api/open": toEnvelope(current),
      "/api/home": toEnvelope(current),
      "/api/player": toEnvelope({
        ...switched,
        detail: {
          ...switched.detail,
          playbackSelection: { lineIndex: 1, episodeIndex: 0 },
        },
      }),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => responses[String(input)] ?? toEnvelope(current),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.push({ name: "watch", params: { mediaId: "media-1" } });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-action="playback-line"][data-line-index="1"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("watch");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("/api/player");
    expect(fetchMock).toHaveBeenCalledWith("/api/player", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"lineIndex":1'),
    }));
    expect(wrapper.get('[data-testid="current-line"]').text()).toBe("蓝光线路");
    wrapper.unmount();
  });

  it("does not invent category capability or expose raw source diagnostics", async () => {
    const state = readyState();
    state.import.sessionReady = false;
    state.spider.status = "idle";
    state.spider.capabilities = { ...state.spider.capabilities!, category: false };
    const wrapper = await mountShell(state);

    expect(wrapper.get('[data-testid="sidebar-source"] .status-dot').attributes("data-status")).toBe("unknown");
    expect(wrapper.find('[data-action="category"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="category-tab"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="local-media"]').exists()).toBe(false);
    await router.push({ name: "category" });
    await flushPromises();
    expect(wrapper.text()).toContain("当前来源不支持分类浏览");
    wrapper.unmount();
  });

  it("does not submit or advertise search when the source reports no search capability", async () => {
    const state = readyState();
    state.spider.capabilities = { ...state.spider.capabilities!, search: false };
    const wrapper = await mountShell(state);

    expect(wrapper.get("#search-key").attributes("disabled")).toBeDefined();
    expect(wrapper.get(".search-capability-hint").text()).toBe("当前来源不支持搜索");
    await router.push({ name: "search", query: { q: "不会提交" } });
    await flushPromises();
    expect(wrapper.get('[data-testid="empty-state"]').text()).toContain("当前来源不支持搜索");
    expect(wrapper.find('[data-testid="vod-list"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("maps unverified source lifecycle states to the public status vocabulary", async () => {
    const state = readyState();
    state.import.sessionReady = false;
    state.spider.status = "initializing";
    const wrapper = await mountShell(state);

    await router.push({ name: "sources" });
    await flushPromises();

    const chip = wrapper.get('[data-testid="core-source-switch-page"] .status-chip');
    expect(chip.attributes("data-status")).toBe("initializing");
    expect(chip.text()).toBe("准备中");
    expect(wrapper.text()).not.toContain("initializing");
    wrapper.unmount();
  });

  it("labels a source health check separately from initial setup", async () => {
    const state = readyState();
    state.import.sessionReady = false;
    state.spider.status = "loading";
    const wrapper = await mountShell(state);

    await router.push({ name: "sources" });
    await flushPromises();

    const chip = wrapper.get('[data-testid="core-source-switch-page"] .status-chip');
    expect(chip.attributes("data-status")).toBe("checking");
    expect(chip.text()).toBe("检测中");
    wrapper.unmount();
  });

  it("renders an independent media page without invoking the legacy detail drawer", async () => {
    const state = readyState();
    state.detail = {
      detail: {
        vod_id: "media-1",
        vod_name: "真实来源返回的媒体",
        vod_content: "来自详情接口的简介",
      },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "HLS", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    await router.push({ name: "media", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialTheme: "dark" },
      global: { plugins: [router] },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="core-media-detail-page"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="home"]').classes()).toContain("selected");
    expect(wrapper.find('[data-testid="detail-drawer"]').exists()).toBe(false);
    await wrapper.get('[data-action="core-detail-play"]').trigger("click");
    expect(wrapper.emitted("play")).toEqual([[0, 0, undefined]]);
    wrapper.unmount();
  });

  it("keeps the V3 detail page's history resume choice explicit", async () => {
    const state = readyState();
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "HLS", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    state.historyResume = {
      identity: "source-a:media-1:episode-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "真实来源返回的媒体",
      poster: null,
      episode: 1,
      episodeName: "正片",
      playbackLine: "主线路",
      position: 30,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "已授权来源",
      lineIndex: 0,
      episodeIndex: 0,
      lineName: "主线路",
      canResume: true,
    };
    await router.push({ name: "media", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="core-history-resume-prompt"]')).toBeTruthy();
    await wrapper.get('[data-action="core-history-resume"]').trigger("click");
    expect(wrapper.emitted("play")).toEqual([[0, 0, "continue"]]);
    await wrapper.get('[data-action="core-history-beginning"]').trigger("click");
    expect(wrapper.emitted("play")).toEqual([[0, 0, "continue"], [0, 0, "beginning"]]);
    await wrapper.get('[data-action="core-history-delete-progress"]').trigger("click");
    expect(wrapper.emitted("historyDeleteProgress")).toEqual([["source-a:media-1:episode-1"]]);
    wrapper.unmount();
  });

  it("starts playback from the currently selected detail line", async () => {
    const state = readyState();
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [
          { index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "第一集", id: "episode-1" }] },
          { index: 1, name: "备用线路", protocol: "HLS", status: "ready", episodes: [{ index: 0, name: "第一集", id: "episode-1-backup" }] },
        ],
      },
      playbackSelection: { lineIndex: 1, episodeIndex: 0 },
      canPlay: true,
    };
    await router.push({ name: "media", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 1, order: "forward" },
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get('[data-action="core-detail-play"]').trigger("click");
    expect(wrapper.emitted("play")).toEqual([[1, 0, undefined]]);
    wrapper.unmount();
  });

  it("shows continue-watching items only from persisted playback history", async () => {
    const state = readyState();
    state.history.items = [{
      identity: "source-a:media-1:episode-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "真实来源返回的媒体",
      poster: null,
      episode: 1,
      episodeName: "正片",
      playbackLine: "主线路",
      position: 30,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "已授权来源",
    }];
    const wrapper = await mountShell(state);

    expect(wrapper.get('[data-testid="core-continue-watching"]')).toBeTruthy();
    await wrapper.get('[data-action="core-continue-detail"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("historyOpen")).toEqual([["source-a:media-1:episode-1"]]);
    wrapper.unmount();
  });

  it("renders the V3 history and favorites routes through the existing feature state", async () => {
    const state = readyState();
    state.history.items = [{
      identity: "source-a:media-1:episode-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "真实观看记录",
      poster: null,
      episode: 1,
      episodeName: "第一集",
      playbackLine: "主线路",
      position: 20,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "已授权来源",
    }];
    state.favorites.groups = [{ groupId: "default", name: "默认收藏", sortOrder: 0, createdAt: 1, updatedAt: 1, count: 1 }];
    state.favorites.items = [{
      favoriteId: "favorite-1",
      sourceId: "source-a",
      vodId: "media-1",
      title: "真实收藏内容",
      poster: null,
      year: null,
      category: null,
      sourceName: "已授权来源",
      groupId: "default",
      sortOrder: 0,
      metadata: null,
      addedAt: 1,
      updatedAt: 1,
      sourceAvailable: true,
      recentWatchedAt: null,
    }];
    const wrapper = await mountShell(state);

    await router.push({ name: "history" });
    await flushPromises();
    expect(wrapper.get('[data-testid="history-page"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="history-page"]').text()).not.toContain("已授权来源");
    await wrapper.get('[data-action="history-open"]').trigger("click");
    expect(wrapper.emitted("historyOpen")).toEqual([["source-a:media-1:episode-1"]]);

    await router.push({ name: "favorites" });
    await flushPromises();
    expect(wrapper.get('[data-testid="favorites-page"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="favorites-page"]').text()).not.toContain("已授权来源");
    await wrapper.get('[data-action="favorite-open"]').trigger("click");
    expect(wrapper.emitted("favoriteOpen")).toEqual([["favorite-1"]]);
    wrapper.unmount();
  });

  it("keeps a real hero region and falls back through the shared poster placeholder", async () => {
    const state = readyState();
    state.browse.items = [{ vod_id: "media-hero", vod_name: "真实 Hero", vod_pic_slide: "https://media.example.test/hero.jpg" }];
    const wrapper = await mountShell(state);

    const image = wrapper.get('[data-testid="core-hero-image"]');
    expect(image.element.tagName).toBe("IMG");
    await image.trigger("error");
    expect(wrapper.get(".core-hero-image").element.tagName).toBe("SPAN");
    wrapper.unmount();
  });

  it("renders the watch route with the existing embedded player boundary", async () => {
    const state = readyState();
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    state.playback.player = {
      ...state.playback.player,
      status: "loading",
      source: { parse: 0, url: "http://127.0.0.1:43123/media", headers: {}, mediaType: "mp4" },
    };
    await router.push({ name: "watch", params: { mediaId: "media-1" }, query: { episode: "1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward", initialTheme: "dark" },
      global: { plugins: [router] },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="core-watch-page"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="home"]').classes()).toContain("selected");
    expect(wrapper.get('[data-testid="embedded-player-panel"]')).toBeTruthy();
    expect(wrapper.html().indexOf('data-testid="embedded-player-panel"')).toBeLessThan(wrapper.html().indexOf('data-testid="playback-lines"'));
    expect(router.currentRoute.value.query.episode).toBe("1");
    await wrapper.get('[data-action="player-detach"]').trigger("click");
    expect(wrapper.emitted("playerDetach")).toHaveLength(1);
    wrapper.unmount();
  });

  it("routes the watch player detach action through the App API boundary", async () => {
    const state = readyState();
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    state.playback.player = {
      ...state.playback.player,
      status: "loading",
      source: { parse: 0, url: "http://127.0.0.1:43123/media", headers: {}, mediaType: "mp4" },
    };
    const envelope = toEnvelope(state);
    vi.spyOn(RendererApi.prototype, "getState").mockResolvedValue(envelope);
    const post = vi.spyOn(RendererApi.prototype, "post").mockResolvedValue(envelope);
    await router.push({ name: "watch", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-action="player-detach"]').trigger("click");
    await flushPromises();

    const paths = post.mock.calls.map(([path]) => path);
    expect(paths).toContain("/api/player/detach");
    expect(paths).toContain("/api/player/open");
    wrapper.unmount();
  });

  it("keeps resume choices explicit on the watch route", async () => {
    const state = readyState();
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    state.historyResume = {
      identity: "source-a:media-1:episode-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "真实来源返回的媒体",
      poster: null,
      episode: 1,
      episodeName: "正片",
      playbackLine: "主线路",
      position: 45,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "已授权来源",
      lineIndex: 0,
      episodeIndex: 0,
      lineName: "主线路",
      canResume: true,
    };
    await router.push({ name: "watch", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="core-history-resume-prompt"]')).toBeTruthy();
    await wrapper.get('[data-action="core-history-resume"]').trigger("click");
    await wrapper.get('[data-action="core-history-beginning"]').trigger("click");
    expect(wrapper.emitted("play")).toEqual([[0, 0, "continue"], [0, 0, "beginning"]]);
    await wrapper.get('[data-action="core-history-delete-progress"]').trigger("click");
    expect(wrapper.emitted("historyDeleteProgress")).toEqual([["source-a:media-1:episode-1"]]);
    wrapper.unmount();
  });

  it("opens the source center from the playback error switch action", async () => {
    const state = readyState();
    state.import.sites = [
      { key: "source-a", name: "来源 A", api: "https://source-a.example.test/api" },
      { key: "source-b", name: "来源 B", api: "https://source-b.example.test/api" },
    ];
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    state.error.error = {
      code: "PLAYBACK_UNAVAILABLE",
      title: "播放失败",
      message: "当前线路暂时无法播放",
      source: "player",
      retryable: true,
      diagnosticId: "diagnostic-playback-switch",
      timestamp: new Date().toISOString(),
      safeDetails: {},
    };
    await router.push({ name: "watch", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get('[data-action="core-watch-switch-source"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("sources");

    await router.push({ name: "watch", params: { mediaId: "media-1" } });
    await flushPromises();
    await wrapper.get('[data-action="switch-line"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("sources");
    expect(wrapper.find('[data-testid="core-source-switch-page"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("wires the production App shell through the router and renderer API boundary", async () => {
    const home = readyState();
    const detail = readyState();
    detail.browse.page = "detail";
    detail.browse.items = [];
    detail.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体", vod_content: "详情接口内容" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    const playing = readyState();
    playing.browse.page = "detail";
    playing.browse.items = [];
    playing.detail = detail.detail;
    playing.playback.player = {
      ...playing.playback.player,
      status: "loading",
      source: { parse: 0, url: "http://127.0.0.1:43123/media", headers: {}, mediaType: "mp4" },
    };
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": toEnvelope(home),
      "/api/open": toEnvelope(home),
      "/api/home": toEnvelope(home),
      "/api/detail": toEnvelope(detail),
      "/api/player": toEnvelope(playing),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? toEnvelope(home),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="core-app-shell"]')).toBeTruthy();
    await wrapper.get('[data-testid="vod-card"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("media");
    expect(wrapper.get('[data-testid="core-media-detail-page"]')).toBeTruthy();

    await wrapper.get('[data-action="core-detail-play"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("watch");
    expect(wrapper.get('[data-testid="core-watch-page"]')).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      "/api/state",
      "/api/open",
      "/api/home",
      "/api/detail",
      "/api/player",
    ]));
    wrapper.unmount();
  });

  it("opens continue-watching on the detail route without starting playback", async () => {
    const historyItem = {
      identity: "source-a:media-1:episode-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "真实来源返回的媒体",
      poster: null,
      episode: 1,
      episodeName: "正片",
      playbackLine: "主线路",
      position: 30,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "已授权来源",
    };
    const home = readyState();
    home.history.items = [historyItem];
    const opened = readyState();
    opened.browse.page = "detail";
    opened.browse.items = [];
    opened.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    opened.historyResume = { ...historyItem, lineIndex: 0, episodeIndex: 0, lineName: "主线路", canResume: true };
    const playing = readyState();
    playing.browse.page = "detail";
    playing.browse.items = [];
    playing.detail = opened.detail;
    playing.playback.player = {
      ...playing.playback.player,
      status: "loading",
      currentTime: 30,
      source: { parse: 0, url: "http://127.0.0.1:43123/media", headers: {}, mediaType: "mp4" },
    };
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": toEnvelope(home),
      "/api/open": toEnvelope(home),
      "/api/home": toEnvelope(home),
      "/api/history/open": toEnvelope(opened),
      "/api/player": toEnvelope(playing),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? toEnvelope(home),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-action="core-continue-detail"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("media");
    expect(wrapper.get('[data-testid="core-history-resume-prompt"]')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/player")).toBe(false);
    wrapper.unmount();
  });

  it("opens favorite and follow items on detail without starting playback", async () => {
    const historyItem = {
      identity: "source-a:media-1:episode-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "真实来源返回的媒体",
      poster: null,
      episode: 1,
      episodeName: "正片",
      playbackLine: "主线路",
      position: 30,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "已授权来源",
    };
    const home = readyState();
    home.history.items = [historyItem];
    home.favorites.groups = [{ groupId: "default", name: "默认收藏", sortOrder: 0, createdAt: 1, updatedAt: 1, count: 1 }];
    home.favorites.items = [{
      favoriteId: "favorite-1",
      sourceId: "source-a",
      vodId: "media-1",
      title: "收藏内容",
      poster: null,
      year: null,
      category: null,
      sourceName: "已授权来源",
      groupId: "default",
      sortOrder: 0,
      metadata: null,
      addedAt: 1,
      updatedAt: 1,
      sourceAvailable: true,
      recentWatchedAt: null,
    }];
    home.follow.items = [{
      identity: "source-a:media-1:follow",
      sourceId: "source-a",
      vodId: "media-1",
      title: "追更内容",
      poster: null,
      latestEpisodeId: "episode-1",
      latestEpisodeName: "正片",
      watchedEpisodeId: "episode-1",
      watchedEpisodeName: "正片",
      knownEpisodeCount: 1,
      lastCheckedAt: 1,
      lastUpdatedAt: 1,
      updateAvailable: false,
      checkError: null,
      enabled: true,
      sourceAvailable: true,
      status: "caught-up",
    }];
    const opened = readyState();
    opened.browse.page = "detail";
    opened.browse.items = [];
    opened.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "正片", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    opened.historyResume = { ...historyItem, lineIndex: 0, episodeIndex: 0, lineName: "主线路", canResume: true };
    const playing = readyState();
    playing.browse.page = "detail";
    playing.browse.items = [];
    playing.detail = opened.detail;
    playing.playback.player = {
      ...playing.playback.player,
      status: "loading",
      currentTime: 30,
      source: { parse: 0, url: "http://127.0.0.1:43123/media", headers: {}, mediaType: "mp4" },
    };
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": toEnvelope(home),
      "/api/open": toEnvelope(home),
      "/api/home": toEnvelope(home),
      "/api/favorites/open": toEnvelope(opened),
      "/api/follow/open": toEnvelope(opened),
      "/api/player": toEnvelope(playing),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? toEnvelope(home),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: { plugins: [router], provide: { [ROUTER_ENABLED_KEY as symbol]: true } },
    });
    await flushPromises();
    await flushPromises();

    await router.push({ name: "favorites" });
    await flushPromises();
    await wrapper.get('[data-action="favorite-open"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("media");
    expect(wrapper.get('[data-testid="core-history-resume-prompt"]')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/player")).toBe(false);

    await router.push({ name: "follow" });
    await flushPromises();
    await wrapper.get('[data-action="follow-open"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("media");
    expect(wrapper.get('[data-testid="core-history-resume-prompt"]')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/player")).toBe(false);
    wrapper.unmount();
  });

  it("starts on home while preserving the remembered source selection", async () => {
    const home = readyState();
    const category = readyState();
    category.browse.page = "category";
    category.browse.items = [{ vod_id: "persisted-media", vod_name: "持久化分类结果", vod_pic: null }];
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": {
        ...toEnvelope(home),
        persistence: {
          theme: "light",
          navigation: "category",
          siteKey: "source-a",
          category: { typeId: "movie", page: 1, filters: { area: "US", year: "2024" } },
          search: null,
          scrollTop: 64,
          recentDetailId: null,
        },
      },
      "/api/open": toEnvelope(home),
      "/api/category": toEnvelope(category),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? toEnvelope(home),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("home");
    expect(wrapper.get('[data-testid="core-browse-page"]').attributes("data-route")).toBe("home");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining(["/api/open", "/api/home"]));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/category", expect.anything());
    wrapper.unmount();
  });

  it("opens a real follow page from the sidebar", async () => {
    const state = readyState();
    state.follow.items = [{
      identity: "source-a:media-1:follow",
      sourceId: "source-a",
      vodId: "media-1",
      title: "真实追更内容",
      poster: null,
      latestEpisodeId: "episode-1",
      latestEpisodeName: "第一集",
      watchedEpisodeId: null,
      watchedEpisodeName: null,
      knownEpisodeCount: 1,
      lastCheckedAt: null,
      lastUpdatedAt: null,
      updateAvailable: false,
      checkError: null,
      enabled: true,
      sourceAvailable: true,
      status: "caught-up",
    }];
    const wrapper = await mountShell(state);

    await wrapper.get('[data-action="follow"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("follow");
    expect(wrapper.find('[data-testid="follow-page"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps only the prominent top-left return control", async () => {
    const state = readyState();
    state.detail = {
      detail: { vod_id: "media-1", vod_name: "真实来源返回的媒体" },
      playbackCatalog: {
        lines: [{ index: 0, name: "主线路", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "第一集", id: "episode-1" }] }],
      },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
      canPlay: true,
    };
    await router.push({ name: "media", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });
    await flushPromises();

    expect(wrapper.findAll('[data-action="router-back"]')).toHaveLength(1);
    expect(wrapper.find('[data-action="router-forward"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="core-page-back"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="core-detail-back"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="core-watch-back"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps an explicit search URL and query across initial app restore", async () => {
    const home = readyState();
    const search = readyState();
    search.browse.page = "search";
    search.browse.items = [{ vod_id: "direct-search", vod_name: "直接搜索结果", vod_pic: null }];
    const responses: Record<string, RendererEnvelope> = {
      "/api/state": {
        ...toEnvelope(home),
        persistence: {
          theme: "light",
          navigation: "home",
          siteKey: "source-a",
          category: null,
          search: null,
          scrollTop: 0,
          recentDetailId: null,
        },
      },
      "/api/open": toEnvelope(home),
      "/api/home": toEnvelope(home),
      "/api/search": toEnvelope(search),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => responses[String(input)] ?? toEnvelope(home),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "search", query: { q: "直接查询" } });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("search");
    expect(router.currentRoute.value.query.q).toBe("直接查询");
    expect(wrapper.get('[data-testid="core-browse-page"]').attributes("data-route")).toBe("search");
    expect((wrapper.get("#search-key").element as HTMLInputElement).value).toBe("直接查询");
    expect(fetchMock).toHaveBeenCalledWith("/api/search", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ key: "直接查询", page: 1, quick: false }),
    }));
    wrapper.unmount();
  });

  it("opens a new detail immediately, cancels the old request and ignores its late response", async () => {
    const home = readyState();
    const oldDetail = readyState();
    oldDetail.browse.page = "detail";
    oldDetail.detail.detail = { vod_id: "media-old", vod_name: "旧详情" };
    const newDetail = readyState();
    newDetail.browse.page = "detail";
    newDetail.detail.detail = { vod_id: "media-new", vod_name: "新详情" };
    const oldResponse = deferred<RendererEnvelope>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/detail") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { vodId?: string };
        return {
          ok: true,
          json: async () => body.vodId === "media-old" ? oldResponse.promise : toEnvelope(newDetail),
        };
      }
      return { ok: true, json: async () => toEnvelope(home) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    await router.push({ name: "media", params: { mediaId: "media-old" } });
    await flushPromises();
    await router.push({ name: "media", params: { mediaId: "media-new" } });
    await flushPromises();
    const requests = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/detail");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.[1]?.signal?.aborted).toBe(true);
    expect(requests[1]?.[1]?.signal?.aborted).toBe(false);
    expect(wrapper.get(".detail-page-copy h2").text()).toBe("新详情");
    expect(wrapper.get('[data-action="sources"]').attributes("disabled")).toBeUndefined();

    oldResponse.resolve(toEnvelope(oldDetail));
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/detail")).toHaveLength(2);
    expect(router.currentRoute.value.params.mediaId).toBe("media-new");
    expect(wrapper.get(".detail-page-copy h2").text()).toBe("新详情");
    wrapper.unmount();
  });

  it("routes a first launch into onboarding before any source is trusted", async () => {
    const firstLaunch = readyState();
    firstLaunch.import = {
      ...firstLaunch.import,
      status: "confirmation_required",
      trusted: false,
      sessionReady: false,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => toEnvelope(firstLaunch),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("onboarding");
    expect(wrapper.find('[data-testid="config-import-form"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("leaves a failed first source request on the core home with its error visible", async () => {
    const firstLaunch = readyState();
    firstLaunch.import = {
      ...firstLaunch.import,
      status: "confirmation_required",
      trusted: false,
      sessionReady: false,
    };
    const confirmed = readyState();
    const failedConfirm = toEnvelope(confirmed);
    failedConfirm.error = "SOURCE_SESSION_REQUEST_FAILED";
    failedConfirm.errorCode = "SOURCE_SESSION_REQUEST_FAILED";
    const responses = [toEnvelope(firstLaunch), failedConfirm];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? failedConfirm,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await router.replace({ name: "home" });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        provide: { [ROUTER_ENABLED_KEY as symbol]: true },
      },
    });
    await flushPromises();
    await wrapper.get('[data-action="confirm-import"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("home");
    expect(wrapper.get('[data-testid="error-state"]').attributes("data-error-code")).toBe("SOURCE_SESSION_REQUEST_FAILED");
    expect(wrapper.get('[data-testid="error-state"]').attributes("data-state")).toBe("offline");
    expect(wrapper.get('[data-testid="error-state"]').text()).toContain("当前来源暂不可用");
    expect(wrapper.get('[data-testid="error-state"]').text()).not.toContain("SOURCE_SESSION_REQUEST_FAILED");
    wrapper.unmount();
  });
});
