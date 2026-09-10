import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed } from "vue";

const ingestConfigCatalog = vi.fn();
const requestConfigCatalogMaintenance = vi.fn();
const requestBusinessData = vi.fn();
const requestBusinessFeature = vi.fn();
const requestComponentManager = vi.fn();
const requestCast = vi.fn();
const requestPush = vi.fn();
const requestDesktopService = vi.fn();
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
          tried: [], startedAt: null, deadlineAt: null,
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
          if (state.startedAt === null) { state.startedAt = Date.now(); state.deadlineAt = state.startedAt + 45_000; }
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
      return { state, decision: { kind: state.status === "prompt" ? "prompt" : state.status === "trying" ? "attempt" : "none", ...(candidate ? { candidate } : {}) } };
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
          vod_play_url: "第01集$https://media.example.test/movie.m3u8|1|Movie",
        },
        score: 1,
        playable: true,
        lines: { lines: [{ index: 0, name: "main", protocol: "HLS", episodes: [{ index: 0, name: "第01集", id: "https://media.example.test/movie.m3u8" }] }] },
        hasPlayFrom: true,
        hasPlayUrl: true,
      }, {
        siteKey: "alternate",
        siteName: "Alternate",
        vod: {
          vod_id: "movie-1",
          vod_name: "Movie",
          vod_play_from: "main",
          vod_play_url: "第01集$https://media.example.test/alternate.m3u8|1|Movie",
        },
        score: 0.9,
        playable: true,
        lines: { lines: [{ index: 0, name: "main", protocol: "HLS", episodes: [{ index: 0, name: "第01集", id: "https://media.example.test/alternate.m3u8" }] }] },
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

  it("preserves the AppRJ player handoff fields in episode ids", async () => {
    const { playbackCatalog } = await import("../renderer/src/tauri-renderer-api.js");
    const playerId = "https://api.nbyjson.top:7788/api/?key=fixture&url=|opaque-target|fixture-ua|Fixture|1";

    expect(playbackCatalog({
      vod_play_from: "main",
      vod_play_url: `Episode$${playerId}`,
    }, "csp_AppRJ")?.lines[0]?.episodes[0]?.id).toBe(playerId);
    expect(playbackCatalog({
      vod_play_from: "main",
      vod_play_url: "Episode$https://media.example.test/movie.m3u8|1|Movie",
    }, "csp_Jianpian")?.lines[0]?.episodes[0]?.id).toBe("https://media.example.test/movie.m3u8");
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

  it("publishes a fast source before a slow source finishes and retries failed sources on the next query", async () => {
    let releaseSlow!: (value: any) => void;
    let slow = new Promise((resolve) => { releaseSlow = resolve; });
    let failThird = true;
    const sessions = new Map<string, string>();
    ingestConfigCatalog.mockResolvedValue({ source: "inline:progress", sourceKind: "json", siteCount: 3, sites: ["fast", "slow", "retry"].map(key => ({ key, name: key, api: `https://${key}.example.test/api`, siteType: 1 })) });
    requestBusinessData.mockResolvedValue({ found: false });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestSourceSession.mockImplementation(async (payload: any) => {
      if (payload.action === "open") sessions.set(payload.sessionId, payload.siteKey);
      const key = sessions.get(payload.sessionId) ?? "fast";
      const session = { sessionId: payload.sessionId, sourceId: key, siteKey: key, state: "ready", availabilityReason: null, capabilities: { engine: "http", home: true, search: true, detail: true, playback: true } };
      if (payload.method === "search" && key === "slow") await slow;
      if (payload.method === "search" && key === "retry" && failThird) throw new Error("SOURCE_SESSION_TIMEOUT");
      return { session, result: payload.action === "call" ? { list: [{ vod_id: key, vod_name: `${key} movie` }] } : null };
    });
    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: '{"sites":[]}' });
    await api.post("/api/import/confirm");
    const updates: any[] = [];
    const searching = api.post("/api/search", { key: "movie" }, { onProgress: (update: any) => updates.push(structuredClone(update)) });
    await vi.waitFor(() => expect(updates.some(update => update.state?.items?.some((item: any) => item.__qx_source_key === "fast"))).toBe(true));
    expect(updates.at(-1).state.searchProgress.status).toBe("running");
    const detail = await api.post("/api/detail", { siteKey: "fast", vodId: "fast" });
    expect(detail.state?.detail?.vod_id).toBe("fast");
    releaseSlow(null);
    const first = await searching;
    expect(first.state?.page).toBe("detail");
    expect(first.state?.detail?.vod_id).toBe("fast");
    expect(first.state?.items.map(item => item.__qx_source_key)).toContain("slow");
    expect(first.state?.searchProgress?.sources.find((source: any) => source.key === "retry")?.status).toBe("failed");
    failThird = false;
    slow = Promise.resolve(null);
    const second = await api.post("/api/search", { key: "movie again" });
    expect(new Set(second.state?.items.map((item: any) => item.__qx_source_key))).toEqual(new Set(["fast", "slow", "retry"]));
  });

  it("cancels a hanging home request and ignores its late response after switching sources", async () => {
    const sessions = new Map<string, string>();
    let hang = false;
    let release!: (value: any) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    ingestConfigCatalog.mockResolvedValue({ source: "inline:cancel-home", sourceKind: "json", sites: ["old", "new"].map(key => ({ key, name: key, api: `https://${key}.example.test/api`, siteType: 1 })) });
    requestBusinessData.mockResolvedValue({ found: false });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestSourceSession.mockImplementation(async (payload: any) => {
      if (payload.action === "open") sessions.set(payload.sessionId, payload.siteKey);
      const key = sessions.get(payload.sessionId) ?? "old";
      const session = { sessionId: payload.sessionId, sourceId: key, siteKey: key, state: "ready", availabilityReason: null, capabilities: { engine: "http", home: true, search: true, detail: true, playback: true } };
      if (hang && key === "old" && payload.method === "home") await delayed;
      return { session, result: payload.method === "home" ? { list: [{ vod_id: key }] } : null };
    });
    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: '{"sites":[]}' });
    await api.post("/api/import/confirm");
    hang = true;
    const old = api.post("/api/home").catch(error => error as Error);
    const switched = await api.post("/api/import/select", { siteKey: "new" });
    expect(await old).toMatchObject({ name: "AbortError" });
    expect(switched.state?.items).toEqual([{ vod_id: "new" }]);
    release(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = await api.getState();
    expect(current.import?.selectedSiteKey).toBe("new");
    expect(current.state?.items).toEqual([{ vod_id: "new" }]);
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel" }));
  });

  it("propagates cancellation through next-source switching", async () => {
    const sessions = new Map<string, string>();
    let hang = false;
    let release!: (value: any) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    ingestConfigCatalog.mockResolvedValue({ source: "inline:switch-cancel", sourceKind: "json", sites: ["old", "new"].map(key => ({ key, name: key, api: `https://${key}.example.test/api`, siteType: 1 })) });
    requestBusinessData.mockResolvedValue({ found: false });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestSourceSession.mockImplementation(async (payload: any) => {
      if (payload.action === "open") sessions.set(payload.sessionId, payload.siteKey);
      if (payload.action === "close") sessions.delete(payload.sessionId);
      const key = sessions.get(payload.sessionId) ?? payload.siteKey ?? "old";
      const session = { sessionId: payload.sessionId, sourceId: key, siteKey: key, state: payload.action === "close" ? "closed" : "ready", availabilityReason: null, capabilities: { engine: "http", home: true, search: true, detail: true, playback: true } };
      if (hang && key === "new" && payload.method === "home") await delayed;
      return { session, result: payload.method === "home" ? { list: [{ vod_id: key }] } : null };
    });
    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: '{"sites":[]}' });
    await api.post("/api/import/confirm");
    hang = true;
    const controller = new AbortController();
    const switching = api.post("/api/switch", {}, { signal: controller.signal }).catch(error => error as Error);
    await vi.waitFor(() => expect(requestSourceSession.mock.calls.some(([payload]) => payload.action === "open" && payload.siteKey === "new")).toBe(true));
    controller.abort();
    const result = await Promise.race([
      switching,
      new Promise<Error>(resolve => setTimeout(() => resolve(new Error("switch did not cancel")), 1_000)),
    ]);
    expect(result).toMatchObject({ name: "AbortError" });
    release(null);
    await switching;
  });

  it("keeps the full built-in catalog when a default remote refresh fails", async () => {
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: false,
      recordCount: 0,
    });
    requestBusinessFeature.mockResolvedValue({ schemaVersion: "v1", feature: "history", state: {} });
    const remoteSnapshot = {
      schemaVersion: "v1" as const,
      source: "http://xn--z7x900a.net/",
      sourceKind: "url" as const,
      versionHash: "fallback-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      warningCode: null,
      sites: [{ key: "荐片", name: "荐片", api: "csp_Jianpian", siteType: 3 as const, ext: "https://api.ztcgi.com" }],
    };
    ingestConfigCatalog.mockImplementation(async (payload: { fetchRemote?: boolean; raw: string }) => {
      if (payload.fetchRemote) throw new Error("InvalidConfig: remote response body could not be decoded");
      const sites = JSON.parse(payload.raw).sites.map((site: any) => ({ ...site, siteType: site.type }));
      return { ...remoteSnapshot, sites, siteCount: sites.length };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const loaded = await api.post("/api/import/load", { input: "http://xn--z7x900a.net/" });

    expect(loaded.import).toMatchObject({
      source: "http://xn--z7x900a.net/",
      status: "confirmation_required",
      selectedSiteKey: "光盘",
      warning: expect.stringContaining("内置完整来源列表"),
    });
    expect(loaded.import?.sites).toHaveLength(39);
    expect(ingestConfigCatalog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: "http://xn--z7x900a.net/",
      sourceKind: "url",
      fetchRemote: false,
      raw: expect.stringContaining('"csp_Jianpian"'),
    }));
  });

  it.each([false, true])("opens only the fixed default and repairs the old one-source cache (failure=%s)", async (failDefault) => {
    const source = "http://xn--z7x900a.net/";
    requestBusinessData.mockResolvedValue({ found: true, value: { configSource: source, siteKey: "荐片" } });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    const cached = {
      schemaVersion: "v1", source, sourceKind: "url", versionHash: "old-fallback", siteCount: 1,
      sites: [{ key: "荐片", name: "荐片", api: "csp_Jianpian", siteType: 3, ext: "https://api.ztcgi.com" }],
    };
    requestConfigCatalogMaintenance.mockImplementation(async (payload: any) => payload.action === "history"
      ? { activeVersionHash: "old-fallback", versions: [] } : cached);
    ingestConfigCatalog.mockImplementation(async (payload: any) => {
      const sites = JSON.parse(payload.raw).sites.map((site: any) => ({ ...site, siteType: site.type }));
      return { ...cached, sites, siteCount: sites.length };
    });
    let activeKey = "";
    requestSourceSession.mockImplementation(async (payload: any) => {
      if (payload.action === "open") activeKey = payload.siteKey;
      if (failDefault && activeKey === "光盘" && payload.method === "home") throw new Error("SOURCE_SESSION_REQUEST_FAILED");
      return {
        session: { sessionId: payload.sessionId, sourceId: "source", siteKey: activeKey, api: "csp_AppQi", state: "ready", availabilityReason: null,
          capabilities: { engine: "native", home: true, category: true, search: true, detail: true, playback: true } },
        result: payload.method === "home" ? { list: [{ vod_id: "home", vod_name: "推荐" }] } : null,
      };
    });
    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const restored = await api.getState();
    expect(restored.import?.sites).toHaveLength(39);
    expect(restored.import?.selectedSiteKey).toBe("光盘");
    expect(restored.state?.page).toBe("home");
    expect(ingestConfigCatalog).toHaveBeenCalledOnce();
    expect(ingestConfigCatalog).toHaveBeenCalledWith(expect.objectContaining({ source, fetchRemote: false }));
    expect(requestSourceSession.mock.calls.filter(([p]) => p.action === "open").map(([p]) => p.siteKey)).toEqual(["光盘"]);
    expect(requestSourceSession.mock.calls.filter(([p]) => p.method === "home")).toHaveLength(1);
    if (failDefault) {
      const switched = await api.post("/api/import/select", { siteKey: "干饭" });
      expect(switched.import?.selectedSiteKey).toBe("干饭");
      expect(switched.state?.items).toEqual([{ vod_id: "home", vod_name: "推荐" }]);
    }
  });

  it("bootstraps the default catalog locally without a configuration network request", async () => {
    requestBusinessData.mockResolvedValue({ found: false });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    ingestConfigCatalog.mockImplementation(async (payload: any) => ({
      source: payload.source, sourceKind: "url", sites: JSON.parse(payload.raw).sites.map((site: any) => ({ ...site, siteType: site.type })),
    }));
    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const result = await new TauriRendererApi().post("/api/import/load", { input: "http://xn--z7x900a.net/", bootstrapDefault: true });
    expect(result.import?.sites).toHaveLength(39);
    expect(result.import?.selectedSiteKey).toBe("光盘");
    expect(ingestConfigCatalog).toHaveBeenCalledOnce();
    expect(ingestConfigCatalog).toHaveBeenCalledWith(expect.objectContaining({ fetchRemote: false }));
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
        ? { list: [{ vod_id: "movie-1", vod_name: "Movie", vod_play_from: "main", vod_play_url: "第01集$https://media.example.test/movie.m3u8#第03集$https://media.example.test/episode-3.m3u8#第02集$https://media.example.test/episode-2.m3u8#第02集v2$https://media.example.test/episode-2-v2.m3u8" }] }
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

    requestSourceSession.mockClear();
    await api.post("/api/import/select", { siteKey: "alternate" });
    expect(requestBusinessData).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "upsert",
      entity: "view_state",
      value: expect.objectContaining({ siteKey: "alternate" }),
    }));
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({
      action: "open",
      siteKey: "alternate",
      ext: "https://api.example.test",
    }));
    const alternateOpen = requestSourceSession.mock.calls
      .map(([payload]) => payload as { action?: string; siteKey?: string; sourceId?: string })
      .find((payload) => payload.action === "open" && payload.siteKey === "alternate");
    expect(alternateOpen).toBeDefined();
    expect(alternateOpen).toHaveProperty("sourceId", "site:alternate");
    expect(requestSourceSession.mock.calls.findIndex(([payload]) => (payload as { action?: string }).action === "close"))
      .toBeLessThan(requestSourceSession.mock.calls.findIndex(([payload]) => {
        const value = payload as { action?: string; siteKey?: string };
        return value.action === "open" && value.siteKey === "alternate";
      }));

    const detail = await api.post("/api/detail", { vodId: "movie-1" });
    expect(detail.state?.playbackCatalog?.lines[0]?.episodes[0]?.id).toBe("https://media.example.test/movie.m3u8");
    expect(detail.state?.playbackCatalog?.lines[0]?.episodes.map((episode) => episode.name)).toEqual([
      "第01集",
      "第02集",
      "第02集v2",
      "第03集",
    ]);

    const sources = await api.post("/api/playback-sources/search");
    expect(sources.state?.playbackSources?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteKey: "jianpian", playable: true }),
      expect.objectContaining({ siteKey: "alternate", playable: true }),
    ]));
    expect(requestPlaybackSources).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "inline:tauri",
      currentSiteKey: "alternate",
      currentPlayback: true,
    }));
    await api.post("/api/player/fallback/mode", { mode: "prompt" });
    await api.post("/api/playback-sources/select", { siteKey: "jianpian", vodId: "movie-1" });
    const jianpianReopen = requestSourceSession.mock.calls
      .map(([payload]) => payload as { action?: string; siteKey?: string; sourceId?: string })
      .find((payload, index) => index > 0 && payload.action === "open" && payload.siteKey === "jianpian");
    expect(jianpianReopen).toBeDefined();
    expect(jianpianReopen).toHaveProperty("sourceId", "site:jianpian");

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
    await api.post("/api/player/fallback/mode", { mode: "prompt" });
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
    const source = "https://source.example.test/unavailable-config.json";
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
    expect(openPayload).toHaveProperty("sourceId", "site:豆瓣");
  });

  it("aggregates search results across configured sources and keeps the source on detail navigation", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:multi-search",
      sourceKind: "json",
      versionHash: "multi-search-hash",
      siteCount: 2,
      usedCache: false,
      validVersionCount: 1,
      sites: [
        { key: "source-a", name: "来源 A", api: "https://a.example.test/api", siteType: 1 },
        { key: "source-b", name: "来源 B", api: "https://b.example.test/api", siteType: 1 },
      ],
    });
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1", entity: "view_state", id: "renderer", found: false, value: null, recordCount: 0,
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
    const probeSites = new Map<string, string>();
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string; api?: string; sessionId?: string }) => {
      const siteKey = payload.siteKey ?? probeSites.get(payload.sessionId ?? "") ?? "source-a";
      const api = payload.api ?? `https://${siteKey}.example.test/api`;
      const session = {
        sessionId: "test-session",
        sourceId: `backend-${siteKey}`,
        siteKey,
        api,
        siteType: 1 as const,
        state: payload.action === "close" ? "closed" as const : "ready" as const,
        capabilities: {
          home: true, category: true, search: true, detail: siteKey !== "source-b", playback: siteKey !== "source-b",
          localProxy: false, filters: true, pagination: true, engine: "http" as const,
        },
      };
      if (payload.action === "open" && payload.sessionId) probeSites.set(payload.sessionId, siteKey);
      if (payload.method === "detail") return {
        session,
        method: "detail",
        result: {
          list: [{
            vod_id: `${siteKey}-detail`,
            vod_name: `${siteKey} detail`,
            vod_content: "<p><span style=\"font-family: &quot;Helvetica Neue&quot;&quot;>简介内容&nbsp;&amp; 更多</span></p>",
          }],
        },
        cancelled: false,
      };
      if (payload.method === "search") return { session, method: "search", result: { list: [{ vod_id: `${siteKey}-search`, vod_name: `${siteKey} result` }] }, cancelled: false };
      if (payload.method === "home") return { session, method: "home", result: { list: [] }, cancelled: false };
      return { session, method: payload.method ?? null, result: null, cancelled: false };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: "{\"sites\":[]}" });
    await api.post("/api/import/select", { siteKey: "source-b" });
    const search = await api.post("/api/search", { key: "关键词", page: 1, quick: false });

    expect(search.state?.items.map((item) => item.__qx_source_key)).toEqual(["source-b", "source-a"]);
    expect(search.state?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ vod_id: "source-a-search", __qx_source_key: "source-a", __qx_source_name: "来源 A", __qx_detail_available: true }),
      expect.objectContaining({ vod_id: "source-b-search", __qx_source_key: "source-b", __qx_source_name: "来源 B", __qx_detail_available: false }),
    ]));

    const detail = await api.post("/api/detail", { vodId: "source-b-search", siteKey: "source-b" });
    expect(detail.state?.detail).toMatchObject({
      vod_id: "source-b-detail",
      vod_content: "简介内容 & 更多",
    });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "source-b" }));
  });

  it("rechecks failed source availability for each query within the six-second source budget", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:availability-cache",
      sourceKind: "json",
      versionHash: "availability-cache-hash",
      siteCount: 3,
      usedCache: false,
      validVersionCount: 1,
      sites: [
        { key: "source-a", name: "来源 A", api: "https://a.example.test/api", siteType: 1 },
        { key: "source-b", name: "不可用来源", api: "https://b.example.test/api", siteType: 1 },
        { key: "source-c", name: "来源 C", api: "https://c.example.test/api", siteType: 1 },
      ],
    });
    requestBusinessData.mockResolvedValue({ found: false, value: null, recordCount: 0 });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    const sessionSites = new Map<string, string>();
    const available = new Set(["source-a", "source-c"]);
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string; sessionId?: string }) => {
      const siteKey = payload.siteKey ?? sessionSites.get(payload.sessionId ?? "") ?? "source-a";
      const session = {
        sessionId: payload.sessionId ?? "session",
        sourceId: `backend-${siteKey}`,
        siteKey,
        api: `https://${siteKey}.example.test/api`,
        siteType: 1 as const,
        state: payload.action === "close" ? "closed" as const : "ready" as const,
        availabilityReason: available.has(siteKey) ? null : "SOURCE_UNAVAILABLE",
        capabilities: {
          home: true, category: true, search: true, detail: true, playback: true,
          localProxy: false, filters: true, pagination: true, engine: "http" as const,
        },
      };
      if (payload.action === "open" && payload.sessionId) sessionSites.set(payload.sessionId, siteKey);
      if (payload.method === "home") return { session, method: "home", result: { list: [] }, cancelled: false };
      if (payload.method === "search") return { session, method: "search", result: { list: [{ vod_id: `${siteKey}-result`, vod_name: siteKey }] }, cancelled: false };
      return { session, method: payload.method ?? null, result: null, cancelled: false };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [
      { key: "source-a", name: "来源 A", api: "https://a.example.test/api", type: 1 },
      { key: "source-b", name: "不可用来源", api: "https://b.example.test/api", type: 1 },
      { key: "source-c", name: "来源 C", api: "https://c.example.test/api", type: 1 },
    ] }) });
    await api.post("/api/import/confirm");
    const first = await api.post("/api/search", { key: "第一次", page: 1 });
    const second = await api.post("/api/search", { key: "第二次", page: 1 });

    expect(first.state?.items.map((item) => item.__qx_source_key)).toEqual(expect.arrayContaining(["source-a", "source-c"]));
    expect(second.state?.items.map((item) => item.__qx_source_key)).toEqual(expect.arrayContaining(["source-a", "source-c"]));
    expect(requestSourceSession.mock.calls.filter(([payload]) => payload.action === "open" && payload.siteKey === "source-b")).toHaveLength(2);
    expect(requestSourceSession.mock.calls.filter(([payload]) => payload.action === "open" && payload.siteKey === "source-c")).toHaveLength(2);
    // confirm 5s-probes preferred then reopens a long-lived session (probe always closed), plus two searches.
    expect(requestSourceSession.mock.calls.filter(([payload]) => payload.action === "open" && payload.siteKey === "source-a")).toHaveLength(4);
    expect(requestSourceSession.mock.calls.filter(([payload]) => payload.method === "search" && sessionSites.get(payload.sessionId) === "source-b")).toHaveLength(0);
    expect(requestSourceSession.mock.calls
      .filter(([payload]) => payload.action === "open" && payload.siteKey === "source-b")
      .every(([payload]) => payload.timeoutMs > 0 && payload.timeoutMs <= 6_000)).toBe(true);
    expect(requestSourceSession.mock.calls
      .filter(([payload]) => payload.method === "search")
      .every(([payload]) => payload.timeoutMs > 0 && payload.timeoutMs <= 6_000)).toBe(true);
  });

  it("cancels an obsolete search before its responses can replace the latest query", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:concurrent-availability",
      sourceKind: "json",
      versionHash: "concurrent-availability-hash",
      siteCount: 2,
      usedCache: false,
      validVersionCount: 1,
      sites: [
        { key: "source-a", name: "来源 A", api: "https://a.example.test/api", siteType: 1 },
        { key: "source-b", name: "不可用来源", api: "https://b.example.test/api", siteType: 1 },
      ],
    });
    requestBusinessData.mockResolvedValue({ found: false, value: null, recordCount: 0 });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    const sessionSites = new Map<string, string>();
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string; sessionId?: string; params?: { key?: string } }) => {
      const siteKey = payload.siteKey ?? sessionSites.get(payload.sessionId ?? "") ?? "source-a";
      const available = siteKey === "source-a";
      const session = {
        sessionId: payload.sessionId ?? "session",
        sourceId: `backend-${siteKey}`,
        siteKey,
        api: `https://${siteKey}.example.test/api`,
        siteType: 1 as const,
        state: payload.action === "close" ? "closed" as const : "ready" as const,
        availabilityReason: available ? null : "SOURCE_UNAVAILABLE",
        capabilities: {
          home: true, category: true, search: true, detail: true, playback: true,
          localProxy: false, filters: true, pagination: true, engine: "http" as const,
        },
      };
      if (payload.action === "open" && payload.sessionId) sessionSites.set(payload.sessionId, siteKey);
      if (payload.method === "home") return { session, method: "home", result: { list: [] }, cancelled: false };
      if (payload.method === "search") {
        return {
          session,
          method: "search",
          result: { list: [{ vod_id: `${siteKey}-${payload.params?.key ?? ""}`, vod_name: siteKey }] },
          cancelled: false,
        };
      }
      return { session, method: payload.method ?? null, result: null, cancelled: false };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [
      { key: "source-a", name: "来源 A", api: "https://a.example.test/api", type: 1 },
      { key: "source-b", name: "不可用来源", api: "https://b.example.test/api", type: 1 },
    ] }) });
    await api.post("/api/import/confirm");

    const [first, second] = await Promise.all([
      api.post("/api/search", { key: "第一次", page: 1 }).catch(error => error as Error),
      api.post("/api/search", { key: "第二次", page: 1 }),
    ]);

    expect(first).toMatchObject({ name: "AbortError" });
    expect(second.state?.items).toEqual([expect.objectContaining({ vod_id: "source-a-第二次" })]);
    expect(requestSourceSession.mock.calls.filter(([payload]) => payload.action === "open" && payload.siteKey === "source-b")).toHaveLength(2);
    expect(requestSourceSession.mock.calls.filter(([payload]) => payload.method === "search" && sessionSites.get(payload.sessionId) === "source-a")).toHaveLength(1);
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel" }));
    expect((await api.getState()).state?.items).toEqual(second.state?.items);
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
    await api.post("/api/player/fallback/mode", { mode: "prompt" });
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

  it("restores the previously trusted config source on a fresh Tauri renderer start", async () => {
    const source = "https://source.example.test/config.json";
    const session = {
      sessionId: "restored-session",
      sourceId: source,
      siteKey: "remembered-site",
      api: "https://source.example.test/api",
      siteType: 1,
      state: "ready" as const,
      availabilityReason: null,
      capabilities: {
        home: true, category: true, search: true, detail: true, playback: true,
        localProxy: false, filters: true, pagination: true, engine: "http" as const,
      },
    };
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: true,
      value: { configSource: source, siteKey: "remembered-site", navigation: "home" },
      recordCount: 1,
    });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestCast.mockResolvedValue({ state: { cast: {} } });
    requestPush.mockResolvedValue({ state: { push: {} } });
    requestDesktopService.mockResolvedValue({ state: {} });
    requestConfigCatalogMaintenance.mockImplementation(async (payload: { action: "history" | "activate" }) => payload.action === "history"
      ? {
          schemaVersion: "v1",
          source,
          activeVersionHash: "remembered-version",
          versions: [{ versionHash: "remembered-version", sourceKind: "url", siteCount: 1, createdAt: 1, active: true }],
        }
      : {
          schemaVersion: "v1",
          source,
          sourceKind: "url",
          versionHash: "remembered-version",
          siteCount: 2,
          usedCache: true,
          validVersionCount: 1,
          sites: [
            { key: "first-site", name: "First", api: "https://first.example.test/api", siteType: 1 },
            { key: "remembered-site", name: "Remembered", api: session.api, siteType: 1 },
          ],
        });
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string }) => ({
      session,
      method: payload.method ?? null,
      result: payload.method === "home" ? { list: [{ vod_id: "restored-media", vod_name: "Restored media" }] } : null,
      cancelled: false,
    }));

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const restored = await api.getState();

    expect(restored.import).toMatchObject({ status: "ready", trusted: true, sessionReady: true, selectedSiteKey: "remembered-site" });
    expect(restored.state).toMatchObject({ page: "home", items: [{ vod_id: "restored-media" }] });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "remembered-site" }));
    expect(requestConfigCatalogMaintenance).toHaveBeenNthCalledWith(1, { action: "history", source });
    expect(requestConfigCatalogMaintenance).toHaveBeenNthCalledWith(2, { action: "activate", source, versionHash: "remembered-version" });
  });

  it("opens Jianpian by default without probing every source for latency", async () => {
    const source = "https://source.example.test/config.json";
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: true,
      value: { configSource: source, navigation: "home" },
      recordCount: 1,
    });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestCast.mockResolvedValue({ state: { cast: {} } });
    requestPush.mockResolvedValue({ state: { push: {} } });
    requestDesktopService.mockResolvedValue({ state: {} });
    requestConfigCatalogMaintenance.mockImplementation(async (payload: { action: "history" | "activate" }) => payload.action === "history"
      ? {
          schemaVersion: "v1",
          source,
          activeVersionHash: "default-version",
          versions: [{ versionHash: "default-version", sourceKind: "url", siteCount: 2, createdAt: 1, active: true }],
        }
      : {
          schemaVersion: "v1",
          source,
          sourceKind: "url",
          versionHash: "default-version",
          siteCount: 2,
          usedCache: true,
          validVersionCount: 1,
          sites: [
            { key: "alternate", name: "更快来源", api: "https://alternate.example.test/api", siteType: 1 },
            { key: "jianpian", name: "荐片", api: "csp_Jianpian", siteType: 3, ext: "https://api.example.test" },
          ],
        });
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string; api?: string }) => {
      const siteKey = payload.siteKey ?? "jianpian";
      const session = {
        sessionId: "default-session",
        sourceId: `backend-${siteKey}`,
        siteKey,
        api: payload.api ?? (siteKey === "jianpian" ? "csp_Jianpian" : "https://alternate.example.test/api"),
        siteType: siteKey === "jianpian" ? 3 as const : 1 as const,
        state: payload.action === "close" ? "closed" as const : "ready" as const,
        availabilityReason: null,
        capabilities: {
          home: true, category: true, search: true, detail: true, playback: true,
          localProxy: false, filters: true, pagination: true, engine: siteKey === "jianpian" ? "native" as const : "http" as const,
        },
      };
      return {
        session,
        method: payload.method ?? null,
        result: payload.method === "home" ? { list: [{ vod_id: "jianpian-home", vod_name: "荐片首页" }] } : null,
        cancelled: false,
      };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const restored = await api.getState();

    expect(restored.import).toMatchObject({ status: "ready", trusted: true, sessionReady: true, selectedSiteKey: "jianpian" });
    expect(restored.state).toMatchObject({ page: "home", items: [{ vod_id: "jianpian-home" }] });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "jianpian" }));
    expect(requestSourceSession).not.toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "alternate" }));
    const searched = await api.post("/api/search", { key: "后台可用源探测" });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "alternate" }));
    expect(searched.state?.page).toBe("search");
  });

  it("falls back from a dead remembered 肥猫 site to 荐片 without substituting a public mirror", async () => {
    const source = "https://source.example.test/config.json";
    requestBusinessData.mockResolvedValue({
      schemaVersion: "v1",
      entity: "view_state",
      id: "renderer",
      found: true,
      value: { configSource: source, siteKey: "肥猫", navigation: "home" },
      recordCount: 1,
    });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    requestCast.mockResolvedValue({ state: { cast: {} } });
    requestPush.mockResolvedValue({ state: { push: {} } });
    requestDesktopService.mockResolvedValue({ state: {} });
    requestConfigCatalogMaintenance.mockImplementation(async (payload: { action: "history" | "activate" }) => payload.action === "history"
      ? {
          schemaVersion: "v1",
          source,
          activeVersionHash: "feimao-version",
          versions: [{ versionHash: "feimao-version", sourceKind: "url", siteCount: 2, createdAt: 1, active: true }],
        }
      : {
          schemaVersion: "v1",
          source,
          sourceKind: "url",
          versionHash: "feimao-version",
          siteCount: 2,
          usedCache: true,
          validVersionCount: 1,
          sites: [
            { key: "肥猫", name: "肥猫", api: "csp_AppGet", siteType: 3, ext: "https://cms140.yhg.one/api.php/getappapi.index/initV119" },
            { key: "jianpian", name: "荐片", api: "csp_Jianpian", siteType: 3, ext: "https://api.example.test" },
          ],
        });
    const sessionSites = new Map<string, string>();
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string; api?: string; sessionId?: string }) => {
      const siteKey = payload.siteKey ?? sessionSites.get(payload.sessionId ?? "") ?? "肥猫";
      if (payload.action === "open" && payload.sessionId) sessionSites.set(payload.sessionId, siteKey);
      if (siteKey === "肥猫") {
        throw new Error("APPGET_HTTP_FAILED");
      }
      const session = {
        sessionId: payload.sessionId ?? "jianpian-session",
        sourceId: `backend-${siteKey}`,
        siteKey,
        api: payload.api ?? "csp_Jianpian",
        siteType: 3 as const,
        state: payload.action === "close" ? "closed" as const : "ready" as const,
        availabilityReason: null,
        capabilities: {
          home: true, category: true, search: true, detail: true, playback: true,
          localProxy: false, filters: true, pagination: true, engine: "native" as const,
        },
      };
      return {
        session,
        method: payload.method ?? null,
        result: payload.method === "home" ? { list: [{ vod_id: "jianpian-home", vod_name: "荐片首页" }] } : null,
        cancelled: false,
      };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    const restored = await api.getState();

    expect(restored.import).toMatchObject({
      status: "ready",
      trusted: true,
      sessionReady: true,
      selectedSiteKey: "jianpian",
      warning: "肥猫主站暂不可达，已切换到可用来源。",
    });
    expect(restored.state).toMatchObject({
      page: "home",
      items: [{ vod_id: "jianpian-home" }],
      warning: "肥猫主站暂不可达，已切换到可用来源。",
    });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "jianpian" }));
    expect(requestSourceSession).not.toHaveBeenCalledWith(expect.objectContaining({
      siteKey: expect.stringMatching(/bind\.315999|app7\.555618|tvboxo/i),
    }));
    expect(requestBusinessData).toHaveBeenCalledWith(expect.objectContaining({
      action: "upsert",
      entity: "view_state",
      value: expect.objectContaining({ siteKey: "jianpian" }),
    }));

    const feimaoOpensBeforeSearch = requestSourceSession.mock.calls.filter(
      ([payload]) => payload.action === "open" && payload.siteKey === "肥猫",
    ).length;
    expect(feimaoOpensBeforeSearch).toBeGreaterThan(0);
    const searched = await api.post("/api/search", { key: "跳过死源" });
    expect(searched.state?.page).toBe("search");
    expect(requestSourceSession.mock.calls.filter(
      ([payload]) => payload.action === "open" && payload.siteKey === "肥猫",
    )).toHaveLength(feimaoOpensBeforeSearch + 1);
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "jianpian" }));
  });

  it("falls back from a dead first site to the next live site with a generic warning", async () => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:dead-first",
      sourceKind: "json",
      versionHash: "dead-first-hash",
      siteCount: 2,
      usedCache: false,
      validVersionCount: 1,
      sites: [
        { key: "source-dead", name: "失效来源", api: "https://dead.example.test/api", siteType: 1 },
        { key: "source-live", name: "可用来源", api: "https://live.example.test/api", siteType: 1 },
      ],
    });
    requestBusinessData.mockResolvedValue({ found: false, value: null, recordCount: 0 });
    requestBusinessFeature.mockResolvedValue({ state: {} });
    const sessionSites = new Map<string, string>();
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; siteKey?: string; sessionId?: string }) => {
      const siteKey = payload.siteKey ?? sessionSites.get(payload.sessionId ?? "") ?? "source-dead";
      if (payload.action === "open" && payload.sessionId) sessionSites.set(payload.sessionId, siteKey);
      if (siteKey === "source-dead") throw new Error("SOURCE_UNAVAILABLE");
      const session = {
        sessionId: payload.sessionId ?? "live-session",
        sourceId: `backend-${siteKey}`,
        siteKey,
        api: `https://${siteKey}.example.test/api`,
        siteType: 1 as const,
        state: payload.action === "close" ? "closed" as const : "ready" as const,
        availabilityReason: null,
        capabilities: {
          home: true, category: true, search: true, detail: true, playback: true,
          localProxy: false, filters: true, pagination: true, engine: "http" as const,
        },
      };
      return {
        session,
        method: payload.method ?? null,
        result: payload.method === "home" ? { list: [{ vod_id: "live-home", vod_name: "可用首页" }] } : null,
        cancelled: false,
      };
    });

    const { TauriRendererApi } = await import("../renderer/src/tauri-renderer-api.js");
    const api = new TauriRendererApi();
    await api.post("/api/import/load", { input: JSON.stringify({ sites: [
      { key: "source-dead", name: "失效来源", api: "https://dead.example.test/api", type: 1 },
      { key: "source-live", name: "可用来源", api: "https://live.example.test/api", type: 1 },
    ] }) });
    const confirmed = await api.post("/api/import/confirm");

    expect(confirmed.import).toMatchObject({
      status: "ready",
      trusted: true,
      sessionReady: true,
      selectedSiteKey: "source-live",
      warning: "当前来源暂不可用，已切换到可用来源。",
    });
    expect(confirmed.state).toMatchObject({
      page: "home",
      items: [{ vod_id: "live-home" }],
      warning: "当前来源暂不可用，已切换到可用来源。",
    });
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "source-live" }));
    expect(requestBusinessData).toHaveBeenCalledWith(expect.objectContaining({
      action: "upsert",
      entity: "view_state",
      value: expect.objectContaining({ siteKey: "source-live" }),
    }));

    const deadOpensBeforeSearch = requestSourceSession.mock.calls.filter(
      ([payload]) => payload.action === "open" && payload.siteKey === "source-dead",
    ).length;
    expect(deadOpensBeforeSearch).toBeGreaterThan(0);
    await api.post("/api/search", { key: "跳过首页死源" });
    expect(requestSourceSession.mock.calls.filter(
      ([payload]) => payload.action === "open" && payload.siteKey === "source-dead",
    )).toHaveLength(deadOpensBeforeSearch + 1);
  });

  it("routes the fixed TuXiaoBei JavaScript catalog entry through the Rust HTTP session", async () => {
    const apiUrl = "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js";
    const ext = "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js";
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "tuxiaobei-hash",
      siteCount: 1,
      usedCache: false,
      validVersionCount: 1,
      sites: [{ key: "儿童", name: "儿童", api: apiUrl, siteType: 3, ext }],
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
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string }) => {
      const session = {
        sessionId: "renderer-session",
        sourceId: "site:儿童",
        siteKey: "儿童",
        api: apiUrl,
        siteType: 3,
        state: payload.action === "close" ? "closed" : "ready",
        availabilityReason: null,
        capabilities: { home: true, category: true, search: true, detail: true, playback: true, localProxy: false, filters: false, pagination: true, engine: "http-json-jsonp-html" },
      };
      const result = payload.method === "home"
        ? { list: [{ vod_id: "https://www.tuxiaobei.com/play/2384", vod_name: "江南style" }] }
        : payload.method === "detail"
          ? { list: [{ vod_id: "https://www.tuxiaobei.com/play/2384", vod_name: "江南style", vod_play_from: "兔小贝", vod_play_url: "正片$https://www.tuxiaobei.com/play/2384" }] }
          : null;
      return { session, method: payload.method ?? null, result, cancelled: payload.action === "close" };
    });

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", {
      input: JSON.stringify({ sites: [{ key: "儿童", name: "儿童", type: 3, api: apiUrl, ext }] }),
    });
    const home = await api.post("/api/import/confirm");
    expect(home.state?.items).toEqual([{ vod_id: "https://www.tuxiaobei.com/play/2384", vod_name: "江南style" }]);
    const detail = await api.post("/api/detail", { vodId: "https://www.tuxiaobei.com/play/2384" });
    expect(detail.state?.playbackCatalog?.lines[0]?.episodes[0]?.id).toBe("https://www.tuxiaobei.com/play/2384");
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "open", siteKey: "儿童", api: apiUrl, ext }));
    expect(requestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ action: "call", method: "detail" }));
    expect(requestQuickJsSession).not.toHaveBeenCalled();
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

  it.each(["single error", "duplicate errors", "parser failure", "cancel during trigger", "late stop", "late progress"] as const)("keeps playback fallback on the same episode: %s", async (scenario) => {
    ingestConfigCatalog.mockResolvedValue({
      schemaVersion: "v1",
      source: "inline:tauri",
      sourceKind: "json",
      versionHash: "fallback-hash",
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
    requestBusinessFeature.mockImplementation(async (payload: { feature: string }) => ({
      schemaVersion: "v1",
      feature: payload.feature,
      state: payload.feature === "history"
        ? { history: { items: [], paused: false } }
        : payload.feature === "favorites"
          ? { favorites: { items: [], groups: [], defaultGroupId: "default" } }
          : { follow: { items: [], checking: false, updateCount: 0 } },
    }));
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; sessionId?: string }) => ({
      session: {
        sessionId: payload.sessionId ?? "fallback-session",
        sourceId: "fallback-source",
        siteKey: "native-site",
        api: "csp_Jianpian",
        siteType: 3,
        state: "ready",
        availabilityReason: null,
        capabilities: { home: true, category: true, search: true, detail: true, playback: true, localProxy: false, filters: true, pagination: true, engine: "native" },
      },
      method: payload.method ?? null,
      result: payload.method === "detail"
        ? {
            list: [{
              vod_id: "movie-1",
              vod_name: "Movie",
              vod_play_from: "优选一号$$$优选二号$$$优选八号",
              vod_play_url: [
                "第01集$https://media.example.test/main-1.m3u8#第02集$https://media.example.test/main-2.m3u8#第03集$https://media.example.test/main-3.m3u8",
                "第01集$https://media.example.test/backup-1.m3u8#第02集$https://media.example.test/backup-2.m3u8#第03集$https://media.example.test/backup-3.m3u8",
                "第01集$https://media.example.test/eight-1.m3u8#第02集$https://media.example.test/eight-2.m3u8#第03集$https://media.example.test/eight-3.m3u8",
              ].join("$$$"),
            }],
          }
        : payload.method === "player"
          ? { parse: 0, url: "https://media.example.test/resolved.m3u8", header: {} }
          : { list: [{ vod_id: "movie-1", vod_name: "Movie" }] },
      cancelled: false,
    }));

    const { RendererApi } = await import("../renderer/src/api.js");
    const api = new RendererApi();
    await api.post("/api/import/load", {
      input: JSON.stringify({ sites: [{ key: "native-site", name: "Native", type: 3, api: "csp_Jianpian", ext: "https://api.example.test" }] }),
    });
    await api.post("/api/import/confirm");
    await api.post("/api/detail", { vodId: "movie-1" });
    await api.post("/api/player", { lineIndex: 0, episodeIndex: 1 });

    const begin = requestPlaybackFallback.mock.calls
      .map(([payload]) => payload as { action?: string; candidates?: Array<Record<string, unknown>> })
      .filter((payload) => payload.action === "begin")
      .at(-1);
    expect(begin?.candidates).toEqual([
      expect.objectContaining({ id: "line:1:episode:1", label: "优选二号 · 第02集", kind: "same-content" }),
      expect.objectContaining({ id: "line:2:episode:1", label: "优选八号 · 第02集", kind: "same-content" }),
    ]);
    const failure = { status: "error", currentTime: 82, volume: 0.4, muted: true, playbackRate: 1.5, event: { type: "fatal-error" } };
    const startsBefore = requestPlaybackStart.mock.calls.length;
    if (scenario === "late stop" || scenario === "late progress") {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const pending = new Promise<void>(resolve => { entered = resolve; });
      let hold = true;
      if (scenario === "late stop") {
        const original = requestPlaybackProxy.getMockImplementation()!;
        requestPlaybackProxy.mockImplementation(async (payload: any) => {
          if (payload.action === "close" && hold) { hold = false; entered(); await held; }
          return original(payload);
        });
      } else {
        const original = requestDesktopService.getMockImplementation()!;
        requestDesktopService.mockImplementation(async (payload: any) => {
          if (payload.action === "player-sync" && hold) {
            hold = false; entered(); await held;
            return { state: { player: { status: "playing", currentTime: 999 } } };
          }
          return original(payload);
        });
      }
      const old = scenario === "late stop" ? api.post("/api/player/stop")
        : api.post("/api/player/sync", { status: "playing", currentTime: 999 });
      await pending;
      const newer = await api.post("/api/player", { lineIndex: 0, episodeIndex: 2 });
      release();
      await old;
      const state = await api.getState();
      expect(state.state?.playbackSession?.id).toBe(newer.state?.playbackSession?.id);
      expect(state.state?.playbackSelection?.episodeIndex).toBe(2);
      expect(state.state?.player).toMatchObject({ status: "loading", currentTime: 0 });
      expect(state.state?.player?.source).not.toBeNull();
      return;
    }
    if (scenario === "parser failure") requestPlaybackStart.mockRejectedValueOnce(new Error("PLAYBACK_UPSTREAM_CONNECT_FAILED"));
    if (scenario === "cancel during trigger") {
      const original = requestPlaybackFallback.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let triggered!: () => void;
      const entered = new Promise<void>(resolve => { triggered = resolve; });
      requestPlaybackFallback.mockImplementation(async (payload: any) => {
        const result = await original(payload);
        if (payload.action === "trigger") { triggered(); await held; }
        return result;
      });
      const recovering = api.post("/api/player/sync", failure);
      await entered;
      await api.post("/api/player/fallback/cancel");
      release();
      await recovering;
      expect(requestPlaybackStart.mock.calls.length).toBe(startsBefore);
      expect((await api.getState()).state?.fallback?.status).toBe("cancelled");
      return;
    }
    const recovering = api.post("/api/player/sync", failure);
    if (scenario === "duplicate errors") {
      await Promise.all([api.post("/api/player/sync", failure), api.post("/api/player/sync", failure)]);
    }
    const recovered = await recovering;
    expect(recovered.state?.fallback?.status).toBe("trying");
    expect(recovered.state?.player).toMatchObject({ currentTime: 82, volume: 0.4, muted: true, playbackRate: 1.5 });
    expect(requestPlaybackStart.mock.calls.length - startsBefore).toBe(scenario === "parser failure" ? 2 : 1);
    expect(requestPlaybackStart.mock.calls.at(-1)?.[0].episodeId).toContain(scenario === "parser failure" ? "eight-2" : "backup-2");
    expect(recovered.state?.playbackSelection).toEqual({ lineIndex: scenario === "parser failure" ? 2 : 1, episodeIndex: 1 });
    const playing = await api.post("/api/player/sync", { status: "playing", currentTime: 82 });
    expect(playing.state?.fallback?.status).toBe("trying");
    const decoded = await api.post("/api/player/sync", { status: "playing", currentTime: 82.2, event: { type: "first-frame" } });
    expect(decoded.state?.fallback?.status).toBe("recovered");
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
    requestSourceSession.mockImplementation(async (payload: { action: string; method?: string; sessionId?: string; sourceId?: string }) => ({
      session: {
        sessionId: payload.sessionId ?? "feature-session",
        sourceId: payload.sourceId ?? payload.sessionId ?? "feature-session",
        siteKey: "native-site",
        api: "csp_Jianpian",
        siteType: 3,
        state: "ready",
        availabilityReason: null,
        capabilities: { home: true, category: true, search: true, detail: true, playback: true, localProxy: false, filters: true, pagination: true, engine: "native" },
      },
      method: payload.method ?? null,
      result: payload.method === "detail"
        ? { list: [{ vod_id: "movie-1", vod_name: "Movie", vod_play_from: "main$$$backup", vod_play_url: "Episode$https://media.example.test/movie.m3u8$$$Backup$https://media.example.test/movie-backup.m3u8" }] }
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
    expect(featureCalls.filter((payload) => payload.feature === "favorites" && payload.action === "snapshot").at(-1))
      .toEqual(expect.objectContaining({ sourceId: expect.stringMatching(/^source:[0-9a-f]+$/) }));
    expect(featureCalls.filter((payload) => payload.feature === "follow" && payload.action === "snapshot").at(-1))
      .toEqual(expect.objectContaining({ sourceId: expect.stringMatching(/^source:[0-9a-f]+$/) }));
    await api.post("/api/detail", { vodId: "movie-1" });
    const favoriteEnvelope = await api.post("/api/favorites/toggle-detail");
    expect(favoriteEnvelope.state?.favoriteDetail).toEqual(expect.objectContaining({ vodId: "movie-1" }));
    expect(favoriteEnvelope.state?.favorites?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ vodId: "movie-1" }),
    ]));
    expect(featureCalls.filter((payload) => payload.feature === "favorites" && payload.action === "snapshot").at(-1))
      .toEqual(expect.objectContaining({ sourceId: expect.stringMatching(/^source:[0-9a-f]+$/) }));
    const followEnvelope = await api.post("/api/follow/toggle-detail");
    expect(followEnvelope.state?.followDetail).toEqual(expect.objectContaining({ vodId: "movie-1" }));
    expect(followEnvelope.state?.follow?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ vodId: "movie-1" }),
    ]));
    await api.post("/api/player", { lineIndex: 0, episodeIndex: 0 });
    const historyAtPlaybackStart = featureCalls.find((payload) => payload.feature === "history" && payload.action === "upsert");
    expect(historyAtPlaybackStart).toBeUndefined();
    await api.post("/api/player/sync", {
      status: "paused",
      currentTime: 3,
      duration: 120,
      event: { type: "user-pause" },
    });
    expect(featureCalls.find((payload) => payload.feature === "history" && payload.action === "upsert")).toBeUndefined();
    const synced = await api.post("/api/player/sync", {
      status: "playing",
      currentTime: 12,
      duration: 120,
      volume: 0.35,
      muted: true,
      event: { type: "first-frame" },
    });

    const favorite = featureCalls.find((payload) => payload.feature === "favorites" && payload.action === "toggle");
    const follow = featureCalls.find((payload) => payload.feature === "follow" && payload.action === "upsert");
    const history = featureCalls.find((payload) => payload.feature === "history" && payload.action === "upsert");
    expect((favorite?.value as Record<string, unknown>).sourceId).toMatch(/^source:[0-9a-f]+$/);
    expect((favorite?.value as Record<string, unknown>).episodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.not.stringContaining("http") }),
      expect.objectContaining({ name: "Backup" }),
    ]));
    expect((follow?.value as Record<string, unknown>).sourceId).toMatch(/^source:[0-9a-f]+$/);
    expect((history?.value as Record<string, unknown>).episodeId).not.toContain("http");
    expect(synced.state?.history).toBeDefined();

    const savedHistory = states.history.items[0];
    expect(savedHistory).toBeDefined();
    if (!savedHistory) throw new Error("history was not persisted");
    expect(savedHistory).toEqual(expect.objectContaining({ position: 12, duration: 120, episode: 1 }));
    await api.post("/api/player/sync", {
      status: "paused",
      currentTime: 12,
      duration: 120,
      error: computed(() => "reactive player error"),
    });
    requestPlayerWindow.mockImplementationOnce(async (payload) => {
      JSON.stringify(payload);
      return { schemaVersion: "v1", state: {} };
    });
    await api.post("/api/player/open");
    const playerOpen = requestPlayerWindow.mock.calls
      .map(([payload]) => payload as Record<string, unknown>)
      .find((payload) => payload.action === "open");
    expect(playerOpen).toBeDefined();
    expect(playerOpen?.value).toEqual(expect.objectContaining({
      history: expect.objectContaining({
        identity: savedHistory.identity,
        sourceId: savedHistory.sourceId,
        vodId: savedHistory.vodId,
        episodeId: savedHistory.episodeId,
        position: 12,
        duration: 120,
      }),
    }));
    expect((playerOpen?.value as Record<string, unknown> | undefined)?.history).not.toEqual(expect.objectContaining({
      episodeId: expect.stringContaining("http"),
    }));
    const opened = await api.post("/api/history/open", { identity: savedHistory.identity });
    expect(opened.state?.historyResume).toEqual(expect.objectContaining({
      identity: savedHistory.identity,
      position: 12,
      lineIndex: 0,
      episodeIndex: 0,
      canResume: true,
    }));
    const favoriteOpened = await api.post("/api/favorites/open", { favoriteId: "favorite:1" });
    expect(favoriteOpened.state?.historyResume).toEqual(expect.objectContaining({
      identity: savedHistory.identity,
      position: 12,
      lineIndex: 0,
      episodeIndex: 0,
    }));
    const followOpened = await api.post("/api/follow/open", { identity: String(states.follow.items[0]?.identity ?? "") });
    expect(followOpened.state?.historyResume).toEqual(expect.objectContaining({
      identity: savedHistory.identity,
      position: 12,
      lineIndex: 0,
      episodeIndex: 0,
    }));
    const resumed = await api.post("/api/player", {
      lineIndex: 0,
      episodeIndex: 0,
      resume: "continue",
    });
    expect(resumed.state?.player).toEqual(expect.objectContaining({ currentTime: 12, status: "loading" }));
    expect(resumed.state?.player).toEqual(expect.objectContaining({ volume: 0.35, muted: true }));
    const historyWritesBeforeSwitch = featureCalls.filter((payload) => payload.feature === "history" && payload.action === "upsert").length;
    const switchedLine = await api.post("/api/player", { lineIndex: 1, episodeIndex: 0 });
    expect(switchedLine.state?.player).toEqual(expect.objectContaining({ currentTime: 12, volume: 0.35, muted: true, status: "loading" }));
    const historyAtResume = featureCalls.filter((payload) => payload.feature === "history" && payload.action === "upsert").at(-1);
    expect(featureCalls.filter((payload) => payload.feature === "history" && payload.action === "upsert").length).toBe(historyWritesBeforeSwitch);
    expect(historyAtResume?.value).toEqual(expect.objectContaining({ position: 12, duration: 120 }));
    const completed = await api.post("/api/player/sync", {
      status: "playing",
      currentTime: 108,
      duration: 120,
    });
    expect(completed.state?.history?.items?.[0]).toEqual(expect.objectContaining({
      position: 108,
      duration: 120,
      completed: true,
    }));
    const paused = await api.post("/api/player/sync", {
      status: "paused",
      currentTime: 111,
      duration: 120,
      event: { type: "user-pause" },
    });
    expect(paused.state?.history?.items?.[0]).toEqual(expect.objectContaining({
      position: 111,
      duration: 120,
      completed: true,
    }));
    const ended = await api.post("/api/player/sync", {
      status: "ended",
      currentTime: 120,
      duration: 120,
      event: { type: "completion" },
    });
    expect(ended.state?.history?.items?.[0]).toEqual(expect.objectContaining({
      position: 120,
      duration: 120,
      completed: true,
    }));
    requestPlayerWindow.mockResolvedValueOnce({
      schemaVersion: "v1",
      state: {
        player: {
          status: "paused",
          currentTime: 42,
          duration: 120,
          volume: 0.2,
          muted: false,
          error: null,
        },
      },
    });
    const attached = await api.post("/api/player/attach");
    expect(attached.state).toMatchObject({
      playerHost: "embedded",
      player: {
        status: "paused",
        currentTime: 42,
        duration: 120,
        volume: 0.2,
        muted: false,
      },
    });
  });

});
