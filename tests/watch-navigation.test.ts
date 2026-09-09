// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { computed, h, nextTick, ref } from "vue";
import type { Ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import CoreShell from "../renderer/src/CoreShell.vue";
import EmbeddedPlayer from "../renderer/src/EmbeddedPlayer.vue";
import MediaDetailPage from "../renderer/src/pages/MediaDetailPage.vue";
import WatchPage from "../renderer/src/pages/WatchPage.vue";
import { CORE_ROUTE_CONTEXT_KEY, type CoreRouteContext } from "../renderer/src/core-route-context.js";
import { coreRoutes } from "../renderer/src/router.js";
import { createRendererState, type RendererState } from "../renderer/src/state.js";

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
    sites: [{ key: "source-a", name: "测试来源", api: "https://source.example.test/api" }],
  };
  state.spider = {
    ...state.spider,
    source: "source-a",
    sourceId: "source-a",
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
  state.detail = {
    detail: { vod_id: "media-1", vod_name: "测试媒体" },
    playbackCatalog: {
      lines: [
        { index: 0, name: "线路一", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "第一集", id: "ep-1" }] },
        { index: 1, name: "线路二", protocol: "MP4", status: "ready", episodes: [{ index: 0, name: "第一集", id: "ep-1-b" }] },
      ],
    },
    playbackSelection: { lineIndex: 0, episodeIndex: 0 },
    canPlay: true,
  };
  return state;
}

function contextFor(
  state: Ref<RendererState>,
  pending: Ref<string | null> = ref(null),
  play = vi.fn(),
): CoreRouteContext {
  return {
    state,
    pending,
    lineIndex: ref(0),
    order: ref("forward"),
    theme: ref("light"),
    resolvedTheme: computed(() => "light"),
    sourceName: computed(() => "测试来源"),
    retryable: computed(() => false),
    canSearchPlayback: computed(() => false),
    navigate: vi.fn(),
    back: vi.fn(),
    search: vi.fn(),
    selectCategory: vi.fn(),
    openDetail: vi.fn(),
    play,
    retry: vi.fn(),
    findPlaybackSource: vi.fn(),
    selectPlaybackSource: vi.fn(),
    setLine: vi.fn(),
    setOrder: vi.fn(),
    playerDetach: vi.fn(),
    playerAttach: vi.fn(),
    playerStop: vi.fn(),
    playerSync: vi.fn(),
    fallbackCancel: vi.fn(),
    fallbackApprove: vi.fn(),
    fallbackMode: vi.fn(),
    openSources: vi.fn(),
    switchSource: vi.fn(),
    selectSource: vi.fn(),
    favoriteToggle: vi.fn(),
    favoriteMove: vi.fn(),
    historyOpen: vi.fn(),
    historyDelete: vi.fn(),
    historyDeleteProgress: vi.fn(),
    historyClear: vi.fn(),
    historyPause: vi.fn(),
    favoriteOpen: vi.fn(),
    favoriteDelete: vi.fn(),
    favoriteMoveItem: vi.fn(),
    favoriteReorder: vi.fn(),
    favoriteCreateGroup: vi.fn(),
    favoriteRenameGroup: vi.fn(),
    favoriteDeleteGroup: vi.fn(),
    favoriteReorderGroups: vi.fn(),
    followToggle: vi.fn(),
    followAndFavorite: vi.fn(),
    followRefresh: vi.fn(),
    followOpen: vi.fn(),
    followDelete: vi.fn(),
    followMarkWatched: vi.fn(),
    followMarkUnwatched: vi.fn(),
  };
}

async function createWatchRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/watch/:mediaId", name: "watch", component: WatchPage }],
  });
  await router.push({ name: "watch", params: { mediaId: "media-1" } });
  await router.isReady();
  return router;
}

async function createDetailRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/media/:mediaId", name: "media", component: MediaDetailPage }],
  });
  await router.push({ name: "media", params: { mediaId: "media-1" } });
  await router.isReady();
  return router;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("watch navigation and explicit playback", () => {
  it("retains result origin on direct detail navigation even when IDs overlap", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: coreRoutes });
    await router.replace({ name: "media", params: { mediaId: "media-1" }, query: { source: "source-b" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state: readyState(), pending: "search", lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });
    await flushPromises();
    expect(wrapper.emitted("detail")).toEqual([["media-1", "source-b"]]);
    expect(wrapper.get('[data-action="home"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("plays the selected episode from the watch page", async () => {
    const state = ref(readyState());
    state.value.detail.playbackCatalog?.lines[0]?.episodes.push({ index: 1, name: "第二集", id: "ep-2" });
    const play = vi.fn();
    const router = await createWatchRouter();
    const wrapper = mount(WatchPage, {
      global: {
        plugins: [router],
        provide: { [CORE_ROUTE_CONTEXT_KEY as symbol]: contextFor(state, ref(null), play) },
      },
    });

    await wrapper.get('[data-episode-index="1"]').trigger("click");

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(0, 1);
    wrapper.unmount();
  });

  it("plays the selected episode from the media detail page", async () => {
    const state = ref(readyState());
    state.value.detail.playbackCatalog?.lines[0]?.episodes.push({ index: 1, name: "第二集", id: "ep-2" });
    const play = vi.fn();
    const router = await createDetailRouter();
    const wrapper = mount(MediaDetailPage, {
      global: {
        plugins: [router],
        provide: { [CORE_ROUTE_CONTEXT_KEY as symbol]: contextFor(state, ref(null), play) },
      },
    });

    await wrapper.get('[data-episode-index="1"]').trigger("click");

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(0, 1);
    wrapper.unmount();
  });

  it("waits for an explicit playback action after an asynchronously loaded detail becomes available", async () => {
    const state = ref(readyState());
    state.value.detail.detail = null;
    state.value.detail.playbackCatalog = null;
    const pending = ref<string | null>("detail");
    const play = vi.fn();
    const router = await createWatchRouter();
    const wrapper = mount(WatchPage, {
      global: {
        plugins: [router],
        provide: { [CORE_ROUTE_CONTEXT_KEY as symbol]: contextFor(state, pending, play) },
      },
    });

    expect(play).not.toHaveBeenCalled();
    state.value = { ...state.value, detail: readyState().detail };
    pending.value = null;
    await nextTick();
    await flushPromises();
    await nextTick();
    expect(play).not.toHaveBeenCalled();
    expect(wrapper.get('[data-action="core-watch-play"]')).toBeTruthy();

    await wrapper.get('[data-action="core-watch-play"]').trigger("click");
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(0, 0);
    wrapper.unmount();
  });

  it("does not autoplay over an explicit history resume choice", async () => {
    const state = ref(readyState());
    state.value.detail.playbackCatalog?.lines[0]?.episodes.push({ index: 1, name: "第二集", id: "ep-2" });
    state.value.historyResume = {
      identity: "source-a:media-1:ep-1",
      sourceId: "source-a",
      vodId: "media-1",
      seasonId: null,
      episodeId: "ep-1",
      title: "测试媒体",
      poster: null,
      episode: 1,
      episodeName: "第一集",
      playbackLine: "线路一",
      position: 12,
      duration: 100,
      updatedAt: 1,
      completed: false,
      sourceDisplayName: "测试来源",
      lineIndex: 0,
      episodeIndex: 0,
      lineName: "线路一",
      canResume: true,
    };
    const play = vi.fn();
    const router = await createWatchRouter();
    const wrapper = mount(WatchPage, {
      global: {
        plugins: [router],
        provide: { [CORE_ROUTE_CONTEXT_KEY as symbol]: contextFor(state, ref(null), play) },
      },
    });

    await nextTick();
    expect(play).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="core-history-resume-prompt"]')).toBeTruthy();
    expect(wrapper.get('[data-testid="watch-screen"] [data-testid="core-history-resume-prompt"]')).toBeTruthy();
    expect(wrapper.find('[data-action="core-watch-play"]').exists()).toBe(false);
    await wrapper.get('[data-episode-index="1"]').trigger("click");
    expect(play).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("starts each new player session once while the backend state is loading", async () => {
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: play });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: vi.fn() });
    const player = createRendererState().playback.player;
    player.status = "loading";
    player.source = {
      parse: 0,
      url: "https://media.example.test/video.mp4",
      headers: {},
      mediaType: "mp4",
    };
    const playbackKey = ref("session-1:0:0");
    const detachable = ref(false);
    const wrapper = mount({
      setup: () => () => h(EmbeddedPlayer, {
        state: player,
        sessionId: "session-1",
        playbackKey: playbackKey.value,
        detachable: detachable.value,
      }),
    });

    await nextTick();
    await flushPromises();
    expect(play).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="player-loading-overlay"]').exists()).toBe(true);

    playbackKey.value = "session-1:1:0";
    await nextTick();
    await flushPromises();
    expect(play).toHaveBeenCalledTimes(2);

    detachable.value = true;
    await nextTick();
    await flushPromises();
    expect(play).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("falls back from a direct media route when browser history has no back entry", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: coreRoutes });
    await router.replace({ name: "media", params: { mediaId: "media-1" } });
    await router.isReady();
    const state = readyState();
    const wrapper = mount(CoreShell, {
      props: { state, pending: null, lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });

    const button = wrapper.get('[data-action="router-back"]');
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("home");
    wrapper.unmount();
  });

  it("keeps shell navigation available while a player request is loading", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: coreRoutes });
    await router.replace({ name: "watch", params: { mediaId: "media-1" } });
    await router.isReady();
    const wrapper = mount(CoreShell, {
      props: { state: readyState(), pending: "player", lineIndex: 0, order: "forward" },
      global: { plugins: [router] },
    });

    expect(wrapper.get('[data-action="home"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-action="sources"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
});
