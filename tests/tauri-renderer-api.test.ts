import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ingestConfigCatalog = vi.fn();
const requestBusinessData = vi.fn();
const requestBusinessFeature = vi.fn();
const requestComponentManager = vi.fn();
const requestDesktopService = vi.fn();
const requestLive = vi.fn();
const requestEpg = vi.fn();
const requestSourceSession = vi.fn();
const requestPlaybackProxy = vi.fn();
const requestPlaybackSources = vi.fn();
const requestWebviewSniffer = vi.fn();
const requestRuntimeCapability = vi.fn();
const requestQuickJsSidecar = vi.fn();
const requestPlayerWindow = vi.fn();

vi.mock("../renderer/src/tauri-rpc.js", () => ({
  isTauriRuntime: () => true,
  ingestConfigCatalog,
  requestBusinessData,
  requestBusinessFeature,
  requestComponentManager,
  requestDesktopService,
  requestLive,
  requestEpg,
  requestSourceSession,
  requestPlaybackProxy,
  requestPlaybackSources,
  requestWebviewSniffer,
  requestRuntimeCapability,
  requestQuickJsSidecar,
  requestPlayerWindow,
}));

describe("Tauri renderer vertical slice", () => {
  beforeEach(() => {
    requestLive.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        live: {
          sources: [], preview: null, loading: false, error: null,
          catalog: { groups: [], channels: [], recent: [] }, session: null, player: null,
          epg: { sources: [], preview: null, loading: false, error: null, retention: { pastRetentionMs: 21600000, futureRetentionMs: 604800000 }, mappings: [], timeline: null },
          smartChannels: [], smartSuggestions: [], activeSmartChannel: null, health: null,
          failover: { mode: "ask", status: "idle", trigger: null, reason: null, current: null, next: null, attempts: 0, maxAttempts: 3, tried: [], startedAt: null, deadlineAt: null, cooldownUntil: null, manualOverrideUntil: null },
        },
      },
    });
    requestEpg.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        epg: { sources: [], preview: null, loading: false, error: null, retention: { pastRetentionMs: 21600000, futureRetentionMs: 604800000 }, mappings: [], timeline: null },
      },
    });
    requestDesktopService.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        cache: { totalBytes: 0, maxBytes: 0, entries: 0, byType: [] },
        storage: { mode: "normal", dataRoot: "", normalRoot: "", portableRoot: "", databaseBytes: 0, cacheBytes: 0, totalBytes: 0, historyCount: 0, favoritesCount: 0, followCount: 0, writable: true, switching: false, error: null },
        backup: { status: "idle", lastBackup: null, preview: null, error: null },
        localMedia: { ready: true, folders: [], items: [], activeItemId: null, scan: { rootId: null, status: "idle", visitedFiles: 0, skippedFiles: 0 }, error: null, limits: { maxDepth: 8, maxFiles: 10000, maxDropFiles: 100 } },
        downloads: { tasks: [], targetDirectories: [], backend: "native-http", aria2Available: false, error: null },
      },
    });
    requestComponentManager.mockResolvedValue({
      state: "verified",
      componentId: "mpv",
      version: "1",
      verified: true,
    });
    requestPlayerWindow.mockResolvedValue({ state: {} });
    requestPlaybackSources.mockResolvedValue({
      query: "Movie",
      searchedSites: ["jianpian", "alternate"],
      successfulSites: ["jianpian", "alternate"],
      failedSites: [],
      candidates: [{
        siteKey: "jianpian",
        siteName: "Jianpian",
        vod: {
          vod_id: "movie-1",
          vod_name: "Movie",
          vod_play_from: "main",
          vod_play_url: "Episode$https://media.example.test/movie.m3u8|1|Movie",
        },
        score: 1,
        playable: true,
        lines: { lines: [{ index: 0, name: "main", protocol: "HLS", episodes: [{ index: 0, name: "Episode", id: "https://media.example.test/movie.m3u8" }] }] },
        hasPlayFrom: true,
        hasPlayUrl: true,
      }, {
        siteKey: "alternate",
        siteName: "Alternate",
        vod: {
          vod_id: "movie-1",
          vod_name: "Movie",
          vod_play_from: "main",
          vod_play_url: "Episode$https://media.example.test/alternate.m3u8|1|Movie",
        },
        score: 0.9,
        playable: true,
        lines: { lines: [{ index: 0, name: "main", protocol: "HLS", episodes: [{ index: 0, name: "Episode", id: "https://media.example.test/alternate.m3u8" }] }] },
        hasPlayFrom: true,
        hasPlayUrl: true,
      }],
      diagnostics: {
        configSiteCount: 2,
        searchableSites: 2,
        runtimeSupportedSites: 2,
        runtimePreparation: "ready",
        runtimeWaitDurationMs: 0,
        unsupportedSiteCount: 0,
        searchedSites: ["jianpian", "alternate"],
        searchSuccessSites: ["jianpian", "alternate"],
        searchFailedSites: [],
        searchResultCount: 2,
        matchedCandidateCount: 2,
        detailSuccessCount: 2,
        playableCandidateCount: 2,
        sites: [],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("imports, opens, browses, resolves and proxies a native Jianpian source without fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "config-hash",
      siteCount: 2,
      usedCache: false,
      validVersionCount: 1,
      sites: [
        { key: "jianpian", name: "Jianpian", api: "csp_Jianpian", siteType: 3, ext: "https://api.example.test" },
        { key: "alternate", name: "Alternate", api: "csp_Jianpian", siteType: 3, ext: "https://api.example.test" },
      ],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      value: null,
      recordCount: 0,
    });
    requestBusinessFeature.mockImplementation(async (payload: { feature: string }) => ({
      schemaVersion: "v1",
      feature: payload.feature,
      state: payload.feature === "history"
        ? { history: { items: [], paused: false } }
        : payload.feature === "favorites"
          ? { favorites: { items: [], groups: [], defaultGroupId: "default" } }
          : { follow: { items: [], checking: false, updateCount: 0 } },
    }));
    let parserMode = 0;
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string }) => ({
      session: {
        sessionId: "renderer-session",
        sourceId: "inline:tauri",
        siteKey: "jianpian",
        api: "csp_Jianpian",
        siteType: 3,
        state: "ready",
        availabilityReason: null,
        capabilities: {
          home: true,
          category: true,
          search: true,
          detail: true,
          playback: true,
          localProxy: false,
          filters: true,
          pagination: true,
          engine: "native",
        },
      },
      method: payload.method ?? null,
      result: payload.method === "detail"
        ? { list: [{ vod_id: "movie-1", vod_name: "Movie", vod_play_from: "main", vod_play_url: "Episode$https://media.example.test/movie.m3u8|1|Movie" }] }
        : payload.method === "player"
          ? {
              parse: parserMode,
              url: parserMode === 0 ? "https://media.example.test/movie.m3u8" : "https://media.example.test/player-page",
              header: {},
              subtitles: [{
                id: "zh-main",
                label: "中文",
                language: "zh-CN",
                format: "vtt",
                url: "https://media.example.test/movie.zh.vtt",
                default: true,
                forced: false,
                source: "source",
              }],
              drm: {
                clearKeys: {
                  "feedf00d-eede-adbe-eff0-baadf00dd00d": "00112233-4455-6677-8899-aabbccddeeff",
                },
                servers: { "org.w3.clearkey": "https://license.example.test/clearkey" },
              },
            }
          : { list: [{ vod_id: "movie-1", vod_name: "Movie" }] },
      cancelled: false,
    }));
    requestPlaybackProxy.mockResolvedValue({
      sessionId: "renderer-session",
      proxyUrl: "http://127.0.0.1:43123/__qx_playback/token",
      mediaType: "hls",
      state: "ready",
    });
    requestWebviewSniffer.mockResolvedValue({
      schemaVersion: "qx.webview-sniffer.v1",
      sessionId: "renderer-session",
      state: "found",
      media: { parse: 0, url: "https://media.example.test/sniffed.m3u8", headers: {} },
      candidateCount: 1,
      rejectedCount: 0,
      dataDirectoryRemoved: true,
      platform: "windows",
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    const loaded = await api.post("/api/import/load", {
      input: JSON.stringify({ sites: [
        { key: "jianpian", name: "Jianpian", api: "csp_Jianpian", type: 3, ext: "https://api.example.test" },
        { key: "alternate", name: "Alternate", api: "csp_Jianpian", type: 3, ext: "https://api.example.test" },
      ] }),
    });
    expect(loaded.import?.status).toBe("confirmation_required");
    expect(loaded.import?.sites).toEqual([
      { key: "jianpian", name: "Jianpian", api: "csp_Jianpian" },
      { key: "alternate", name: "Alternate", api: "csp_Jianpian" },
    ]);

    const home = await api.post("/api/import/confirm");
    expect(home.state?.page).toBe("home");
    expect(home.state?.items).toEqual([{ vod_id: "movie-1", vod_name: "Movie" }]);

    const detail = await api.post("/api/detail", { vodId: "movie-1" });
    expect(detail.state?.playbackCatalog?.lines[0]?.episodes[0]?.id).toBe("https://media.example.test/movie.m3u8");

    const sources = await api.post("/api/playback-sources/search");
    expect(sources.state?.playbackSources?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteKey: "jianpian", playable: true }),
      expect.objectContaining({ siteKey: "alternate", playable: true }),
    ]));
    await api.post("/api/playback-sources/select", { siteKey: "jianpian", vodId: "movie-1" });

    const player = await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });
    expect(player.state?.player.source?.url).toContain("/__qx_playback/token");
    expect(player.state?.player.source?.drm).toEqual({
      clearKeys: {
        feedf00deedeadbeeff0baadf00dd00d: "00112233445566778899aabbccddeeff",
      },
      servers: { "org.w3.clearkey": "https://license.example.test/clearkey" },
    });
    expect(player.state?.player.source?.subtitles).toEqual([expect.objectContaining({
      id: "zh-main",
      format: "vtt",
      default: true,
    })]);
    const failed = await api.post("/api/player/sync", {
      status: "error",
      error: "HLS_SEGMENT_FAILED",
      event: { type: "fatal-error" },
    });
    expect(failed.state?.fallback).toMatchObject({
      status: "prompt",
      attempts: 0,
      next: expect.objectContaining({ id: "alternate:movie-1" }),
    });
    const fallback = await api.post("/api/player/fallback/approve");
    expect(fallback.state?.fallback).toMatchObject({
      status: "trying",
      attempts: 1,
      current: expect.objectContaining({ id: "alternate:movie-1" }),
    });
    expect(requestPlaybackProxy).toHaveBeenCalledWith(expect.objectContaining({ action: "close" }));
    expect(requestPlaybackProxy.mock.calls.filter(([payload]) => payload.action === "start")).toHaveLength(2);
    const exhausted = await api.post("/api/player/sync", {
      status: "error",
      error: "HLS_SEGMENT_FAILED",
      event: { type: "fatal-error" },
    });
    expect(exhausted.state?.fallback).toMatchObject({
      status: "stopped",
      attempts: 1,
      tried: ["alternate:movie-1"],
    });
    expect(requestPlaybackProxy).toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
    parserMode = 1;
    const sniffedPlayer = await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });
    expect(sniffedPlayer.state?.player.source?.url).toContain("/__qx_playback/token");
    expect(requestWebviewSniffer).toHaveBeenCalledWith(expect.objectContaining({
      action: "sniff",
      initialUrl: "https://media.example.test/player-page",
    }));
    await api.post("/api/view-state", { theme: "light", scrollTop: 42 });
    expect(requestBusinessData).toHaveBeenCalledWith(expect.objectContaining({ action: "upsert", entity: "view_state" }));
    const component = await api.post("/api/components/verify", { componentId: "mpv", manifestJson: "{}" });
    expect(component.state?.componentManager).toEqual(expect.objectContaining({ componentId: "mpv", verified: true }));
    await api.post("/api/close");
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "close" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("plays a direct HTTP episode from a standard CMS without a player RPC", async () => {
    const mediaUrl = "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd";
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "cms-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      sites: [{ key: "cms", name: "CMS", api: "http://127.0.0.1:59450/api.php", siteType: 1 }],
    });
    const session = {
      sessionId: "cms-session",
      sourceId: "inline:tauri",
      siteKey: "cms",
      api: "http://127.0.0.1:59450/api.php",
      siteType: 1,
      state: "ready" as const,
      availabilityReason: null,
      capabilities: {
        home: true, category: true, search: true, detail: true, playback: true,
        localProxy: false, filters: true, pagination: true, engine: "http" as const,
      },
    };
    requestSourceSession.mockImplementation(async (payload: { method?: string }) => {
      if (payload.method === "player") throw new Error("CMS player RPC must not be called");
      return {
        session,
        method: payload.method ?? null,
        result: payload.method === "detail"
          ? { list: [{ vod_id: "cms-movie", vod_name: "CMS Movie", vod_play_from: "main$$$backup", vod_play_url: `Episode$${mediaUrl}$$$Episode$${mediaUrl}` }] }
          : { list: [{ vod_id: "cms-movie", vod_name: "CMS Movie" }] },
        cancelled: false,
      };
    });
    requestPlaybackProxy.mockResolvedValue({
      sessionId: "cms-session",
      proxyUrl: "http://127.0.0.1:43123/__qx_playback/cms",
      mediaType: "dash",
      state: "ready",
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [{ key: "cms", name: "CMS", api: "http://127.0.0.1:59450/api.php", type: 1 }] }) });
    await api.post("/api/import/confirm");
    await api.post("/api/detail", { vodId: "cms-movie" });
    const player = await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });

    expect(player.state?.player.source?.url).toContain("/__qx_playback/cms");
    expect(requestPlaybackProxy).toHaveBeenCalledWith(expect.objectContaining({ action: "start", url: mediaUrl }));
    expect(requestSourceSession.mock.calls.some(([payload]) => payload.method === "player")).toBe(false);
    requestDesktopService.mockResolvedValueOnce({
      schemaVersion: "v1",
      state: {
        fallback: { mode: "prompt", status: "idle", trigger: null, reason: null, current: null, next: null, attempts: 0, maxAttempts: 3, tried: [], startedAt: null, deadlineAt: null, cooldownUntil: null, manualOverrideUntil: null },
      },
    });
    const failed = await api.post("/api/player/sync", {
      status: "error",
      error: "PLAYBACK_STARTUP_TIMEOUT",
      event: { type: "startup-timeout" },
    });
    expect(failed.state?.fallback).toMatchObject({
      status: "prompt",
      next: expect.objectContaining({ id: "line:1:episode:0", label: "backup · Episode" }),
    });
    const fallback = await api.post("/api/player/fallback/approve");
    expect(fallback.state?.fallback).toMatchObject({
      status: "trying",
      current: expect.objectContaining({ id: "line:1:episode:0" }),
    });
  });

  it("routes a JavaScript source through the Tauri QuickJS sidecar", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "quickjs-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      sites: [{
        key: "quickjs",
        name: "QuickJS",
        api: "js:export default { init() {}, home() { return { list: [{ vod_id: 'q-1' }] }; }, detail(ids) { return { list: [{ vod_id: ids[0], vod_play_from: 'main', vod_play_url: 'Episode$https://media.example.test/q.mp4' }] }; }, player() { return { parse: 0, url: 'https://media.example.test/q.mp4', header: {} }; } };",
        siteType: 3,
      }],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      value: null,
      recordCount: 0,
    });
    requestRuntimeCapability.mockResolvedValue({
      runtime: "quickjs-sidecar",
      supported: true,
      reasonCode: "quickjs_sidecar_supported",
      capabilities: { home: true, category: false, search: false, detail: true, player: true },
    });
    requestQuickJsSidecar.mockImplementation(async (payload: { action: string; name?: string }) => {
      if (payload.action === "capabilities") return { init: true, home: true, detail: true, player: true };
      if (payload.action === "load" || payload.action === "close") return { loaded: true };
      if (payload.name === "home") return { list: [{ vod_id: "q-1" }] };
      if (payload.name === "detail") return { list: [{ vod_id: "q-1", vod_play_from: "main", vod_play_url: "Episode$https://media.example.test/q.mp4" }] };
      if (payload.name === "player") return { parse: 0, url: "https://media.example.test/q.mp4", header: {} };
      return { initialized: true };
    });
    requestPlaybackProxy.mockResolvedValue({
      sessionId: "renderer-session",
      proxyUrl: "http://127.0.0.1:43123/__qx_playback/token",
      mediaType: "progressive",
      state: "ready",
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", {
      input: JSON.stringify({ sites: [{ key: "quickjs", name: "QuickJS", type: 3, api: "js:export default {}" }] }),
    });
    const home = await api.post("/api/import/confirm");
    expect(home.state?.items).toEqual([{ vod_id: "q-1" }]);
    const detail = await api.post("/api/detail", { vodId: "q-1" });
    expect(detail.state?.playbackCatalog?.lines[0]?.episodes[0]?.id).toBe("https://media.example.test/q.mp4");
    const player = await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });
    expect(player.state?.player.source?.url).toContain("/__qx_playback/token");
    expect(requestRuntimeCapability).toHaveBeenCalledWith(expect.objectContaining({ api: expect.stringContaining("js:") }));
    expect(requestQuickJsSidecar).toHaveBeenCalledWith(expect.objectContaining({ action: "capabilities" }));
    expect(requestSourceSession).not.toHaveBeenCalled();
  });

  it("persists Tauri history, favorites and follow through the Rust feature RPC", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "feature-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      sites: [{ key: "native-site", name: "Native", api: "csp_Jianpian", siteType: 3, ext: "https://api.example.test" }],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      value: null,
      recordCount: 0,
    });
    const states = {
      history: { items: [] as Record<string, unknown>[], paused: false },
      favorites: { items: [] as Record<string, unknown>[], groups: [], defaultGroupId: "default" },
      follow: { items: [] as Record<string, unknown>[], checking: false, updateCount: 0 },
    };
    const featureCalls: Array<Record<string, unknown>> = [];
    requestBusinessFeature.mockImplementation(async (payload: Record<string, unknown>) => {
      featureCalls.push(payload);
      const feature = String(payload.feature);
      if (feature === "favorites" && payload.action === "toggle") {
        const value = payload.value as Record<string, unknown>;
        states.favorites.items = [{
          favoriteId: "favorite:1",
          sourceId: value.sourceId,
          vodId: value.vodId,
          groupId: "default",
          sortOrder: 0,
        }];
      }
      if (feature === "follow" && payload.action === "upsert") {
        const value = payload.value as Record<string, unknown>;
        states.follow.items = [{ ...value, identity: payload.id, sourceId: payload.sourceId }];
      }
      if (feature === "history" && payload.action === "upsert") {
        states.history.items = [payload.value as Record<string, unknown>];
      }
      return { schemaVersion: "v1", feature, state: { [feature]: states[feature as keyof typeof states] } };
    });
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string }) => ({
      session: {
        sessionId: "feature-session",
        sourceId: "inline:tauri",
        siteKey: "native-site",
        api: "csp_Jianpian",
        siteType: 3,
        state: "ready",
        availabilityReason: null,
        capabilities: { home: true, category: true, search: true, detail: true, playback: true, localProxy: false, filters: true, pagination: true, engine: "native" },
      },
      method: payload.method ?? null,
      result: payload.method === "detail"
        ? { list: [{ vod_id: "movie-1", vod_name: "Movie", vod_play_from: "main", vod_play_url: "Episode$https://media.example.test/movie.m3u8" }] }
        : payload.method === "player"
          ? { parse: 0, url: "https://media.example.test/movie.m3u8", header: {} }
          : { list: [{ vod_id: "movie-1", vod_name: "Movie" }] },
      cancelled: false,
    }));
    requestPlaybackProxy.mockResolvedValue({
      sessionId: "feature-session",
      proxyUrl: "http://127.0.0.1:43123/__qx_playback/feature",
      mediaType: "hls",
      state: "ready",
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", {
      input: JSON.stringify({ sites: [{ key: "native-site", name: "Native", type: 3, api: "csp_Jianpian", ext: "https://api.example.test" }] }),
    });
    await api.post("/api/import/confirm");
    await api.post("/api/detail", { vodId: "movie-1" });
    await api.post("/api/favorites/toggle-detail");
    await api.post("/api/follow/toggle-detail");
    await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });
    const synced = await api.post("/api/player/sync", { currentTime: 12, duration: 120 });

    const favorite = featureCalls.find((payload) => payload.feature === "favorites" && payload.action === "toggle");
    const follow = featureCalls.find((payload) => payload.feature === "follow" && payload.action === "upsert");
    const history = featureCalls.find((payload) => payload.feature === "history" && payload.action === "upsert");
    expect((favorite?.value as Record<string, unknown>).sourceId).toMatch(/^source:[0-9a-f]+$/);
    expect((favorite?.value as Record<string, unknown>).episodes).toEqual([
      expect.objectContaining({ id: expect.not.stringContaining("http") }),
    ]);
    expect((follow?.value as Record<string, unknown>).sourceId).toMatch(/^source:[0-9a-f]+$/);
    expect((history?.value as Record<string, unknown>).episodeId).not.toContain("http");
    expect(synced.state?.history).toBeDefined();
  });

  it("routes live source and playback actions through the Rust live RPC and proxy", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1", source: "inline:tauri", sourceKind: "json", versionHash: "live-hash",
      siteCount: 1, usedCache: false, validVersionCount: 1,
      sites: [{ key: "native-site", name: "Native", api: "csp_Jianpian", siteType: 3 }],
    });
    requestBusinessData.mockResolvedValue({ schemaVersion: "v1", entity: "view_state", id: "renderer", found: false, value: null, recordCount: 0 });
    const liveState: Record<string, unknown> = {
      sources: [], preview: null, loading: false, error: null,
      catalog: { groups: [], channels: [], recent: [] }, session: null, player: null,
      epg: { sources: [], preview: null, loading: false, error: null, retention: { pastRetentionMs: 21600000, futureRetentionMs: 604800000 }, mappings: [], timeline: null },
      smartChannels: [], smartSuggestions: [], activeSmartChannel: null, health: null,
      failover: { mode: "ask", status: "idle", trigger: null, reason: null, current: null, next: null, attempts: 0, maxAttempts: 3, tried: [], startedAt: null, deadlineAt: null, cooldownUntil: null, manualOverrideUntil: null },
    };
    requestLive.mockImplementation(async (payload: { action: string }) => {
      if (payload.action === "preview") liveState.preview = { id: "preview-1", source: { id: "pending:preview-1" }, channelNames: ["News"], issues: [], stats: { channelCount: 1, groupCount: 1, streamCount: 1, invalidCount: 0, protocolCounts: {}, addedCount: 1, removedCount: 0, changedCount: 0 } };
      if (payload.action === "apply") {
        liveState.sources = [{ id: "source-1", name: "Fixture", type: "m3u-file", location: "fixture", enabled: true, refreshMode: "manual", channelCount: 1, groupCount: 1, streamCount: 1 }];
        liveState.preview = null;
        liveState.catalog = { groups: [{ id: "News", name: "News", channelCount: 1 }], channels: [{ id: "channel-1", sourceId: "source-1", sourceName: "Fixture", name: "News", group: "News", logo: null, channelNumber: null, streamCount: 1, streams: [{ id: "channel-1:stream:0", label: "线路 1", protocol: "HLS", status: "ready", health: null }], epgStatus: "unmapped", currentProgramme: null, nextProgramme: null, health: null }], recent: [] };
      }
      if (payload.action === "play") {
        liveState.session = { sessionId: "live-session", sourceId: "source-1", channelId: "channel-1", streamId: "channel-1:stream:0", smartChannelId: null, smartMemberId: null, state: "loading", backend: "hls-js", startedAt: Date.now(), firstFrameAt: null, error: null, generation: 1 };
        liveState.player = { status: "loading", source: { parse: 0, url: "https://media.example.test/live.m3u8", headers: {} }, currentTime: 0, duration: 0, volume: 1, muted: false, fullscreen: false, error: null };
      }
      if (payload.action === "stop") { liveState.session = null; liveState.player = null; }
      return { schemaVersion: "v1", state: { live: { ...liveState } } };
    });
    requestPlaybackProxy.mockImplementation(async (payload: { action: string }) => payload.action === "start"
      ? { sessionId: "live-session", proxyUrl: "http://127.0.0.1:43123/__qx_playback/live", mediaType: "hls", state: "ready" }
      : { sessionId: "live-session", proxyUrl: null, mediaType: "unknown", state: "closed" });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [{ key: "native-site", name: "Native", type: 3, api: "csp_Jianpian" }] }) });
    await api.post("/api/live/source/preview", { name: "Fixture", type: "m3u-file", content: "#EXTM3U" });
    await api.post("/api/live/source/apply", { previewId: "preview-1" });
    const playing = await api.post("/api/live/play", { channelId: "channel-1" });
    expect(playing.state?.live?.player).toEqual(expect.objectContaining({ source: expect.objectContaining({ url: expect.stringContaining("__qx_playback/live") }) }));
    await api.post("/api/live/stop");
    expect(requestLive).toHaveBeenCalledWith(expect.objectContaining({ action: "preview" }));
    expect(requestLive).toHaveBeenCalledWith(expect.objectContaining({ action: "play" }));
    expect(requestPlaybackProxy).toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
    expect(requestPlaybackProxy).toHaveBeenCalledWith(expect.objectContaining({ action: "close" }));
  });

  it("routes XMLTV preview, apply, mapping and timeline through the Rust EPG RPC", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1", source: "inline:tauri", sourceKind: "json", versionHash: "epg-hash",
      siteCount: 1, usedCache: false, validVersionCount: 1,
      sites: [{ key: "native-site", name: "Native", api: "csp_Jianpian", siteType: 3 }],
    });
    requestBusinessData.mockResolvedValue({ schemaVersion: "v1", entity: "view_state", id: "renderer", found: false, value: null, recordCount: 0 });
    const epgState: Record<string, unknown> = {
      sources: [], preview: null, loading: false, error: null,
      retention: { pastRetentionMs: 21600000, futureRetentionMs: 604800000 }, mappings: [], timeline: null,
    };
    requestEpg.mockImplementation(async (payload: { action: string }) => {
      if (payload.action === "preview") epgState.preview = { id: "epg-preview-1", source: { id: "pending:epg-preview-1" }, channelNames: ["News"], issues: [], stats: { channelCount: 1, programmeCount: 1, invalidCount: 0 } };
      if (payload.action === "apply") epgState.sources = [{ id: "epg-1", name: "Fixture EPG", type: "fixture", location: "fixture", enabled: true, channelCount: 1, programmeCount: 1 }];
      if (payload.action === "mapping-confirm") epgState.mappings = [{ id: "map-1", liveChannelId: "channel-1", epgSourceId: "epg-1", epgChannelId: "epg-1:channel:news", status: "mapped" }];
      if (payload.action === "timeline") epgState.timeline = { liveChannelId: "channel-1", items: [{ title: "Morning" }] };
      return { schemaVersion: "v1", state: { epg: { ...epgState } } };
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [{ key: "native-site", name: "Native", type: 3, api: "csp_Jianpian" }] }) });
    await api.post("/api/epg/source/preview", { name: "Fixture EPG", type: "fixture", content: "<tv/>" });
    await api.post("/api/epg/source/apply", { previewId: "epg-preview-1" });
    await api.post("/api/epg/mapping/confirm", { liveChannelId: "channel-1", epgSourceId: "epg-1", epgChannelId: "epg-1:channel:news" });
    const timeline = await api.post("/api/epg/timeline", { liveChannelId: "channel-1" });
    expect(timeline.state?.live?.epg?.sources).toHaveLength(1);
    expect(timeline.state?.live?.epg?.mappings).toHaveLength(1);
    expect(requestEpg).toHaveBeenCalledWith(expect.objectContaining({ action: "preview" }));
    expect(requestEpg).toHaveBeenCalledWith(expect.objectContaining({ action: "mapping-confirm" }));
    expect(requestEpg).toHaveBeenCalledWith(expect.objectContaining({ action: "timeline" }));
    await api.post("/api/cache/clear", { scope: "all" });
    await api.post("/api/local-media/drop", { paths: ["C:/fixture/movie.mp4"] });
    await api.post("/api/downloads/refresh");
    expect(requestDesktopService).toHaveBeenCalledWith({ action: "cache-clear", value: { scope: "all" } });
    expect(requestDesktopService).toHaveBeenCalledWith({ action: "local-drop", value: { paths: ["C:/fixture/movie.mp4"] } });
    expect(requestDesktopService).toHaveBeenCalledWith({ action: "download-refresh", value: {} });
  });
});
