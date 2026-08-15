import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ingestConfigCatalog = vi.fn();
const requestConfigCatalogMaintenance = vi.fn();
const requestBusinessData = vi.fn();
const requestBusinessFeature = vi.fn();
const requestComponentManager = vi.fn();
const requestCast = vi.fn();
const requestPush = vi.fn();
const requestDesktopService = vi.fn();
const requestLive = vi.fn();
const requestEpg = vi.fn();
const requestSourceSession = vi.fn();
const requestPlaybackFallback = vi.fn();
const requestPlaybackProxy = vi.fn();
const requestPlaybackStart = vi.fn();
const requestPlaybackSources = vi.fn();
const requestWebviewSniffer = vi.fn();
const requestRuntimeCapability = vi.fn();
const requestQuickJsSidecar = vi.fn();
const requestQuickJsSession = vi.fn();
const requestPlayerWindow = vi.fn();

vi.mock("../renderer/src/tauri-rpc.js", () => ({
  isTauriRuntime: () => true,
  ingestConfigCatalog,
  requestConfigCatalogMaintenance,
  requestBusinessData,
  requestBusinessFeature,
  requestComponentManager,
  requestCast,
  requestPush,
  requestDesktopService,
  requestLive,
  requestEpg,
  requestSourceSession,
  requestPlaybackFallback,
  requestPlaybackProxy,
  requestPlaybackStart,
  requestPlaybackSources,
  requestWebviewSniffer,
  requestRuntimeCapability,
  requestQuickJsSidecar,
  requestQuickJsSession,
  requestPlayerWindow,
}));

describe("Tauri renderer vertical slice", () => {
  beforeEach(() => {
    const fallbackSessions = new Map<string, any>();
    requestPlaybackFallback.mockImplementation(async (payload: any) => {
      if (payload.action === "begin") {
        const state = {
          mode: payload.mode ?? "prompt", status: "idle", trigger: null, reason: null,
          current: null, next: null, attempts: 0, maxAttempts: payload.maxAttempts ?? 4,
          tried: [], startedAt: 1_000, deadlineAt: 46_000,
          candidates: payload.candidates ?? [],
        };
        fallbackSessions.set(payload.sessionId, state);
        return { state, decision: { kind: "none" } };
      }
      const state = fallbackSessions.get(payload.sessionId);
      if (!state) return { state: null, decision: { kind: "none" } };
      if (payload.action === "set-mode") {
        state.mode = payload.mode;
        state.status = payload.mode === "off" ? "disabled" : state.status === "disabled" ? "idle" : state.status;
      } else if (payload.action === "trigger") {
        if (!["user-pause", "seek", "single-buffer", "short-fluctuation"].includes(payload.trigger)) {
          state.trigger = payload.trigger;
          state.reason = payload.reason;
          const next = state.candidates.find((candidate: any) => !state.tried.includes(candidate.id));
          if (state.mode === "off") state.status = "disabled";
          else if (state.mode === "prompt" && next) { state.status = "prompt"; state.next = next; }
          else if (next) {
            state.status = "trying"; state.current = next; state.next = null;
            state.tried.push(next.id); state.attempts += 1;
          } else { state.status = "stopped"; }
        }
      } else if (payload.action === "approve") {
        const next = state.candidates.find((candidate: any) => !state.tried.includes(candidate.id));
        if (state.status === "prompt" && next) {
          state.status = "trying"; state.current = next; state.next = null;
          state.tried.push(next.id); state.attempts += 1;
          return { state, decision: { kind: "attempt", candidate: next } };
        }
        return { state, decision: { kind: "none", reason: "no-prompt" } };
      } else if (payload.action === "finish") {
        state.status = payload.success ? "recovered" : "idle";
        state.current = null; state.next = null;
      } else if (payload.action === "stop") {
        state.status = "stopped"; state.reason = payload.reason; state.current = null; state.next = null;
      } else if (payload.action === "cancel") {
        state.status = "cancelled"; state.reason = payload.reason ?? "user cancelled"; state.current = null; state.next = null;
      } else if (payload.action === "clear") {
        fallbackSessions.delete(payload.sessionId);
        return { state, decision: { kind: "none" } };
      }
      const candidate = state.status === "prompt" ? state.next : state.status === "trying" ? state.current : undefined;
      return { state, decision: { kind: state.status === "prompt" ? "prompt" : "none", ...(candidate ? { candidate } : {}) } };
    });
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
    requestCast.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        cast: { discoveryStatus: "idle", devices: [], session: null, error: null },
      },
    });
    requestPush.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        push: {
          enabled: true, host: "127.0.0.1", configuredPort: 0, port: 0, listening: true,
          endpoint: "http://127.0.0.1:32123/push", confirmationPolicy: "ask", conflictMode: "replace",
          pending: [], recent: [], activeSession: null, error: null, lanControl: "disabled",
        },
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
    requestPlaybackStart.mockImplementation(async (payload: { sourceApi: string; episodeId: string; engine?: string; sessionId: string; lineName: string; vipFlags?: string[]; fallbackSubtitles?: unknown }) => {
      const direct = /^https?:\/\//iu.test(payload.sourceApi) && /^https?:\/\//iu.test(payload.episodeId);
      const sourceResult = direct
        ? { parse: 0, url: payload.episodeId, header: {} }
        : payload.engine === "quickjs"
          ? (await requestQuickJsSession({ action: "call", sessionId: payload.sessionId, method: "player", params: { flag: payload.lineName, id: payload.episodeId, vipFlags: payload.vipFlags ?? [] } })).result
          : (await requestSourceSession({ action: "call", sessionId: payload.sessionId, method: "player", params: { flag: payload.lineName, id: payload.episodeId, vipFlags: payload.vipFlags ?? [] } })).result;
      const raw = sourceResult && typeof sourceResult === "object" && !Array.isArray(sourceResult)
        ? { ...(sourceResult as Record<string, unknown>) }
        : {};
      let url = String(raw.url ?? raw.playUrl ?? raw.link ?? "");
      if (Number(raw.parse ?? 0) !== 0) {
        const sniffed = await requestWebviewSniffer({ action: "sniff", sessionId: payload.sessionId, initialUrl: url || payload.episodeId });
        const media = sniffed.media && typeof sniffed.media === "object" ? sniffed.media as Record<string, unknown> : {};
        url = String(media.url ?? "");
      }
      const mediaType = payload.sourceApi.includes("127.0.0.1") ? "dash" : "hls";
      const drm = raw.drm && typeof raw.drm === "object" ? raw.drm as Record<string, unknown> : undefined;
      return {
        playerSource: {
          parse: Number(raw.parse ?? 0),
          url: payload.sourceApi.includes("127.0.0.1") ? "http://127.0.0.1:43123/__qx_playback/cms" : "http://127.0.0.1:43123/__qx_playback/token",
          headers: {},
          mediaType,
          ...(drm ? { drm: { ...drm, clearKeys: Object.fromEntries(Object.entries((drm.clearKeys ?? {}) as Record<string, string>).map(([key, value]) => [key.replaceAll("-", "").toLowerCase(), String(value).replaceAll("-", "").toLowerCase()])) } } : {}),
          ...(Array.isArray(raw.subtitles) ? { subtitles: raw.subtitles } : {}),
        },
        backend: "embedded",
        proxy: { sessionId: payload.sessionId, proxyUrl: url, mediaType, state: "ready" },
      };
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

  it("keeps local configuration files on the preview and trust boundary", async () => {
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockImplementation(async (payload: { feature: "history" | "favorites" | "follow" }) => ({
      schemaVersion: "v1",
      feature: payload.feature,
      state: {},
    }));
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "file:local-config.json",
      sourceKind: "file",
      versionHash: "file-config-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      sites: [{ key: "local-site", name: "本地来源", api: "https://source.example.test/api", siteType: 4 }],
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const loaded = await api.post("/api/import/load-file", {
      input: JSON.stringify({ sites: [{ key: "local-site", name: "本地来源", api: "https://source.example.test/api", type: 4 }] }),
      sourceName: "C:\\Users\\qiany\\Downloads\\local-config.json",
    });

    expect(loaded.import).toMatchObject({
      inputKind: "file",
      sourceKind: "local",
      source: "file:local-config.json",
      status: "confirmation_required",
    });
    expect(ingestConfigCatalog).toHaveBeenCalledWith({
      source: "file:local-config.json",
      sourceKind: "file",
      raw: expect.stringContaining("local-site"),
    });
  });

  it("exposes Rust config history and activates a version without restoring trust", async () => {
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "new-version",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 2,
      sites: [{ key: "new-site", name: "New", api: "https://new.example.test/api", siteType: 1 }],
    });
    const history = {
      schemaVersion: "v1" as const,
      source: "inline:tauri",
      activeVersionHash: "old-version",
      versions: [{ versionHash: "old-version", sourceKind: "json" as const, siteCount: 1, createdAt: 1, active: true }],
    };
    const activated = {
      schemaVersion: "v1" as const,
      source: "inline:tauri",
      sourceKind: "json" as const,
      versionHash: "old-version",
      siteCount: 1,
      usedCache: true,
      validVersionCount: 2,
      sites: [{ key: "old-site", name: "Old", api: "https://old.example.test/api", siteType: 1 as const }],
    };
    requestConfigCatalogMaintenance.mockImplementation(async (payload: { action: "history" | "activate" }) =>
      payload.action === "history" ? history : activated);

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [{ key: "new-site" }] }) });

    const listed = await api.post("/api/import/history");
    expect(listed.configHistory).toEqual(history);

    const rolledBack = await api.post("/api/import/activate", { versionHash: "old-version" });
    expect(requestConfigCatalogMaintenance).toHaveBeenNthCalledWith(1, { action: "history", source: "inline:tauri" });
    expect(requestConfigCatalogMaintenance).toHaveBeenNthCalledWith(2, {
      action: "activate",
      source: "inline:tauri",
      versionHash: "old-version",
    });
    expect(requestConfigCatalogMaintenance).toHaveBeenNthCalledWith(3, { action: "history", source: "inline:tauri" });
    expect(rolledBack.import).toMatchObject({
      status: "confirmation_required",
      trusted: false,
      sessionReady: false,
      selectedSiteKey: "old-site",
    });
    expect(rolledBack.state).toMatchObject({ page: "import", api: "https://old.example.test/api" });
  });

  it("routes DLNA discovery through the Tauri backend boundary", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "cast-config-hash",
      siteCount: 0,
      usedCache: false,
      validVersionCount: 1,
      sites: [],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    requestCast.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        cast: {
          discoveryStatus: "ready",
          devices: [{ deviceId: "fixture-renderer" }],
          session: null,
          error: null,
        },
      },
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [] }) });
    const result = await api.post("/api/cast/discover");

    expect(requestCast).toHaveBeenCalledWith({ action: "discover", value: {} });
    expect(result.state?.cast).toMatchObject({ discoveryStatus: "ready" });
    expect(result.errorCode).toBeUndefined();
  });

  it("routes DLNA transport controls and refresh actions through the Tauri backend boundary", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "cast-control-config-hash",
      siteCount: 0,
      usedCache: false,
      validVersionCount: 1,
      sites: [],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    requestCast.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        cast: { discoveryStatus: "ready", devices: [], session: null, error: null },
      },
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [] }) });
    requestCast.mockClear();

    await api.post("/api/cast/pause");
    await api.post("/api/cast/resume");
    await api.post("/api/cast/seek", { position: 42 });
    await api.post("/api/cast/position");
    await api.post("/api/cast/transport");
    await api.post("/api/cast/refresh");

    expect(requestCast.mock.calls).toEqual([
      [{ action: "pause", value: {} }],
      [{ action: "resume", value: {} }],
      [{ action: "seek", value: { position: 42 } }],
      [{ action: "position", value: {} }],
      [{ action: "transport", value: {} }],
      [{ action: "discover", value: {} }],
    ]);
  });

  it("routes Push refresh and confirmation state through the Tauri backend boundary", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "push-config-hash",
      siteCount: 0,
      usedCache: false,
      validVersionCount: 1,
      sites: [],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    requestPush.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        push: {
          enabled: true, host: "127.0.0.1", configuredPort: 0, port: 32123, listening: true,
          endpoint: "http://127.0.0.1:32123/push", confirmationPolicy: "ask", conflictMode: "replace",
          pending: [{ id: "push-1", type: "url", title: "Fixture", targetHost: "media.example.test", requestedBy: "localhost", createdAt: 1 }],
          recent: [], activeSession: null, error: null, lanControl: "disabled",
        },
      },
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [] }) });
    const result = await api.post("/api/push/refresh");

    expect(requestPush).toHaveBeenCalledWith({ action: "refresh", value: {} });
    expect(result.state?.push).toMatchObject({ listening: true, pending: [{ id: "push-1" }] });
    expect(result.errorCode).toBeUndefined();
  });

  it("routes danmaku synchronization through the Rust desktop service", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "danmaku-sync-config-hash",
      siteCount: 0,
      usedCache: false,
      validVersionCount: 1,
      sites: [],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    requestDesktopService.mockResolvedValue({
      schemaVersion: "v1",
      state: {
        danmaku: { status: "ready", playing: true, currentTimeMs: 12_500, totalCount: 1, items: [], sources: [], settings: {}, error: null },
      },
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [] }) });
    requestDesktopService.mockClear();

    const result = await api.post("/api/danmaku/sync", { currentTime: 12.5, status: "playing" });

    expect(requestDesktopService).toHaveBeenCalledWith({
      action: "danmaku-sync",
      value: { currentTime: 12.5, status: "playing" },
    });
    expect(result.state?.danmaku).toMatchObject({ playing: true, currentTimeMs: 12_500 });
  });

  it("forwards Tauri player progress to the Rust danmaku service", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "danmaku-player-sync-config-hash",
      siteCount: 0,
      usedCache: false,
      validVersionCount: 1,
      sites: [],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [] }) });
    requestDesktopService.mockClear();

    await api.post("/api/player/sync", { currentTime: 3, duration: 10 });

    expect(requestDesktopService.mock.calls).toEqual([
      [{ action: "player-sync", value: { currentTime: 3, duration: 10 } }],
      [{ action: "danmaku-sync", value: { currentTime: 3, duration: 10 } }],
    ]);
  });

  it("starts the existing playback proxy after a confirmed URL Push", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "push-play-config-hash",
      siteCount: 0,
      usedCache: false,
      validVersionCount: 1,
      sites: [],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    requestPush.mockReset();
    requestPush
      .mockResolvedValueOnce({
        schemaVersion: "v1",
        state: {
          push: {
            enabled: true, host: "127.0.0.1", configuredPort: 0, port: 32123, listening: true,
            endpoint: "http://127.0.0.1:32123/push", confirmationPolicy: "ask", conflictMode: "replace",
            pending: [{ id: "push-1", type: "url", title: "Fixture", targetHost: "media.example.test", requestedBy: "localhost", createdAt: 1 }],
            recent: [], activeSession: null, error: null, lanControl: "disabled",
          },
        },
      })
      .mockResolvedValueOnce({
        schemaVersion: "v1",
        state: {
          push: {
            enabled: true, host: "127.0.0.1", configuredPort: 0, port: 32123, listening: true,
            endpoint: "http://127.0.0.1:32123/push", confirmationPolicy: "ask", conflictMode: "replace",
            pending: [], recent: [], activeSession: { id: "push-session", kind: "vod", title: "Fixture", state: "active" }, error: null, lanControl: "disabled",
          },
          result: {
            kind: "accepted",
            playback: { sessionId: "push-session", url: "https://media.example.test/fixture.mp4", title: "Fixture" },
          },
        },
      });
    requestPlaybackProxy.mockResolvedValue({
      sessionId: "push-session",
      proxyUrl: "http://127.0.0.1:43123/__qx_playback/push",
      mediaType: "progressive",
      state: "ready",
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [] }) });
    const result = await api.post("/api/push/confirm", { id: "push-1" });

    expect(requestPush).toHaveBeenNthCalledWith(2, {
      action: "confirm",
      value: { id: "push-1", decision: "play" },
    });
    expect(requestPlaybackProxy).toHaveBeenCalledWith({
      action: "start",
      sessionId: "push-session",
      url: "https://media.example.test/fixture.mp4",
    });
    expect(result.state?.player?.source).toMatchObject({
      url: "http://127.0.0.1:43123/__qx_playback/push",
      mediaType: "mp4",
    });
  });

  it("restores the persisted V3 route context through the existing business-data boundary", async () => {
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: true,
      value: {
        theme: "dark",
        navigation: "search",
        siteKey: "persisted-site",
        category: { typeId: "movie", page: 1, filters: { area: "US", year: "2024" } },
        search: { key: "持久化关键词", page: 2 },
        recentDetailId: "persisted-media",
        scrollTop: 128,
      },
      recordCount: 1,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "persisted-route-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      sites: [{ key: "persisted-site", name: "已保存来源", api: "https://source.example.test/api", siteType: 1 }],
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const loaded = await api.post("/api/import/load", { input: "{\"sites\":[]}" });

    expect(loaded.persistence).toMatchObject({
      theme: "dark",
      navigation: "search",
      siteKey: "persisted-site",
      category: { typeId: "movie", page: 1, filters: { area: "US", year: "2024" } },
      search: { key: "持久化关键词", page: 2 },
      recentDetailId: "persisted-media",
      scrollTop: 128,
    });
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
          : {
              class: [{ type_id: "movie", type_name: "Movie" }],
              filters: [{ id: "year", name: "Year", options: [{ id: "2026", name: "2026" }] }],
              list: [{ vod_id: "movie-1", vod_name: "Movie" }],
            },
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
      { key: "jianpian", name: "Jianpian", api: "csp_Jianpian", ext: "https://api.example.test" },
      { key: "alternate", name: "Alternate", api: "csp_Jianpian", ext: "https://api.example.test" },
    ]);

    const home = await api.post("/api/import/confirm");
    expect(home.state?.page).toBe("home");
    expect(home.state?.items).toEqual([{ vod_id: "movie-1", vod_name: "Movie" }]);
    expect(home.state?.categories).toEqual([{ id: "movie", name: "Movie" }]);
    expect(home.state?.filters).toEqual([{ id: "year", name: "Year", options: [{ id: "2026", name: "2026" }] }]);

    await api.post("/api/import/select", { siteKey: "alternate" });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({
      action: "open",
      siteKey: "alternate",
      ext: "https://api.example.test",
    }));
    const alternateOpen = requestSourceSession.mock.calls
      .map(([payload]) => payload as { action?: string; siteKey?: string; sourceId?: string })
      .find((payload) => payload.action === "open" && payload.siteKey === "alternate");
    expect(alternateOpen).toBeDefined();
    expect(alternateOpen).not.toHaveProperty("sourceId");
    expect(requestSourceSession.mock.calls.findIndex(([payload]) => (payload as { action?: string }).action === "close"))
      .toBeLessThan(requestSourceSession.mock.calls.findIndex(([payload]) => {
        const value = payload as { action?: string; siteKey?: string };
        return value.action === "open" && value.siteKey === "alternate";
      }));

    const detail = await api.post("/api/detail", { vodId: "movie-1" });
    expect(detail.state?.playbackCatalog?.lines[0]?.episodes[0]?.id).toBe("https://media.example.test/movie.m3u8");

    const sources = await api.post("/api/playback-sources/search");
    expect(sources.state?.playbackSources?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteKey: "jianpian", playable: true }),
      expect.objectContaining({ siteKey: "alternate", playable: true }),
    ]));
    expect(requestPlaybackSources).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "inline:tauri",
      currentSiteKey: "alternate",
    }));
    await api.post("/api/playback-sources/select", { siteKey: "jianpian", vodId: "movie-1" });
    const jianpianReopen = requestSourceSession.mock.calls
      .map(([payload]) => payload as { action?: string; siteKey?: string; sourceId?: string })
      .find((payload, index) => index > 0 && payload.action === "open" && payload.siteKey === "jianpian");
    expect(jianpianReopen).toBeDefined();
    expect(jianpianReopen).not.toHaveProperty("sourceId");

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
    expect(requestPlaybackFallback).toHaveBeenCalledWith(expect.objectContaining({
      action: "begin",
      mode: "prompt",
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    }));
    expect(requestPlaybackFallback).toHaveBeenCalledWith(expect.objectContaining({
      action: "trigger",
      trigger: "player-fatal",
    }));
    const fallback = await api.post("/api/player/fallback/approve");
    expect(fallback.state?.fallback).toMatchObject({
      status: "trying",
      attempts: 1,
      current: expect.objectContaining({ id: "alternate:movie-1" }),
    });
    expect(requestPlaybackFallback).toHaveBeenCalledWith(expect.objectContaining({ action: "approve" }));
    expect(requestPlaybackProxy).toHaveBeenCalledWith(expect.objectContaining({ action: "close" }));
    expect(requestPlaybackStart.mock.calls).toHaveLength(2);
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
    expect(requestPlaybackStart).toHaveBeenCalledWith(expect.objectContaining({ episodeId: expect.any(String) }));
    parserMode = 1;
    const sniffedPlayer = await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });
    expect(sniffedPlayer.state?.player.source?.url).toContain("/__qx_playback/token");
    expect(requestWebviewSniffer).toHaveBeenCalledWith(expect.objectContaining({
      action: "sniff",
      initialUrl: "https://media.example.test/player-page",
    }));
    await api.post("/api/view-state", {
      theme: "light",
      navigation: "search",
      search: { key: "持久化关键词", page: 1 },
      category: { typeId: "movie", page: 1 },
      recentDetailId: "movie-1",
      scrollTop: 42,
    });
    expect(requestBusinessData).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "upsert",
      entity: "view_state",
      value: expect.objectContaining({
        theme: "light",
        navigation: "search",
        search: { key: "持久化关键词", page: 1 },
        category: { typeId: "movie", page: 1, filters: {} },
        recentDetailId: "movie-1",
        scrollTop: 42,
      }),
    }));
    const component = await api.post("/api/components/verify", { componentId: "mpv", manifestJson: "{}" });
    expect(component.state?.componentManager).toEqual(expect.objectContaining({ componentId: "mpv", verified: true }));
    await api.post("/api/close");
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "close" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the config workspace usable when the selected source is unavailable after confirmation", async () => {
    const source = "http://xn--z7x900a.net/";
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source,
      sourceKind: "url",
      versionHash: "panda-config-hash",
      siteCount: 39,
      usedCache: false,
      validVersionCount: 1,
      sites: [{ key: "豆瓣", name: "🐼┃公众号：我不是肥猫┃", api: "csp_Douban", siteType: 3 }],
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
    const session = {
      sessionId: "panda-session",
      sourceId: source,
      siteKey: "豆瓣",
      api: "csp_Douban",
      siteType: 3,
      state: "ready" as const,
      availabilityReason: null,
      capabilities: {
        home: true, category: true, search: true, detail: true, playback: false,
        localProxy: false, filters: true, pagination: true, engine: "native" as const,
      },
    };
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string }) => {
      if (payload.action === "open") {
        return { session, method: null, result: null, cancelled: false };
      }
      throw new Error("SourceUnavailable: SOURCE_SESSION_REQUEST_FAILED");
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", { input: source });

    const confirmed = await api.post("/api/import/confirm");

    expect(confirmed.import).toMatchObject({
      status: "ready",
      trusted: true,
      sessionReady: true,
    });
    expect(confirmed.state).toMatchObject({
      page: "home",
      items: [],
      sidecarRunning: true,
    });
    expect(confirmed.errorCode).toBe("SOURCE_SESSION_REQUEST_FAILED");
    expect(confirmed.error).toContain("SOURCE_SESSION_REQUEST_FAILED");
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({
      action: "open",
      api: "csp_Douban",
      siteKey: "豆瓣",
    }));
    const openPayload = requestSourceSession.mock.calls.find(([payload]) => payload.action === "open")?.[0];
    expect(openPayload).not.toHaveProperty("sourceId");
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
    expect(requestPlaybackStart).toHaveBeenCalledWith(expect.objectContaining({ sourceApi: "http://127.0.0.1:59450/api.php", episodeId: mediaUrl }));
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

  it("keeps the last successful browse content when a source switch fails", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:source-switch",
      sourceKind: "json",
      versionHash: "source-switch-hash",
      siteCount: 2,
      usedCache: false,
      validVersionCount: 1,
      sites: [
        { key: "source-a", name: "Source A", api: "https://a.example.test/api", siteType: 1 },
        { key: "source-b", name: "Source B", api: "https://b.example.test/api", siteType: 1 },
      ],
    });
    requestBusinessData.mockResolvedValue({ found: false, value: null, recordCount: 0 });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string }) => {
      if (payload.action === "close") {
        return {
          session: {
            sessionId: "switch-session",
            sourceId: "source-switch",
            siteKey: "source-a",
            api: "https://a.example.test/api",
            siteType: 1,
            state: "closed",
            capabilities: { home: true, category: true, search: true, detail: true, playback: true, localProxy: false, filters: true, pagination: true, engine: "http" },
          },
          cancelled: false,
        };
      }
      if (payload.action === "open" && payload.siteKey === "source-b") throw new Error("SOURCE_B_UNAVAILABLE");
      return {
        session: {
          sessionId: "switch-session",
          sourceId: "source-switch",
          siteKey: "source-a",
          api: "https://a.example.test/api",
          siteType: 1,
          state: "ready",
          capabilities: { home: true, category: true, search: true, detail: true, playback: true, localProxy: false, filters: true, pagination: true, engine: "http" },
        },
        method: payload.method ?? null,
        result: { list: [{ vod_id: "stable-1", vod_name: "Still available" }] },
        cancelled: false,
      };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [
      { key: "source-a", name: "Source A", api: "https://a.example.test/api", type: 1 },
      { key: "source-b", name: "Source B", api: "https://b.example.test/api", type: 1 },
    ] }) });
    await api.post("/api/import/confirm");

    await expect(api.post("/api/import/select", { siteKey: "source-b" })).rejects.toThrow("SOURCE_B_UNAVAILABLE");
    const restored = await api.getState();
    expect(restored.import?.selectedSiteKey).toBe("source-a");
    expect(restored.state?.items).toEqual([{ vod_id: "stable-1", vod_name: "Still available" }]);
    expect(restored.state?.sidecarRunning).toBe(true);
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
    requestQuickJsSession.mockImplementation(async (payload: { action: string; method?: string }) => {
      const methods = { init: true, home: true, detail: true, player: true };
      const session = {
        sessionId: "renderer-session",
        sourceId: "renderer-session",
        siteKey: "quickjs",
        api: "js:fixture.mjs",
        siteType: 3,
        state: payload.action === "close" ? "closed" : "ready",
        capabilities: { home: true, category: false, search: false, detail: true, playback: true, localProxy: false, filters: false, pagination: false, engine: "quickjs" },
      };
      if (payload.action === "open" || payload.action === "close") return { session, methods, method: null, result: null, cancelled: payload.action === "close" };
      if (payload.method === "home") return { session, methods, method: "home", result: { list: [{ vod_id: "q-1" }] }, cancelled: false };
      if (payload.method === "detail") return { session, methods, method: "detail", result: { list: [{ vod_id: "q-1", vod_play_from: "main", vod_play_url: "Episode$https://media.example.test/q.mp4" }] }, cancelled: false };
      if (payload.method === "player") return { session, methods, method: "player", result: { parse: 0, url: "https://media.example.test/q.mp4", header: {} }, cancelled: false };
      return { session, methods, method: payload.method ?? null, result: { initialized: true }, cancelled: false };
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
    expect(requestQuickJsSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", api: expect.stringContaining("js:") }));
    expect(requestQuickJsSession).toHaveBeenCalledWith(expect.objectContaining({ action: "call", method: "home" }));
    expect(requestQuickJsSidecar).not.toHaveBeenCalled();
    expect(requestRuntimeCapability).not.toHaveBeenCalled();
    expect(requestComponentManager).not.toHaveBeenCalledWith({ action: "install-default", componentId: "quickjs" });
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
