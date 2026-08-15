// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import App from "../renderer/src/App.vue";
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
    },
  };
}

async function mountShell(state = readyState()) {
  await router.push({ name: "home" });
  await router.isReady();
  return mount(CoreShell, {
    props: {
      state,
      pending: null,
      lineIndex: 0,
      order: "forward",
    },
    global: { plugins: [router] },
  });
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
    vi.unstubAllGlobals();
  });

  it("uses window-internal routes for browse, search and source switching", async () => {
    const wrapper = await mountShell();

    expect(wrapper.get('[data-testid="core-app-shell"]').attributes("data-route")).toBe("home");
    expect(wrapper.get('[data-testid="core-app-shell"]').attributes("data-theme")).toBe("light");
    expect(wrapper.get('[data-testid="source-switcher"] .status-chip').text()).toBe("已连接");
    expect(wrapper.get('[data-testid="source-context"]').text()).not.toContain("config-1");
    expect(wrapper.get('[data-testid="source-switcher"]').text()).toContain("当前仅有一个已导入来源");
    expect(wrapper.get('[data-testid="source-switcher"] [data-action="switch"]').text()).toBe("查看来源");
    expect(wrapper.get('[data-testid="app-sidebar"] [data-action="sources"]').text()).toContain("来源中心");
    expect(wrapper.get('[data-testid="sidebar-source"][data-action="sidebar-source-status"]')).toBeTruthy();
    expect(wrapper.find('[data-testid="app-sidebar"] [data-action="open"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="app-sidebar"] [data-action="switch"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="core-recommendations"]').text()).toContain("推荐");
    await wrapper.get('[data-action="category"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("category");

    await wrapper.get("#search-key").setValue("真实关键词");
    await wrapper.get('[data-action="search-form"]').trigger("submit");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("search");
    expect(router.currentRoute.value.query.q).toBe("真实关键词");

    await wrapper.get('[data-action="switch"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("sources");
    expect(wrapper.find('[data-testid="core-source-switch-page"]').exists()).toBe(true);
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

  it("does not invent category capability or expose raw source diagnostics", async () => {
    const state = readyState();
    state.import.sessionReady = false;
    state.spider.status = "idle";
    state.spider.capabilities = { ...state.spider.capabilities!, category: false };
    const wrapper = await mountShell(state);

    expect(wrapper.get('[data-testid="source-switcher"] .status-chip').text()).toBe("未检测");
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
    expect(chip.attributes("data-status")).toBe("unknown");
    expect(chip.text()).toBe("未检测");
    expect(wrapper.text()).not.toContain("initializing");
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
    expect(wrapper.find('[data-testid="detail-drawer"]').exists()).toBe(false);
    await wrapper.get('[data-action="core-detail-play"]').trigger("click");
    expect(wrapper.emitted("play")).toEqual([[0, 0, undefined]]);
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
    expect(wrapper.emitted("detail")).toEqual([["media-1"]]);
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
    expect(wrapper.get('[data-testid="embedded-player-panel"]')).toBeTruthy();
    expect(router.currentRoute.value.query.episode).toBe("1");
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

  it("restores the persisted category route and filters through the production App shell", async () => {
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

    expect(router.currentRoute.value.name).toBe("category");
    expect(router.currentRoute.value.query.type).toBe("movie");
    expect(JSON.parse(String(router.currentRoute.value.query.filter))).toEqual({ area: "US", year: "2024" });
    expect(wrapper.get('[data-testid="core-browse-page"]').attributes("data-route")).toBe("category");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining(["/api/open", "/api/category"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/category", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"area":"US"'),
    }));
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
    expect(fetchMock).toHaveBeenCalledWith("/api/search", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ key: "直接查询", page: 1, quick: false }),
    }));
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
