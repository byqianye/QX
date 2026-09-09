import {
  ingestConfigCatalog,
  requestConfigCatalogMaintenance,
  requestBusinessData,
  requestBusinessFeature,
  requestComponentManager,
  requestCast,
  requestPush,
  requestDesktopService,
  requestMpv,
  requestPlaybackFallback,
  requestPlaybackProxy,
  requestPlaybackSources,
  requestPlayerWindow,
  requestPlaybackStart,
  requestWebviewSniffer,
  requestQuickJsSession,
  requestSourceSession,
} from "./tauri-rpc.js";
import type {
  ConfigCatalogPayload,
  ConfigCatalogSnapshot,
  ConfigSiteSummary,
  BusinessFeaturePayload,
  BusinessFeatureSnapshot,
  ComponentManagerAction,
  ComponentManagerSnapshot,
  CastSnapshot,
  PushSnapshot,
  PlaybackFallbackCandidate,
  PlaybackFallbackPayload,
  PlaybackFallbackSnapshot,
  PlaybackFallbackState,
  PlaybackSourceResolvePayload,
  SourceCapabilities,
  SourceSessionPayload,
  SourceSessionResult,
} from "./contracts.js";
import type {
  PlayableCandidate,
  PlaybackSourceResolution,
} from "../../src/desktop/playback-source-resolver.js";
import { sanitizeVodDisplayText } from "../../src/source/normalizers.js";
import {
  createRendererState,
  type ApiSpiderState,
  type BrowseCategory,
  type BrowseFilter,
  type ImportState,
  type PlaybackCatalog,
  type PlaybackEpisode,
  type PlaybackLine,
  type PlayerSource,
  type PlayerState,
  type RendererEnvelope,
  type RendererError,
  type RendererPersistenceState,
  type RendererPlaybackSession,
  type RendererState,
} from "./state.js";
import { normalizeConfigInput } from "./test-preset.js";
import { DEFAULT_SOURCE_FALLBACK_CONFIG, DEFAULT_SOURCE_SITE_KEY, DEFAULT_SOURCE_URL } from "./default-source.js";
import type { HistoryResumeCandidate } from "../../src/history/history-types.js";
import { RequestTask, isRequestCancelled, type RendererRequestOptions } from "./request-task.js";
import type { SearchProgress } from "./state.js";
import { recoveryCandidateId, recoverySelection } from "./playback-recovery.js";
type TauriAction = (body: Record<string, unknown>) => Promise<RendererEnvelope> | RendererEnvelope;

interface TauriSite {
  key: string;
  name: string;
  api: string;
  siteType: 0 | 1 | 3 | 4;
  ext?: string;
}

interface TauriRuntimeState {
  import: ImportState;
  source: string;
  sourceId: string | null;
  selectedSite: TauriSite | null;
  sessionId: string;
  sessionReady: boolean;
  capabilities: SourceCapabilities | null;
  quickJs: boolean;
  quickJsMethods: Record<string, boolean>;
  page: ApiSpiderState["page"];
  items: Record<string, unknown>[];
  categories: BrowseCategory[];
  filters: BrowseFilter[];
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: { lineIndex: number; episodeIndex: number } | null;
  playerSource: PlayerSource | null;
  proxySessionId: string | null;
  playerDetached: boolean;
  persistence: RendererPersistenceState;
  featureState: Partial<ApiSpiderState>;
  componentManager: ComponentManagerSnapshot | null;
  fallbackSessionId: string | null;
  fallbackResolution: PlaybackSourceResolution | null;
  playbackFallbackRequests: Map<string, { lineIndex: number; episodeIndex: number }>;
}

interface SourceSwitchSnapshot {
  import: ImportState;
  sourceId: string | null;
  selectedSite: TauriSite | null;
  sessionReady: boolean;
  quickJs: boolean;
  quickJsMethods: Record<string, boolean>;
  capabilities: SourceCapabilities | null;
  page: ApiSpiderState["page"];
  items: Record<string, unknown>[];
  categories: BrowseCategory[];
  filters: BrowseFilter[];
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: { lineIndex: number; episodeIndex: number } | null;
  featureState: Partial<ApiSpiderState>;
}

interface SiteProbeResult {
  site: TauriSite;
  elapsedMs: number;
  opened: boolean;
  result?: SourceSessionResult;
  errorCode?: string;
  unsupported?: boolean;
}

interface HistorySelection {
  lineIndex: number;
  episodeIndex: number;
  lineName: string;
  episodeName: string;
}

const MULTI_SOURCE_PROBE_TIMEOUT_MS = 5_000;

const EMPTY_PERSISTENCE: RendererPersistenceState = {
  theme: "dark",
  navigation: "home",
  siteKey: null,
  configSource: null,
  category: null,
  search: null,
  scrollTop: 0,
  recentDetailId: null,
};

export class TauriRendererApi {
  private runtime: TauriRuntimeState | null = null;
  private playerIntent = 0;
  private availableSiteKeys = new Set<string>();
  private knownUnavailableSiteKeys = new Set<string>();
  private sourceAvailabilityChecked = false;
  private sourceAvailabilityProbe: Promise<void> | null = null;
  private readonly tasks = new Map<string, RequestTask>();
  private readonly playbackEngines = new Map<string, boolean>();
  private fallbackMode: "auto" | "prompt" | "off" = "auto";
  private recoveryWork: Promise<RendererEnvelope> | null = null;
  private recoveryTask: RequestTask | null = null;
  private fallbackVersion = 0;
  private playerSyncVersion = 0;

  private async runTask(lane: string, timeout: number, options: RendererRequestOptions, work: (task: RequestTask) => Promise<RendererEnvelope>): Promise<RendererEnvelope> {
    // Navigation intents replace obsolete network work before starting.
    for (const [key, old] of this.tasks) {
      if (key === lane || (lane !== "playback" && key !== "playback" && !(lane === "detail" && key === "search"))) old.cancel();
    }
    const task = new RequestTask(timeout, options.signal);
    this.tasks.set(lane, task);
    try { return await task.wait(work(task)); }
    catch (error) {
      if (lane === "search" && this.tasks.get(lane) === task && this.runtime?.featureState.searchProgress) {
        const progress = this.runtime.featureState.searchProgress;
        this.runtime.featureState.searchProgress = {
          ...progress, status: "cancelled",
          sources: progress.sources.map(source => source.status === "running" || source.status === "queued"
            ? { ...source, status: "cancelled", errorCode: "SEARCH_DEADLINE_OR_CANCELLED" } : source),
        };
        options.onProgress?.(this.envelope());
        // Partial results remain useful after the overall deadline expires.
        if (!isRequestCancelled(error)) return this.envelope();
      }
      throw error;
    }
    finally {
      task.dispose();
      if (this.tasks.get(lane) === task) this.tasks.delete(lane);
    }
  }

  public async getState(options: RendererRequestOptions = {}): Promise<RendererEnvelope> {
    if (!this.runtime) return this.runTask("connection", 12_000, options, async task => {
      await this.restoreSavedConfig(task, options);
      return this.runtime ? this.envelope() : {};
    });
    if (!this.runtime) return {};
    return this.envelope();
  }

  public async post(path: string, body: Record<string, unknown> = {}, options: RendererRequestOptions = {}): Promise<RendererEnvelope> {
    const lane = path === "/api/search" ? "search" : path === "/api/detail" ? "detail"
      : ["/api/open", "/api/home", "/api/category", "/api/import/select", "/api/import/confirm", "/api/import/load", "/api/import/load-file"].includes(path) ? "connection" : null;
    if (lane === "connection" || lane === "detail" || [
      "/api/player", "/api/player/stop", "/api/player/fallback/cancel", "/api/close", "/api/switch",
      "/api/detail/close", "/api/import/activate", "/api/import/cancel", "/api/requests/cancel",
    ].includes(path)) {
      this.recoveryTask?.cancel();
      this.fallbackVersion += 1;
    }
    if (lane) return this.runTask(lane, lane === "search" ? 20_000 : path.includes("/load") ? 30_000 : 12_000, options, task => Promise.resolve(this.actions(task, options)[path]!(body)));
    if (["/api/close", "/api/switch", "/api/detail/close", "/api/import/activate", "/api/import/cancel", "/api/requests/cancel"].includes(path)) {
      for (const task of this.tasks.values()) task.cancel();
      if (path === "/api/requests/cancel") return this.runtime ? this.envelope() : {};
    }
    const action = this.actions(undefined, options)[path];
    if (!action) {
      return {
        error: `Tauri renderer action is not migrated: ${path}`,
        errorCode: "TAURI_RENDERER_ACTION_NOT_MIGRATED",
      };
    }
    try {
      return await action(body);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private actions(task?: RequestTask, options: RendererRequestOptions = {}): Record<string, TauriAction> {
    return {
      "/api/import/load": (body) => this.load(String(body.input ?? ""), "", body.bootstrapDefault === true, task),
      "/api/import/load-file": (body) => this.load(String(body.input ?? ""), String(body.sourceName ?? ""), false, task),
      "/api/import/history": () => this.configHistory(),
      "/api/import/activate": (body) => this.activateConfig(String(body.versionHash ?? "")),
      "/api/import/select": (body) => this.select(String(body.siteKey ?? ""), task),
      "/api/import/confirm": () => this.confirm(task, options),
      "/api/import/cancel": () => this.cancel(),
      "/api/open": () => this.openAndHome(task),
      "/api/home": () => this.home(task),
      "/api/category": (body) => this.callBrowse("category", body, task),
      "/api/search": (body) => this.searchAllSources(body, task!, options),
      "/api/detail": (body) => this.detailForSite(String(body.vodId ?? ""), String(body.siteKey ?? ""), task),
      "/api/detail/close": () => this.closeDetail(),
      "/api/playback-sources/search": () => this.searchPlaybackSources(),
      "/api/playback-sources/select": (body) => this.selectPlaybackSource(body),
      "/api/switch": () => this.switchSource(),
      "/api/close": () => this.closeSource(),
      "/api/player": (body) => this.play(body, options),
      "/api/player/stop": () => this.stopPlayer(),
      "/api/player/sync": (body) => this.syncPlayer(body),
      "/api/player/detach": () => this.openPlayerWindow(),
      "/api/player/open": () => this.openPlayerWindow(),
      "/api/player/attach": () => this.attachPlayerWindow(),
      "/api/player/fallback/mode": (body) => this.setFallbackMode(body),
      "/api/player/fallback/approve": () => this.approveFallback(),
      "/api/player/fallback/cancel": () => this.cancelFallback(),
      "/api/components/verify": (body) => this.componentAction("verify", body),
      "/api/components/install": (body) => this.componentAction("install", body),
      "/api/components/rollback": (body) => this.componentAction("rollback", body),
      "/api/components/uninstall": (body) => this.componentAction("uninstall", body),
      "/api/cast/discover": () => this.castAction("discover", {}),
      "/api/cast/refresh": () => this.castAction("discover", {}),
      "/api/cast/play": (body) => this.castPlay(body),
      "/api/cast/pause": () => this.castAction("pause", {}),
      "/api/cast/resume": () => this.castAction("resume", {}),
      "/api/cast/stop": () => this.castAction("stop", {}),
      "/api/cast/seek": (body) => this.castAction("seek", { position: body.position }),
      "/api/cast/position": () => this.castAction("position", {}),
      "/api/cast/transport": () => this.castAction("transport", {}),
      "/api/cast/disconnect": () => this.castAction("disconnect", {}),
      "/api/push/settings": (body) => this.pushAction("settings", body),
      "/api/push/submit": (body) => this.pushAction("submit", body),
      "/api/push/confirm": (body) => this.pushConfirm(body, "play"),
      "/api/push/reject": (body) => this.pushConfirm(body, "reject"),
      "/api/push/cancel": (body) => this.pushAction("cancel", body),
      "/api/push/clear": () => this.pushAction("clear", {}),
      "/api/push/refresh": () => this.pushAction("refresh", {}),
      "/api/cache/refresh": () => this.desktopAction("cache-refresh", {}),
      "/api/cache/clear": (body) => this.desktopAction("cache-clear", body),
      "/api/storage/refresh": () => this.desktopAction("storage-refresh", {}),
      "/api/storage/open": () => this.desktopAction("storage-open", {}),
      "/api/storage/switch": (body) => this.desktopAction("storage-switch", body),
      "/api/backup/create": (body) => this.desktopAction("backup-create", body),
      "/api/backup/pick": () => this.desktopAction("backup-pick", {}),
      "/api/backup/apply": () => this.desktopAction("backup-apply", {}),
      "/api/backup/clear": () => this.desktopAction("backup-clear", {}),
      "/api/backup/open": () => this.desktopAction("backup-open", {}),
      "/api/local-media/open-file": (body) => this.desktopAction("local-open-file", body),
      "/api/local-media/add-folder": (body) => this.desktopAction("local-add-folder", body),
      "/api/local-media/drop": (body) => this.desktopAction("local-drop", body),
      "/api/local-media/rescan": (body) => this.desktopAction("local-rescan", body),
      "/api/local-media/cancel-scan": (body) => this.desktopAction("local-cancel-scan", body),
      "/api/local-media/remove-folder": (body) => this.desktopAction("local-remove-folder", body),
      "/api/local-media/remove-item": (body) => this.desktopAction("local-remove-item", body),
      "/api/local-media/locate": (body) => this.desktopAction("local-locate", body),
      "/api/local-media/active": (body) => this.desktopAction("local-active", body),
      "/api/local-media/play": (body) => this.desktopAction("local-play", body),
      "/api/downloads/select-folder": (body) => this.desktopAction("download-select-folder", body),
      "/api/downloads/add": (body) => this.desktopAction("download-add", body),
      "/api/downloads/refresh": () => this.desktopAction("download-refresh", {}),
      "/api/downloads/pause": (body) => this.desktopAction("download-pause", body),
      "/api/downloads/resume": (body) => this.desktopAction("download-resume", body),
      "/api/downloads/cancel": (body) => this.desktopAction("download-cancel", body),
      "/api/downloads/retry": (body) => this.desktopAction("download-retry", body),
      "/api/downloads/remove": (body) => this.desktopAction("download-remove", body),
      "/api/downloads/open-folder": (body) => this.desktopAction("download-open-folder", body),
      "/api/danmaku/load": (body) => this.desktopAction("danmaku-load", body),
      "/api/danmaku/settings": (body) => this.desktopAction("danmaku-settings", body),
      "/api/danmaku/clear": () => this.desktopAction("danmaku-clear", {}),
      "/api/danmaku/sync": (body) => this.desktopAction("danmaku-sync", body),
      "/api/view-state": (body) => this.viewState(body),
      "/api/history/open": (body) => this.openHistory(String(body.identity ?? "")),
      "/api/history/delete": (body) => this.featureAction("history", "delete", String(body.identity ?? "")),
      "/api/history/delete-progress": (body) => this.featureAction("history", "delete-progress", String(body.identity ?? "")),
      "/api/history/clear": (body) => this.featureAction("history", "clear", "", body),
      "/api/history/pause": (body) => this.featureAction("history", "pause", "", body),
      "/api/favorites/toggle-detail": () => this.toggleFavoriteDetail(),
      "/api/favorites/move-detail": (body) => this.featureAction("favorites", "move", this.favoriteIdForDetail(), body),
      "/api/favorites/delete": (body) => this.featureAction("favorites", "delete", String(body.favoriteId ?? "")),
      "/api/favorites/move": (body) => this.featureAction("favorites", "move", String(body.favoriteId ?? ""), body),
      "/api/favorites/reorder": (body) => this.featureAction("favorites", "reorder", "", body),
      "/api/favorites/group/create": (body) => this.featureAction("favorites", "group-create", "", body),
      "/api/favorites/group/rename": (body) => this.featureAction("favorites", "group-rename", String(body.groupId ?? ""), body),
      "/api/favorites/group/delete": (body) => this.featureAction("favorites", "group-delete", String(body.groupId ?? ""), body),
      "/api/favorites/group/reorder": (body) => this.featureAction("favorites", "group-reorder", "", body),
      "/api/favorites/open": (body) => this.openFavorite(String(body.favoriteId ?? "")),
      "/api/follow/toggle-detail": () => this.toggleFollowDetail(),
      "/api/follow/favorite-detail": () => this.toggleFollowDetail(true),
      "/api/follow/open": (body) => this.openFollow(String(body.identity ?? "")),
      "/api/follow/delete": (body) => this.featureAction("follow", "delete", String(body.identity ?? "")),
      "/api/follow/mark-watched": (body) => this.featureAction("follow", "mark-watched", String(body.identity ?? "")),
      "/api/follow/mark-unwatched": (body) => this.featureAction("follow", "mark-unwatched", String(body.identity ?? "")),
      "/api/follow/refresh": () => this.refreshFollow(),
    };
  }

  private async load(input: string, sourceName = "", bootstrapDefault = false, task?: RequestTask): Promise<RendererEnvelope> {
    const value = normalizeConfigInput(input);
    if (!value) throw new Error("TAURI_CONFIG_INPUT_EMPTY");
    const isUrl = /^https?:\/\//iu.test(value);
    const isInline = value.startsWith("{") || value.startsWith("[") || /^tvbox:|^2423|\*\*/iu.test(value);
    const isFile = sourceName.trim().length > 0;
    if (!isUrl && !isInline && !isFile) {
      throw new Error("TAURI_CONFIG_FILE_IMPORT_UNSUPPORTED");
    }
    const safeFileName = sourceName.trim().split(/[\\/]/u).pop()?.slice(0, 120) || "selected-config";
    const payload: ConfigCatalogPayload = isFile
      ? { source: `file:${safeFileName}`, sourceKind: "file", raw: value }
      : isUrl
      ? { source: value, sourceKind: "url", raw: "", fetchRemote: true }
      : { source: "inline:tauri", sourceKind: "json", raw: value };
    let snapshot: ConfigCatalogSnapshot;
    let usedDefaultFallback = false;
    if (bootstrapDefault && isDefaultSourceUrl(value)) {
      payload.raw = DEFAULT_SOURCE_FALLBACK_CONFIG;
      payload.fetchRemote = false;
    }
    try {
      snapshot = await ingestConfigCatalog(payload);
    } catch (error) {
      // The packaged catalog preserves every source when its remote refresh fails.
      task?.check();
      if (!isUrl || !isDefaultSourceUrl(value)) {
        throw error;
      }
      snapshot = await ingestConfigCatalog({
        source: value,
        sourceKind: "url",
        raw: DEFAULT_SOURCE_FALLBACK_CONFIG,
        fetchRemote: false,
      });
      usedDefaultFallback = true;
    }
    if (isDefaultSourceUrl(value) && Array.isArray(snapshot.sites) && snapshot.sites.length === 0) {
      snapshot = await ingestConfigCatalog({
        source: value,
        sourceKind: "url",
        raw: DEFAULT_SOURCE_FALLBACK_CONFIG,
        fetchRemote: false,
      });
      usedDefaultFallback = true;
    }
    if (!Array.isArray(snapshot.sites)) {
      const keys = isRecord(snapshot) ? Object.keys(snapshot).sort().join(",") : typeof snapshot;
      throw new Error(`TAURI_CONFIG_SNAPSHOT_INVALID:sites:${keys}`);
    }
    const inputKind: ImportState["inputKind"] = isFile ? "file" : isUrl ? "url" : "json";
    const sourceKind: ImportState["sourceKind"] = isFile ? "local" : isUrl ? "remote" : "inline";
    const sites = snapshot.sites.map(toSite);
    const importState = importStateFor(snapshot, inputKind, sourceKind, sites);
    task?.check();
    if (usedDefaultFallback) {
      importState.warning = "默认配置暂时无法在线刷新，已使用内置完整来源列表；稍后可在来源中心重试。";
    }
    this.runtime = {
      import: importState,
      source: snapshot.source,
      sourceId: null,
      selectedSite: sites[0] ?? null,
      sessionId: crypto.randomUUID(),
      sessionReady: false,
      capabilities: null,
      quickJs: false,
      quickJsMethods: {},
      page: "import",
      items: [],
      categories: [],
      filters: [],
      detail: null,
      playbackCatalog: null,
      playbackSelection: null,
      playerSource: null,
      proxySessionId: null,
      persistence: { ...EMPTY_PERSISTENCE },
      featureState: {},
      playerDetached: false,
      componentManager: null,
      fallbackSessionId: null,
      fallbackResolution: null,
      playbackFallbackRequests: new Map(),
    };
    await this.restorePersistence();
    this.restoreRememberedSite();
    await this.restoreBusinessFeatures();
    this.resetSourceAvailability();
    return this.envelope();
  }

  private async restoreSavedConfig(task?: RequestTask, options: RendererRequestOptions = {}): Promise<void> {
    const persisted = await requestBusinessData({
      action: "read",
      entity: "view_state",
      id: "renderer",
      value: {},
    });
    const source = rememberedConfigSource(persisted.value?.configSource);
    if (!source) return;

    const history = await requestConfigCatalogMaintenance({ action: "history", source });
    const versionHash = history.activeVersionHash?.trim();
    if (!versionHash) return;

    let snapshot = await requestConfigCatalogMaintenance({
      action: "activate",
      source,
      versionHash,
    });
    if (!Array.isArray(snapshot.sites)) return;

    // Repair only the previous release's one-entry fallback for our default URL.
    // User-imported catalogs and complete cached versions retain their contents.
    if (isDefaultSourceUrl(source) && snapshot.sites.length === 1
      && snapshot.sites[0]?.key === "荐片" && snapshot.sites[0]?.api === "csp_Jianpian"
      && snapshot.sites[0]?.ext === "https://api.ztcgi.com") {
      snapshot = await ingestConfigCatalog({ source, sourceKind: "url", raw: DEFAULT_SOURCE_FALLBACK_CONFIG, fetchRemote: false });
    }

    const sites = snapshot.sites.map(toSite);
    task?.check();
    this.runtime = {
      import: {
        ...importStateFor(snapshot, inputKindForCatalogKind(snapshot.sourceKind), importSourceKindForCatalogKind(snapshot.sourceKind), sites),
        status: "ready",
        trusted: true,
      },
      source: snapshot.source,
      sourceId: null,
      selectedSite: sites[0] ?? null,
      sessionId: crypto.randomUUID(),
      sessionReady: false,
      capabilities: null,
      quickJs: false,
      quickJsMethods: {},
      page: "import",
      items: [],
      categories: [],
      filters: [],
      detail: null,
      playbackCatalog: null,
      playbackSelection: null,
      playerSource: null,
      proxySessionId: null,
      persistence: { ...EMPTY_PERSISTENCE, configSource: source },
      featureState: {},
      playerDetached: false,
      componentManager: null,
      fallbackSessionId: null,
      fallbackResolution: null,
      playbackFallbackRequests: new Map(),
    };
    await this.restorePersistence();
    this.restoreRememberedSite();
    await this.restoreBusinessFeatures();
    this.resetSourceAvailability();
    task?.check();
    this.runtime.page = "home";
    options.onProgress?.(this.connectingEnvelope());
    try {
      await this.openConfiguredSource(this.requireRuntime().persistence.siteKey, task);
    } catch (error) {
      if (task?.signal.aborted || isRequestCancelled(error)) throw error;
      const runtime = this.requireRuntime();
      runtime.import = {
        ...runtime.import,
        status: "ready",
        trusted: true,
        sessionReady: false,
        warning: "已恢复配置，但当前来源暂不可用；可以重试或切换来源。",
      };
      runtime.page = "home";
      runtime.items = [];
      runtime.categories = [];
      runtime.filters = [];
    }
  }

  private async configHistory(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const history = await requestConfigCatalogMaintenance({ action: "history", source: runtime.source });
    return { ...this.envelope(), configHistory: history };
  }

  private async activateConfig(versionHash: string): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const targetVersionHash = versionHash.trim();
    if (!targetVersionHash) throw new Error("TAURI_CONFIG_VERSION_HASH_EMPTY");
    if (runtime.playerSource) await this.stopPlayer();
    else {
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      this.clearFallbackState();
    }
    await this.closeSourceSession();
    const snapshot = await requestConfigCatalogMaintenance({
      action: "activate",
      source: runtime.source,
      versionHash: targetVersionHash,
    });
    if (!Array.isArray(snapshot.sites)) {
      const keys = isRecord(snapshot) ? Object.keys(snapshot).sort().join(",") : typeof snapshot;
      throw new Error(`TAURI_CONFIG_SNAPSHOT_INVALID:sites:${keys}`);
    }
    const inputKind = runtime.import.inputKind ?? inputKindForCatalogKind(snapshot.sourceKind);
    const sourceKind = runtime.import.sourceKind ?? importSourceKindForCatalogKind(snapshot.sourceKind);
    const sites = snapshot.sites.map(toSite);
    runtime.import = importStateFor(snapshot, inputKind, sourceKind, sites);
    runtime.source = snapshot.source;
    runtime.sourceId = null;
    runtime.selectedSite = sites[0] ?? null;
    runtime.sessionId = crypto.randomUUID();
    runtime.sessionReady = false;
    runtime.capabilities = null;
    runtime.quickJs = false;
    runtime.quickJsMethods = {};
    runtime.page = "import";
    runtime.items = [];
    runtime.categories = [];
    runtime.filters = [];
    runtime.detail = null;
    runtime.playbackCatalog = null;
    runtime.playbackSelection = null;
    runtime.playerSource = null;
    runtime.proxySessionId = null;
    runtime.playerDetached = false;
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    runtime.fallbackSessionId = null;
    runtime.fallbackResolution = null;
    runtime.playbackFallbackRequests.clear();
    this.resetSourceAvailability();
    const history = await requestConfigCatalogMaintenance({ action: "history", source: runtime.source });
    return { ...this.envelope(), configHistory: history };
  }

  private async select(siteKey: string, task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const selected = runtime.import.sites.find((site) => site.key === siteKey);
    const selectedSite = selected ? toSite(selected) : null;
    if (!selectedSite) throw new Error("TAURI_SITE_NOT_FOUND");
    const shouldOpen = runtime.import.trusted;
    const snapshot = shouldOpen ? this.sourceSwitchSnapshot() : null;
    try {
      const changed = await this.changeSite(selectedSite, false, task);
      if (!shouldOpen) return this.viewState({ siteKey: selectedSite.key });
      if (changed || !runtime.sessionReady) await this.openSession(task);
      await this.home(task);
      return this.viewState({ siteKey: selectedSite.key });
    } catch (error) {
      if (task?.signal.aborted) throw error;
      if (snapshot) await this.restoreSourceSwitchSnapshot(snapshot);
      throw error;
    }
  }

  private sourceSwitchSnapshot(): SourceSwitchSnapshot {
    const runtime = this.requireRuntime();
    return {
      import: { ...runtime.import, sites: runtime.import.sites.map((site) => ({ ...site })) },
      sourceId: runtime.sourceId,
      selectedSite: runtime.selectedSite ? { ...runtime.selectedSite } : null,
      sessionReady: runtime.sessionReady,
      quickJs: runtime.quickJs,
      quickJsMethods: { ...runtime.quickJsMethods },
      capabilities: runtime.capabilities ? { ...runtime.capabilities } : null,
      page: runtime.page,
      items: runtime.items.map((item) => ({ ...item })),
      categories: runtime.categories.map((category) => ({ ...category })),
      filters: runtime.filters.map((filter) => ({ ...filter, options: filter.options.map((option) => ({ ...option })) })),
      detail: runtime.detail ? { ...runtime.detail } : null,
      playbackCatalog: runtime.playbackCatalog ? {
        lines: runtime.playbackCatalog.lines.map((line) => ({
          ...line,
          episodes: line.episodes.map((episode) => ({ ...episode })),
        })),
      } : null,
      playbackSelection: runtime.playbackSelection ? { ...runtime.playbackSelection } : null,
      featureState: { ...runtime.featureState },
    };
  }

  private async restoreSourceSwitchSnapshot(snapshot: SourceSwitchSnapshot): Promise<void> {
    const runtime = this.requireRuntime();
    const switched = runtime.selectedSite?.key !== snapshot.selectedSite?.key;
    if (switched && (runtime.sessionReady || runtime.quickJs)) {
      await this.closeSourceSession().catch(() => undefined);
    }
    runtime.import = { ...snapshot.import, sites: snapshot.import.sites.map((site) => ({ ...site })) };
    runtime.sourceId = snapshot.sourceId;
    runtime.selectedSite = snapshot.selectedSite ? { ...snapshot.selectedSite } : null;
    runtime.sessionReady = false;
    runtime.quickJs = false;
    runtime.quickJsMethods = {};
    runtime.capabilities = null;
    runtime.page = snapshot.page;
    runtime.items = snapshot.items.map((item) => ({ ...item }));
    runtime.categories = snapshot.categories.map((category) => ({ ...category }));
    runtime.filters = snapshot.filters.map((filter) => ({ ...filter, options: filter.options.map((option) => ({ ...option })) }));
    runtime.detail = snapshot.detail ? { ...snapshot.detail } : null;
    runtime.playbackCatalog = snapshot.playbackCatalog ? {
      lines: snapshot.playbackCatalog.lines.map((line) => ({
        ...line,
        episodes: line.episodes.map((episode) => ({ ...episode })),
      })),
    } : null;
    runtime.playbackSelection = snapshot.playbackSelection ? { ...snapshot.playbackSelection } : null;
    runtime.featureState = { ...snapshot.featureState };
    runtime.playerSource = null;
    runtime.proxySessionId = null;
    runtime.playerDetached = false;
    if (!snapshot.sessionReady || !snapshot.selectedSite) {
      runtime.import = { ...runtime.import, sessionReady: false };
      return;
    }
    try {
      await this.openSession();
    } catch {
      runtime.import = { ...runtime.import, sessionReady: false };
      runtime.sessionReady = false;
      runtime.capabilities = snapshot.capabilities;
    }
  }

  private async confirm(task?: RequestTask, options: RendererRequestOptions = {}): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.selectedSite) throw new Error("TAURI_SITE_NOT_FOUND");
    runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: false };
    await this.viewState({ configSource: runtime.source });
    task?.check();
    runtime.page = "home";
    options.onProgress?.(this.connectingEnvelope());
    try {
      await this.openConfiguredSource(runtime.persistence.siteKey, task);
      return this.envelope();
    } catch (error) {
      if (task?.signal.aborted || isRequestCancelled(error)) throw error;
      // Trusting a config and loading its first page are separate operations.
      // A dead source must not leave the user trapped in the confirmation dialog.
      runtime.page = "home";
      runtime.items = [];
      runtime.categories = [];
      runtime.filters = [];
      runtime.import = {
        ...runtime.import,
        warning: "配置已确认，但当前来源暂不可用；可以重试或切换来源。",
      };
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...this.envelope(),
        error: message,
        errorCode: message.includes("SOURCE_SESSION_REQUEST_FAILED")
          ? "SOURCE_SESSION_REQUEST_FAILED"
          : "TAURI_SOURCE_HOME_FAILED",
      };
    }
  }

  private async cancel(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    await this.closeSourceSession();
    runtime.import = { ...runtime.import, status: "cancelled", trusted: false, sessionReady: false };
    runtime.sessionReady = false;
    return this.envelope();
  }

  private async switchSource(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const sites = runtime.import.sites.map(toSite);
    if (sites.length < 2) throw new Error("TAURI_SOURCE_SWITCH_UNAVAILABLE");
    const currentIndex = sites.findIndex((site) => site.key === runtime.selectedSite?.key);
    const next = sites[(currentIndex + 1 + sites.length) % sites.length];
    if (!next) throw new Error("TAURI_SOURCE_SWITCH_UNAVAILABLE");
    return this.select(next.key);
  }

  private async closeSource(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (runtime.playerSource) await this.stopPlayer();
    else {
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      this.clearFallbackState();
    }
    await this.closeSourceSession();
    runtime.items = [];
    runtime.categories = [];
    runtime.filters = [];
    runtime.detail = null;
    runtime.playbackCatalog = null;
    runtime.playbackSelection = null;
    runtime.playbackFallbackRequests.clear();
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    return this.envelope();
  }

  private async openAndHome(task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.sessionReady) await this.openSession(task);
    return this.home(task);
  }

  private async detailForSite(vodId: string, siteKey = "", task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const requestedSiteKey = siteKey.trim();
    if (requestedSiteKey && runtime.selectedSite?.key !== requestedSiteKey) {
      const site = runtime.import.sites.map(toSite).find(site => site.key === requestedSiteKey);
      if (!site) throw new Error("TAURI_SITE_NOT_FOUND");
      await this.changeSite(site, false, task);
      await this.openSession(task);
    }
    return this.detail(vodId, false, task);
  }

  private async openSession(task?: RequestTask): Promise<void> {
    const runtime = this.requireRuntime();
    const site = runtime.selectedSite;
    if (!site) throw new Error("TAURI_SITE_NOT_FOUND");
    task?.check();
    if (!runtime.sessionReady) runtime.sessionId = crypto.randomUUID();
    if (runtime.quickJs && !usesQuickJsRuntime(site)) await this.closeQuickJs();
    if (usesQuickJsRuntime(site)) {
      await this.openQuickJsSession(site, task);
    } else {
      const open = await this.sourceRequest({
        action: "open",
        sessionId: runtime.sessionId,
        sourceId: runtime.sourceId ?? stableSourceIdForSite(site),
        siteKey: site.key,
        api: site.api,
        siteType: site.siteType,
        ...(site.ext === undefined ? {} : { ext: site.ext }),
      }, task);
      if (open.session.availabilityReason) throw new Error(open.session.availabilityReason);
      runtime.sourceId = stableSourceId(open.session.sourceId, runtime.sessionId) ?? stableSourceIdForSite(site);
      runtime.capabilities = { ...open.session.capabilities };
      if (site.api.toLowerCase() === "csp_jianpian") {
        await this.sourceRequest({
          action: "call",
          sessionId: runtime.sessionId,
          method: "init",
          params: {},
        }, task);
      }
      runtime.sessionReady = true;
      runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: true };
    }
    await this.refreshBusinessFeature("favorites").catch(() => undefined);
    await this.refreshBusinessFeature("follow").catch(() => undefined);
  }

  private async openQuickJsSession(site: TauriSite, task?: RequestTask): Promise<void> {
    const runtime = this.requireRuntime();
    const request = requestQuickJsSession({
      action: "open",
      sessionId: runtime.sessionId,
      sourceId: runtime.sourceId ?? stableSourceIdForSite(site),
      siteKey: site.key,
      api: site.api,
      siteType: site.siteType,
      ...(site.ext === undefined ? {} : { ext: site.ext }),
    });
    const open = task ? await task.wait(request) : await request;
    task?.check();
    runtime.quickJs = true;
    runtime.sourceId = stableSourceId(open.session.sourceId, runtime.sessionId) ?? stableSourceIdForSite(site);
    runtime.quickJsMethods = { ...open.methods };
    runtime.capabilities = { ...open.session.capabilities };
    runtime.sessionReady = true;
    runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: true };
  }

  private async home(task?: RequestTask): Promise<RendererEnvelope> {
    return this.callBrowse("home", {}, task);
  }

  private async callBrowse(method: "home" | "category" | "search", body: Record<string, unknown>, task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (method === "search" && runtime.import.sites.length > 1) {
      return this.searchAllSources(body, task!);
    }
    if (!runtime.sessionReady) await this.openSession(task);
    const result = await this.sourceRequest({
      action: "call",
      sessionId: runtime.sessionId,
      method,
      params: body,
    }, task);
    runtime.page = method === "home" ? "home" : method;
    runtime.items = listItems(result.result);
    const metadata = browseMetadata(result.result);
    if (metadata.categories.length > 0 || method === "home") runtime.categories = metadata.categories;
    if (metadata.filters.length > 0 || method === "home") runtime.filters = metadata.filters;
    return this.envelope();
  }

  private async openConfiguredSource(preferredSiteKey: string | null = null, task?: RequestTask): Promise<void> {
    const runtime = this.requireRuntime();
    const sites = runtime.import.sites.map(toSite);
    if (sites.length === 0) throw new Error("TAURI_SITE_NOT_FOUND");

    const candidates = homeSourceCandidates(sites, preferredSiteKey);
    const preferred = candidates[0];
    if (!preferred) throw new Error("TAURI_SITE_NOT_FOUND");

    const applySelected = (site: TauriSite): void => {
      task?.check();
      runtime.selectedSite = site;
      runtime.import = { ...runtime.import, selectedSiteKey: site.key, selectedApi: site.api };
      runtime.sourceId = null;
      runtime.sessionReady = false;
      runtime.quickJs = false;
      runtime.quickJsMethods = {};
      runtime.capabilities = null;
    };

    const openWinner = async (site: TauriSite, warning: string | null): Promise<void> => {
      applySelected(site);
      runtime.import = { ...runtime.import, warning };
      await this.openSession(task);
      await this.home(task);
      await this.viewState({ siteKey: site.key });
    };

    if (isDefaultSourceUrl(runtime.source)) {
      const fixed = sites.find((site) => site.key === DEFAULT_SOURCE_SITE_KEY);
      if (!fixed) throw new Error("默认来源光盘不在当前配置中，请手动选择来源或刷新配置。");
      await openWinner(fixed, runtime.import.warning);
      return;
    }

    applySelected(preferred);
    const preferredProbe = await this.probeSite(preferred, "home", {}, task);
    task?.check();
    if (preferredProbe.result) {
      await openWinner(preferred, runtime.import.warning);
      return;
    }
    this.knownUnavailableSiteKeys.add(preferred.key);

    for (const candidate of candidates.slice(1)) {
      const probe = await this.probeSite(candidate, "home", {}, task);
      task?.check();
      if (probe.result) {
        const warning = isFeimaoSite(preferred)
          ? "肥猫主站暂不可达，已切换到可用来源。"
          : "当前来源暂不可用，已切换到可用来源。";
        await openWinner(candidate, warning);
        return;
      }
      this.knownUnavailableSiteKeys.add(candidate.key);
    }

    if (preferredProbe.opened && candidates.length === 1) {
      applySelected(preferred);
      await this.openSession(task);
      await this.home(task);
      await this.viewState({ siteKey: preferred.key });
      return;
    }

    runtime.import = {
      ...runtime.import,
      status: "ready",
      trusted: true,
      sessionReady: false,
      warning: isFeimaoSite(preferred)
        ? "肥猫主站暂不可达；可以重试或切换来源。"
        : "当前来源暂不可用；可以重试或切换来源。",
    };
    runtime.page = "home";
    runtime.items = [];
    runtime.categories = [];
    runtime.filters = [];
  }

  private async searchAllSources(body: Record<string, unknown>, task: RequestTask, options: RendererRequestOptions = {}): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const query = stringValue(body.key).trim();
    if (!query) throw new Error("TAURI_SEARCH_KEY_REQUIRED");
    task.check();
    const sites = runtime.import.sites.map(toSite).sort((left, right) => Number(right.key === runtime.selectedSite?.key) - Number(left.key === runtime.selectedSite?.key));
    const progress: SearchProgress = { query, status: "running", sources: sites.map(site => ({ key: site.key, name: site.name, status: "queued", count: 0 })) };
    const results = new Map<string, Record<string, unknown>[]>();
    runtime.page = "search";
    runtime.categories = [];
    runtime.filters = [];
    const publish = (): void => {
      task.check();
      runtime.items = sites.flatMap(site => results.get(site.key) ?? []);
      runtime.featureState.searchProgress = { ...progress, sources: progress.sources.map(source => ({ ...source })) };
      options.onProgress?.(this.envelope());
    };
    publish();
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!task.signal.aborted) {
        const index = nextIndex++;
        const site = sites[index];
        const status = progress.sources[index];
        if (!site || !status) return;
        status.status = "running";
        publish();
        const result = await this.probeSite(site, "search", body, task);
        task.check();
        const items = result.result ? listItems(result.result.result).map(item => ({
          ...item, __qx_source_key: site.key, __qx_source_name: site.name,
          __qx_detail_available: result.result!.session.capabilities.detail,
        })) : [];
        status.status = result.unsupported ? "unsupported" : result.result ? items.length > 0 ? "success" : "empty" : "failed";
        status.count = items.length;
        if (result.errorCode) status.errorCode = result.errorCode;
        results.set(site.key, items);
        publish();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, sites.length) }, worker));
      task.check();
      progress.status = "complete";
      publish();
      return this.envelope();
    } catch (error) {
      // A replaced search never publishes into its successor's state.
      if (runtime.featureState.searchProgress?.query === query && this.tasks.get("search") === task) {
        progress.status = "cancelled";
        for (const source of progress.sources) if (source.status === "queued" || source.status === "running") source.status = "cancelled";
        runtime.featureState.searchProgress = { ...progress, sources: progress.sources.map(source => ({ ...source })) };
      }
      throw error;
    }
  }

  private resetSourceAvailability(): void {
    this.availableSiteKeys = new Set<string>();
    this.knownUnavailableSiteKeys = new Set<string>();
    this.sourceAvailabilityChecked = false;
    this.sourceAvailabilityProbe = null;
  }

  private async probeSite(site: TauriSite, method: "home" | "search", params: Record<string, unknown>, parent?: RequestTask): Promise<SiteProbeResult> {
    const started = performance.now();
    const sessionId = crypto.randomUUID();
    const quickJs = usesQuickJsRuntime(site);
    if (quickJs && method === "search" && isDefaultSourceUrl(this.requireRuntime().source)) return { site, elapsedMs: 0, opened: false, unsupported: true, errorCode: "EXTERNAL_RUNTIME_REQUIRED" };
    const task = new RequestTask(6_000, parent?.signal);
    const cancel = (): void => {
      if (quickJs) void requestQuickJsSession({ action: "close", sessionId }).catch(() => undefined);
      else {
        void requestSourceSession({ action: "cancel", sessionId }).catch(() => undefined);
        void requestSourceSession({ action: "close", sessionId }).catch(() => undefined);
      }
    };
    task.signal.addEventListener("abort", cancel, { once: true });
    let opened = false;
    const elapsedMs = (): number => Math.max(0, performance.now() - started);
    try {
      const opening = quickJs
        ? requestQuickJsSession({ action: "open", sessionId, sourceId: stableSourceIdForSite(site), siteKey: site.key, api: site.api, siteType: site.siteType, ...(site.ext === undefined ? {} : { ext: site.ext }) })
        : requestSourceSession({ action: "open", sessionId, sourceId: stableSourceIdForSite(site), siteKey: site.key, api: site.api, siteType: site.siteType, timeoutMs: task.remainingMs(), ...(site.ext === undefined ? {} : { ext: site.ext }) });
      void Promise.resolve(opening).then(() => { if (task.signal.aborted) cancel(); }, () => undefined);
      const openedResult = await task.wait(Promise.resolve(opening));
      opened = true;
      const supported = openedResult.session.capabilities[method];
      if (openedResult.session.availabilityReason || !supported) {
        return { site, elapsedMs: elapsedMs(), opened: true, unsupported: !supported, errorCode: openedResult.session.availabilityReason ?? "METHOD_UNSUPPORTED" };
      }
      if (site.api.toLowerCase() === "csp_jianpian") {
        if (quickJs) await task.wait(requestQuickJsSession({ action: "call", sessionId, method: "init", params: {} }));
        else await task.wait(requestSourceSession({ action: "call", sessionId, method: "init", params: {}, timeoutMs: task.remainingMs() }));
      }
      const result = quickJs
        ? await task.wait(requestQuickJsSession({ action: "call", sessionId, method, params }))
        : await task.wait(requestSourceSession({ action: "call", sessionId, method, params, timeoutMs: task.remainingMs() }));
      return { site, result, elapsedMs: elapsedMs(), opened: true };
    } catch (error) {
      const message = String(error);
      const code = message.match(/(?:APPQI|APPGET|SOURCE_SESSION|AUTO_HTTP|EXTERNAL_RUNTIME)_[A-Z_]+/gu)?.at(-1);
      return { site, elapsedMs: elapsedMs(), opened, unsupported: /UNSUPPORTED|EXTERNAL_RUNTIME_REQUIRED/u.test(message),
        errorCode: message.includes("TIMEOUT") ? "SOURCE_SESSION_TIMEOUT" : code ?? "SOURCE_REQUEST_FAILED" };
    } finally {
      task.dispose();
      task.signal.removeEventListener("abort", cancel);
      if (opened) {
        if (quickJs) void requestQuickJsSession({ action: "close", sessionId }).catch(() => undefined);
        else void requestSourceSession({ action: "close", sessionId }).catch(() => undefined);
      }
    }
  }

  private async detail(vodId: string, preserveFallback = false, task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!vodId) throw new Error("TAURI_DETAIL_ID_REQUIRED");
    if (!runtime.sessionReady) await this.openSession(task);
    const result = await this.sourceRequest({
      action: "call",
      sessionId: runtime.sessionId,
      method: "detail",
      params: { ids: [vodId] },
    }, task);
    const value = sanitizeVodDescriptionFields(listItems(result.result)[0] ?? record(result.result));
    runtime.page = "detail";
    if (!preserveFallback) {
      runtime.playbackFallbackRequests.clear();
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      this.clearFallbackState();
    }
    runtime.detail = value;
    runtime.playbackCatalog = playbackCatalog(value, runtime.selectedSite?.api);
    runtime.playbackSelection = runtime.playbackCatalog?.lines[0]?.episodes[0]
      ? { lineIndex: runtime.playbackCatalog.lines[0].index, episodeIndex: 0 }
      : null;
    runtime.featureState = { ...runtime.featureState, historyResume: null };
    return this.envelope();
  }

  private closeDetail(): RendererEnvelope {
    const runtime = this.requireRuntime();
    runtime.page = "home";
    runtime.detail = null;
    runtime.playbackCatalog = null;
    runtime.playbackSelection = null;
    runtime.playbackFallbackRequests.clear();
    return this.envelope();
  }

  private async searchPlaybackSources(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const currentVod = runtime.detail;
    if (!currentVod) throw new Error("TAURI_PLAYBACK_SOURCE_DETAIL_REQUIRED");
    const query = stringValue(currentVod.vod_name ?? currentVod.title).trim();
    if (!query) throw new Error("TAURI_PLAYBACK_SOURCE_QUERY_REQUIRED");
    const currentSite = runtime.selectedSite;
    if (!currentSite) throw new Error("TAURI_SITE_NOT_FOUND");
    const configuredSites = runtime.import.sites.map(toSite);
    const resolution = await requestPlaybackSources({
      query,
      currentSiteKey: currentSite.key,
      currentVod,
      ...(runtime.playbackCatalog ? { currentCatalog: runtime.playbackCatalog } : {}),
      ...(runtime.capabilities ? { currentPlayback: runtime.capabilities.playback } : {}),
      sourceId: requireSourceId(runtime),
      sessionId: runtime.sessionId,
      sites: configuredSites,
    } satisfies PlaybackSourceResolvePayload);
    runtime.fallbackSessionId = null;
    runtime.fallbackResolution = null;
    runtime.playbackFallbackRequests.clear();
    this.clearFallbackState();
    runtime.featureState = { ...runtime.featureState, playbackSources: resolution };
    return this.envelope();
  }

  private async selectPlaybackSource(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const siteKey = stringValue(body.siteKey);
    const vodId = stringValue(body.vodId);
    const preserveFallback = body.preserveFallback === true;
    const resolution = runtime.featureState.playbackSources ?? runtime.fallbackResolution;
    const candidate = resolution?.candidates.find((item) => item.siteKey === siteKey && String(item.vod.vod_id ?? item.vod.id ?? "") === vodId);
    if (!resolution || !candidate?.playable) throw new Error("TAURI_PLAYBACK_SOURCE_CANDIDATE_INVALID");
    const site = runtime.import.sites.map(toSite).find((item) => item.key === siteKey);
    if (!site) throw new Error("TAURI_PLAYBACK_SOURCE_SITE_UNAVAILABLE");
    if (runtime.selectedSite?.key !== site.key) {
      await this.changeSite(site, preserveFallback);
      await this.openSession();
    }
    await this.detail(vodId, preserveFallback);
    await this.viewState({ siteKey: site.key });
    runtime.fallbackResolution = resolution;
    if (!preserveFallback) await this.beginFallback(resolution, candidate);
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    return this.envelope();
  }

  private async changeSite(site: TauriSite, preserveFallback = false, task?: RequestTask): Promise<boolean> {
    const runtime = this.requireRuntime();
    if (runtime.selectedSite?.key === site.key) return false;

    if (runtime.playerSource || this.tasks.has("playback")) await this.stopPlayer(preserveFallback);
    else if (!preserveFallback) {
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      runtime.playbackFallbackRequests.clear();
      this.clearFallbackState();
    }
    await this.closeSourceSession();
    task?.check();
    runtime.sourceId = null;
    runtime.selectedSite = site;
    runtime.import = { ...runtime.import, selectedSiteKey: site.key, selectedApi: site.api };
    runtime.page = "home";
    runtime.items = [];
    runtime.categories = [];
    runtime.filters = [];
    runtime.detail = null;
    runtime.playbackCatalog = null;
    runtime.playbackSelection = null;
    runtime.playbackFallbackRequests.clear();
    if (!preserveFallback) {
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      this.clearFallbackState();
    }
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    return true;
  }

  private async play(body: Record<string, unknown>, options: RendererRequestOptions = {}, restoredPlayer?: PlayerState): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const site = runtime.selectedSite;
    if (!site) throw new Error("TAURI_SITE_NOT_FOUND");
    const previousSelection = runtime.playbackSelection;
    const previousPlayer = restoredPlayer ?? runtime.featureState.player ?? createRendererState().playback.player;
    const lineIndex = numberValue(body.lineIndex, runtime.playbackSelection?.lineIndex ?? 0);
    const episodeIndex = numberValue(body.episodeIndex, runtime.playbackSelection?.episodeIndex ?? 0);
    const line = runtime.playbackCatalog?.lines.find((candidate) => candidate.index === lineIndex);
    const episode = line?.episodes[episodeIndex];
    if (!line || !episode) throw new Error("TAURI_PLAYBACK_EPISODE_NOT_FOUND");
    const resumeMode = body.resume === "continue" || body.resume === "beginning" ? body.resume : null;
    const resumeCandidate = runtime.featureState.historyResume;
    const resumeSeconds = restoredPlayer ? restoredPlayer.currentTime : resumeMode === "continue" && resumeCandidate?.lineIndex === lineIndex
      && resumeCandidate.episodeIndex === episodeIndex
      ? Math.max(0, numberValue(resumeCandidate.position, 0))
      : !resumeMode && previousSelection !== null && previousSelection.lineIndex !== lineIndex
        ? Math.max(0, numberValue(previousPlayer.currentTime, 0))
      : 0;
    this.tasks.get("playback")?.cancel();
    const recoveryRemaining = restoredPlayer && runtime.featureState.fallback?.deadlineAt
      ? runtime.featureState.fallback.deadlineAt - Date.now() : 15_000;
    if (recoveryRemaining <= 0) throw new Error("PLAYBACK_RECOVERY_DEADLINE");
    const task = new RequestTask(Math.min(15_000, recoveryRemaining), options.signal);
    this.tasks.set("playback", task);
    const intent = ++this.playerIntent;
    const sessionId = crypto.randomUUID();
    const quickJs = usesQuickJsRuntime(site);
    this.playbackEngines.set(sessionId, quickJs);
    const cancel = () => { void this.releasePlaybackSession(sessionId, quickJs); };
    task.signal.addEventListener("abort", cancel, { once: true });
    const oldSession = runtime.proxySessionId;
    runtime.proxySessionId = null;
    runtime.playerSource = null;
    runtime.playerDetached = false;
    runtime.playbackSelection = { lineIndex, episodeIndex };
    runtime.featureState = {
      ...runtime.featureState,
      historyResume: null,
      player: {
        ...previousPlayer,
        status: "loading",
        currentTime: resumeSeconds,
        startedAt: Date.now(),
        resumePaused: restoredPlayer ? restoredPlayer.status === "paused" || restoredPlayer.resumePaused === true : false,
        source: null,
        error: null,
      },
    };
    options.onProgress?.(this.envelope());
    try {
    await task.wait(requestPlayerWindow({ action: "stop", value: {} }));
    if (oldSession) await task.wait(this.releasePlaybackSession(oldSession));
    if (resumeMode === "beginning" && resumeCandidate?.identity) await task.wait(this.featureAction("history", "delete-progress", String(resumeCandidate.identity)));
    if (!restoredPlayer || !runtime.fallbackSessionId) {
      const selected = runtime.fallbackResolution?.candidates.find(candidate => candidate.siteKey === site.key && String(candidate.vod.vod_id ?? candidate.vod.id ?? "") === String(runtime.detail?.vod_id ?? ""));
      if (runtime.fallbackResolution && selected) await this.beginFallback(runtime.fallbackResolution, selected);
      else await this.beginPlaybackFallback(lineIndex, episodeIndex);
    }
    task.check();
    // A playback attempt owns its source session and proxy. A late cancelled
    // resolver can therefore never close or overwrite its successor.
    const opening = quickJs
      ? requestQuickJsSession({ action: "open", sessionId, sourceId: stableSourceIdForSite(site), siteKey: site.key, api: site.api, siteType: site.siteType, ...(site.ext === undefined ? {} : { ext: site.ext }) })
      : requestSourceSession({ action: "open", sessionId, sourceId: stableSourceIdForSite(site), siteKey: site.key, api: site.api, siteType: site.siteType, timeoutMs: task.remainingMs(), ...(site.ext === undefined ? {} : { ext: site.ext }) });
    void opening.then(() => { if (task.signal.aborted) cancel(); }, () => undefined);
    await task.wait(opening);
    if (site.api.toLowerCase() === "csp_jianpian") await task.wait(requestSourceSession({ action: "call", sessionId, method: "init", params: {}, timeoutMs: task.remainingMs() }));
    const starting = requestPlaybackStart({
      sessionId,
      ...(runtime.sourceId ? { sourceId: runtime.sourceId } : {}),
      sourceApi: runtime.selectedSite?.api ?? "",
      ...(runtime.selectedSite?.siteType === undefined ? {} : { siteType: runtime.selectedSite.siteType }),
      ...(quickJs ? { engine: "quickjs" as const } : {}),
      lineName: line.name,
      episodeId: episode.id,
      timeoutMs: task.remainingMs(),
      vipFlags: [],
      fallbackSubtitles: runtime.detail?.subtitles ?? runtime.detail?.subtitleTracks,
    });
    void starting.then(() => { if (task.signal.aborted || intent !== this.playerIntent) cancel(); }, () => undefined);
    const playback = await task.wait(starting);
    task.check();
    if (intent !== this.playerIntent) { cancel(); return this.envelope(); }
    runtime.proxySessionId = sessionId;
    runtime.playbackSelection = { lineIndex, episodeIndex };
    runtime.playerSource = {
      ...(playback.playerSource as unknown as PlayerSource),
    };
    await this.recordPlaybackHistory({ status: "loading", currentTime: resumeSeconds, duration: 0 });
    return this.envelope();
    } catch (error) {
      await this.releasePlaybackSession(sessionId);
      throw error;
    } finally {
      task.signal.removeEventListener("abort", cancel);
      task.dispose();
      if (this.tasks.get("playback") === task) this.tasks.delete("playback");
    }
  }

  private async releasePlaybackSession(sessionId: string, quickJs = this.playbackEngines.get(sessionId) === true): Promise<void> {
    await Promise.allSettled([
      requestPlaybackProxy({ action: "close", sessionId }),
      requestWebviewSniffer({ action: "cancel", sessionId }),
      ...(quickJs ? [requestQuickJsSession({ action: "close", sessionId })]
        : [requestSourceSession({ action: "cancel", sessionId }), requestSourceSession({ action: "close", sessionId })]),
    ]);
    this.playbackEngines.delete(sessionId);
  }

  private async stopPlayer(preserveFallback = false): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    this.tasks.get("playback")?.cancel();
    const intent = ++this.playerIntent;
    const proxySessionId = runtime.proxySessionId;
    const fallbackSessionId = runtime.fallbackSessionId;
    try {
      if (runtime.playerSource?.backend === "mpv") {
        await requestMpv({ action: "close", sessionId: proxySessionId ?? runtime.sessionId });
      }
    } finally {
      if (proxySessionId) await this.releasePlaybackSession(proxySessionId);
      if (!preserveFallback && fallbackSessionId) {
        await requestPlaybackFallback({ action: "clear", sessionId: fallbackSessionId }).catch(() => undefined);
      }
      if (this.runtime !== runtime || intent !== this.playerIntent) return this.envelope();
      runtime.proxySessionId = null;
      runtime.playerSource = null;
      runtime.playerDetached = false;
      runtime.featureState = {
        ...runtime.featureState,
        player: {
          ...(runtime.featureState.player ?? createRendererState().playback.player),
          status: "stopped",
          source: null,
          currentTime: 0,
          duration: 0,
          error: null,
        },
      };
      if (!preserveFallback) {
        runtime.fallbackSessionId = null;
        runtime.fallbackResolution = null;
        runtime.playbackFallbackRequests.clear();
        this.clearFallbackState();
      }
      await requestPlayerWindow({ action: "stop", value: {} }).catch(() => undefined);
    }
    return this.envelope();
  }

  private async openPlayerWindow(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.playerSource) return this.envelope();
    const current = this.envelope().state;
    const history = current?.player
      ? this.currentHistoryRecord({ ...current.player })
      : null;
    await requestPlayerWindow({
      action: "open",
      value: {
        theme: runtime.persistence.theme === "light" || runtime.persistence.theme === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark",
        player: current?.player ? playerWindowPlayerSnapshot(current.player) : null,
        session: current?.playbackSession ? playerWindowSessionSnapshot(current.playbackSession) : null,
        ...(history ? { history } : {}),
      },
    });
    runtime.playerDetached = true;
    return this.envelope();
  }

  private async attachPlayerWindow(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const snapshot = await requestPlayerWindow({ action: "attach", value: {} });
    const detachedPlayer = snapshot.state.player;
    if (isRecord(detachedPlayer)) {
      const previousPlayer = runtime.featureState.player ?? createRendererState().playback.player;
      runtime.featureState = {
        ...runtime.featureState,
        player: {
          ...previousPlayer,
          ...(typeof detachedPlayer.status === "string" ? { status: detachedPlayer.status as typeof previousPlayer.status } : {}),
          ...(Number.isFinite(numberValue(detachedPlayer.currentTime, Number.NaN))
            ? { currentTime: Math.max(0, numberValue(detachedPlayer.currentTime, 0)) }
            : {}),
          ...(Number.isFinite(numberValue(detachedPlayer.duration, Number.NaN))
            ? { duration: Math.max(0, numberValue(detachedPlayer.duration, 0)) }
            : {}),
          ...(typeof detachedPlayer.volume === "number" && Number.isFinite(detachedPlayer.volume)
            ? { volume: Math.min(1, Math.max(0, detachedPlayer.volume)) }
            : {}),
          ...(typeof detachedPlayer.muted === "boolean" ? { muted: detachedPlayer.muted } : {}),
          playbackRate: numberValue(detachedPlayer.playbackRate, previousPlayer.playbackRate ?? 1),
          resumePaused: detachedPlayer.status === "paused",
          ...(detachedPlayer.error === null || isRecord(detachedPlayer.error)
            ? { error: detachedPlayer.error as RendererState["playback"]["player"]["error"] }
            : {}),
        },
      };
    }
    runtime.playerDetached = false;
    return this.envelope();
  }

  private async syncPlayer(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (typeof body.sessionId === "string" && body.sessionId !== runtime.proxySessionId) return this.envelope();
    // Error and timeout events from one failed host share a single recovery.
    // Otherwise each event can stop the next host and consume another attempt.
    if (this.recoveryWork && !this.recoveryTask?.signal.aborted) return this.recoveryWork;
    if (body.status !== "error") return this.applyPlayerSync(body);
    const task = new RequestTask(Math.max(1, runtime.featureState.fallback?.deadlineAt
      ? runtime.featureState.fallback.deadlineAt - Date.now() : 45_000));
    this.recoveryTask = task;
    const work = task.wait(this.applyPlayerSync(body, task)).catch(error => {
      if (task.signal.aborted) return this.envelope();
      throw error;
    });
    this.recoveryWork = work;
    try { return await work; }
    catch (error) {
      if (task.signal.aborted) return this.envelope();
      throw error;
    } finally {
      task.dispose();
      if (this.recoveryTask === task) {
        this.recoveryTask = null;
        this.recoveryWork = null;
      }
    }
  }

  private async applyPlayerSync(body: Record<string, unknown>, recovery?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const intent = this.playerIntent;
    const version = ++this.playerSyncVersion;
    const current = () => this.runtime === runtime && intent === this.playerIntent
      && version === this.playerSyncVersion && !recovery?.signal.aborted;
    const previousPlayer = runtime.featureState.player ?? createRendererState().playback.player;
    const nextPlayer = {
      ...previousPlayer,
      ...(typeof body.status === "string" ? { status: body.status as typeof previousPlayer.status } : {}),
      ...(Number.isFinite(numberValue(body.currentTime, Number.NaN)) ? { currentTime: Math.max(0, numberValue(body.currentTime, 0)) } : {}),
      ...(Number.isFinite(numberValue(body.duration, Number.NaN)) ? { duration: Math.max(0, numberValue(body.duration, 0)) } : {}),
      ...(typeof body.volume === "number" && Number.isFinite(body.volume)
        ? { volume: Math.min(1, Math.max(0, body.volume)) }
        : {}),
      ...(typeof body.muted === "boolean" ? { muted: body.muted } : {}),
      ...(typeof body.playbackRate === "number" && body.playbackRate >= 0.5 && body.playbackRate <= 2 ? { playbackRate: body.playbackRate } : {}),
      ...(body.error && isRecord(body.error) ? { error: body.error as unknown as RendererState["playback"]["player"]["error"] } : {}),
    };
    runtime.featureState = { ...runtime.featureState, player: nextPlayer };
    const playbackError = body.status === "error";
    if (playbackError && !runtime.fallbackSessionId && runtime.playbackSelection) {
      await this.beginPlaybackFallback(runtime.playbackSelection.lineIndex, runtime.playbackSelection.episodeIndex);
    }
    if (!current()) return this.envelope();
    try {
      await this.desktopAction("player-sync", body, current);
      if (!current()) return this.envelope();
      await this.desktopAction("danmaku-sync", body, current);
    } catch (error) {
      if (!runtime.fallbackSessionId) throw error;
    }
    if (!current()) return this.envelope();
    if (runtime.playerSource) {
      runtime.playerSource = { ...runtime.playerSource };
      await this.recordPlaybackHistory(body);
    }
    if (!current()) return this.envelope();
    const fallbackState = runtime.featureState.fallback;
    if (isRecord(body.event) && body.event.type === "first-frame" && runtime.fallbackSessionId && fallbackState?.status === "trying") {
      await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: true });
    } else if (body.status === "error") {
      await this.handlePlaybackFailure(body, recovery);
    }
    return this.envelope();
  }

  private async recordPlaybackHistory(body: Record<string, unknown>): Promise<void> {
    const runtime = this.requireRuntime();
    const eventType = isRecord(body.event) ? stringValue(body.event.type) : "";
    const startsHistory = eventType === "first-frame" || body.status === "playing";
    const flushesHistory = body.status === "paused"
      || body.status === "stopped"
      || body.status === "ended"
      || eventType === "user-pause"
      || eventType === "completion";
    if (!startsHistory && !flushesHistory) return;
    if (runtime.featureState.history?.paused === true) return;
    const history = this.currentHistoryRecord(body);
    if (!history) return;
    const existing = this.featureItems("history").find((item) => stringValue(item.identity) === history.identity);
    if (!startsHistory && !existing) return;
    if (existing?.completed === true) history.completed = true;
    try {
      await this.featureAction("history", "upsert", String(history.identity), history);
      await this.refreshBusinessFeature("history");
    } catch {
      // Recording history must not prevent a real playback session from starting.
    }
  }

  private currentHistoryRecord(body: Record<string, unknown>): Record<string, unknown> | null {
    const runtime = this.requireRuntime();
    if (!runtime.detail || !runtime.playbackCatalog || !runtime.playbackSelection || !runtime.sourceId || !runtime.selectedSite) return null;
    const line = runtime.playbackCatalog.lines.find((candidate) => candidate.index === runtime.playbackSelection?.lineIndex);
    const episode = line?.episodes[runtime.playbackSelection.episodeIndex];
    if (!line || !episode) return null;
    const rawVodId = stringValue(runtime.detail.vod_id ?? runtime.detail.id);
    const sourceId = featureSourceId(runtime);
    const vodId = featureIdentifier(rawVodId, "vod");
    const episodeId = featureIdentifier(episode.id, `episode:${episode.index}`);
    if (!vodId || !episodeId) return null;
    const identity = `${sourceId}:${vodId}:${episodeId}`;
    const eventType = isRecord(body.event) ? stringValue(body.event.type) : "";
    const position = numberValue(body.currentTime, 0);
    const duration = numberValue(body.duration, 0);
    return {
      identity,
      sourceId,
      vodId,
      seasonId: null,
      episodeId,
      title: stringValue(runtime.detail.vod_name ?? runtime.detail.title) || vodId,
      poster: stringValue(runtime.detail.vod_pic ?? runtime.detail.poster) || null,
      episode: episode.index + 1,
      episodeName: episode.name,
      playbackLine: line.name,
      position,
      duration,
      updatedAt: Date.now(),
      completed: rendererHistoryCompleted(
        position,
        duration,
        body.status === "ended" || body.completed === true || eventType === "completion",
      ),
      sourceDisplayName: runtime.selectedSite.name,
      sourceType: "remote",
    };
  }

  private async setFallbackMode(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const mode = stringValue(body.mode);
    if (mode === "off" || mode === "prompt" || mode === "auto") this.fallbackMode = mode;
    await this.desktopAction("player-fallback-mode", body);
    if (runtime.fallbackSessionId && (mode === "off" || mode === "prompt" || mode === "auto")) {
      await this.fallbackAction({ action: "set-mode", sessionId: runtime.fallbackSessionId, mode });
    }
    return this.envelope();
  }

  private async approveFallback(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    await this.desktopAction("player-fallback-approve", {});
    if (!runtime.fallbackSessionId) return this.envelope();
    const decision = (await this.fallbackAction({ action: "approve", sessionId: runtime.fallbackSessionId })).decision;
    if (decision.kind !== "attempt" || !decision.candidate) {
      return this.envelope();
    }
    return runtime.fallbackResolution
      ? this.attemptFallback(decision.candidate)
      : this.attemptPlaybackFallback(decision.candidate);
  }

  private async cancelFallback(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    this.tasks.get("playback")?.cancel();
    this.playerIntent += 1;
    await this.desktopAction("player-fallback-cancel", {});
    if (runtime.fallbackSessionId) {
      await this.fallbackAction({ action: "cancel", sessionId: runtime.fallbackSessionId });
    }
    return this.envelope();
  }

  private async beginFallback(resolution: PlaybackSourceResolution, selected: PlayableCandidate): Promise<void> {
    const runtime = this.requireRuntime();
    const candidates = resolution.candidates
      .filter((candidate) => candidate.playable && candidateCandidateId(candidate) !== candidateCandidateId(selected))
      .map(fallbackCandidate);
    runtime.fallbackSessionId = crypto.randomUUID();
    await this.fallbackAction({
      action: "begin",
      sessionId: runtime.fallbackSessionId,
      candidates,
      mode: this.fallbackMode,
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    });
  }

  private async handlePlaybackFailure(body: Record<string, unknown>, task?: RequestTask): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime.fallbackSessionId) return;
    let reason = stringValue(body.reason) || (isRecord(body.error) ? stringValue(body.error.message) : "")
      || "player playback failed";
    // A resolver failure is an unsuccessful attempt too. Keep advancing within
    // the original budget instead of requiring another video error to arrive.
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      task?.check();
      if (runtime.featureState.fallback?.status === "trying") {
        await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: false });
      }
      task?.check();
      const snapshot = await this.fallbackAction({
        action: "trigger", sessionId: runtime.fallbackSessionId,
        trigger: "player-fatal", reason,
      });
      task?.check();
      if (snapshot.decision.kind !== "attempt" || !snapshot.decision.candidate) return;
      try {
        if (runtime.fallbackResolution) await this.attemptFallback(snapshot.decision.candidate, task);
        else await this.attemptPlaybackFallback(snapshot.decision.candidate, task);
        return;
      } catch (error) {
        task?.check();
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    task?.check();
    await this.fallbackAction({ action: "stop", sessionId: runtime.fallbackSessionId, reason });
  }

  private async beginPlaybackFallback(lineIndex: number, episodeIndex: number): Promise<void> {
    const runtime = this.requireRuntime();
    const requests = new Map<string, { lineIndex: number; episodeIndex: number }>();
    const candidates: PlaybackFallbackCandidate[] = [];
    const currentLine = runtime.playbackCatalog?.lines.find((line) => line.index === lineIndex);
    const currentEpisode = currentLine?.episodes.find((episode) => episode.index === episodeIndex);
    for (const line of runtime.playbackCatalog?.lines ?? []) {
      if (!currentEpisode || line.index === lineIndex) continue;
      // Movie lines may use different labels ("正片" vs "HD中字") even
      // though each line contains one episode. Use the metadata-aware rule
      // only when the detail explicitly identifies a movie; series recovery
      // remains strict by episode number/name.
      const isMovie = /电影|movie/iu.test(String(
        runtime.detail?.type_name ?? runtime.detail?.type ?? runtime.detail?.vod_class ?? "",
      ));
      const match = recoverySelection(
        runtime.playbackCatalog!,
        { lineIndex, episodeIndex },
        { lines: [line] },
        isMovie ? runtime.detail ?? undefined : undefined,
        isMovie ? runtime.detail ?? undefined : undefined,
      );
      const episode = match ? line.episodes[match.episodeIndex] : null;
      if (!episode) continue;
      const id = `line:${line.index}:episode:${episode.index}`;
      requests.set(id, { lineIndex: line.index, episodeIndex: episode.index });
      candidates.push({
        id,
        label: `${line.name} · ${episode.name}`,
        kind: "same-content",
        sourceId: runtime.sourceId ?? "",
        lineKey: String(line.index),
      });
    }
    runtime.playbackFallbackRequests = requests;
    runtime.fallbackSessionId = crypto.randomUUID();
    await this.fallbackAction({
      action: "begin",
      sessionId: runtime.fallbackSessionId,
      candidates,
      mode: this.fallbackMode,
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    });
  }

  private async attemptPlaybackFallback(candidate: PlaybackFallbackCandidate, task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const request = runtime.playbackFallbackRequests.get(candidate.id);
    if (!request) {
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "stop", sessionId: runtime.fallbackSessionId, reason: "fallback candidate is unavailable" });
      }
      return this.envelope();
    }
    const previousPlayer = { ...(runtime.featureState.player ?? createRendererState().playback.player) };
    try {
      task?.check();
      await this.stopPlayer(true);
      task?.check();
      await this.play(request, task ? { signal: task.signal } : {}, previousPlayer);
      return this.envelope();
    } catch (error) {
      task?.check();
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: false });
      }
      throw error;
    }
  }

  private async attemptFallback(candidate: PlaybackFallbackCandidate, task?: RequestTask): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const resolution = runtime.fallbackResolution;
    const selected = resolution?.candidates.find(
      (item) => candidateCandidateId(item) === candidate.id,
    );
    if (!selected?.playable) {
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "stop", sessionId: runtime.fallbackSessionId, reason: "fallback candidate is unavailable" });
      }
      return this.envelope();
    }
    const previousPlayer = { ...(runtime.featureState.player ?? createRendererState().playback.player) };
    const currentCatalog = runtime.playbackCatalog;
    const currentSelection = runtime.playbackSelection;
    const currentVod = runtime.detail;
    const targetCatalog = playbackCatalog(selected.vod as Record<string, unknown>);
    const selection = currentCatalog && currentSelection && targetCatalog
      ? recoverySelection(currentCatalog, currentSelection, targetCatalog,
        this.fallbackMode === "auto" ? currentVod ?? undefined : undefined,
        this.fallbackMode === "auto" ? selected.vod as Record<string, unknown> : undefined)
      : null;
    if (!selection) {
      if (runtime.fallbackSessionId) await this.fallbackAction({ action: "stop", sessionId: runtime.fallbackSessionId, reason: "无法确认同片同集，请手动选择播放来源" });
      return this.envelope();
    }
    try {
      task?.check();
      await this.stopPlayer(true);
      task?.check();
      await this.selectPlaybackSource({
        siteKey: selected.siteKey,
        vodId: String(selected.vod.vod_id ?? selected.vod.id ?? ""),
        preserveFallback: true,
      });
      task?.check();
      const freshSelection = runtime.playbackCatalog && currentCatalog && currentSelection
        ? recoverySelection(currentCatalog, currentSelection, runtime.playbackCatalog,
          this.fallbackMode === "auto" ? currentVod ?? undefined : undefined,
          this.fallbackMode === "auto" ? runtime.detail ?? undefined : undefined) : null;
      if (!freshSelection) throw new Error("无法确认同片同集，请手动选择播放来源");
      await this.play({ ...freshSelection }, task ? { signal: task.signal } : {}, previousPlayer);
      return this.envelope();
    } catch (error) {
      task?.check();
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: false });
      }
      throw error;
    }
  }

  private async fallbackAction(
    payload: Omit<PlaybackFallbackPayload, "sessionId"> & { sessionId: string },
  ): Promise<PlaybackFallbackSnapshot> {
    const runtime = this.requireRuntime();
    const version = this.fallbackVersion;
    const snapshot = await requestPlaybackFallback(payload);
    if (this.runtime === runtime && version === this.fallbackVersion && runtime.fallbackSessionId === payload.sessionId) {
      this.setFallbackState(snapshot.state);
    }
    return snapshot;
  }

  private setFallbackState(state: PlaybackFallbackState | null): void {
    const runtime = this.requireRuntime();
    if (!state) {
      this.clearFallbackState();
      return;
    }
    runtime.featureState = { ...runtime.featureState, fallback: state };
  }

  private clearFallbackState(): void {
    const runtime = this.requireRuntime();
    const { fallback: _fallback, ...rest } = runtime.featureState;
    runtime.featureState = rest;
  }

  private async viewState(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const category = persistenceCategory(body.category);
    const search = persistenceSearch(body.search);
    const configSource = rememberedConfigSource(body.configSource);
    runtime.persistence = {
      ...runtime.persistence,
      ...(body.theme === "system" || body.theme === "light" || body.theme === "dark" ? { theme: body.theme } : {}),
      ...(isRendererNavigation(body.navigation) ? { navigation: body.navigation } : {}),
      configSource: configSource !== undefined ? configSource : runtime.persistence.configSource ?? null,
      ...(category !== undefined ? { category } : {}),
      ...(search !== undefined ? { search } : {}),
      ...(typeof body.scrollTop === "number" ? { scrollTop: Math.max(0, body.scrollTop) } : {}),
      ...(typeof body.siteKey === "string" ? { siteKey: body.siteKey } : {}),
      ...(typeof body.recentDetailId === "string" ? { recentDetailId: body.recentDetailId } : body.recentDetailId === null ? { recentDetailId: null } : {}),
    };
    await requestBusinessData({
      action: "upsert",
      entity: "view_state",
      id: "renderer",
      value: runtime.persistence as unknown as Record<string, unknown>,
    });
    return this.envelope();
  }

  private async restorePersistence(): Promise<void> {
    const runtime = this.requireRuntime();
    const snapshot = await requestBusinessData({
      action: "read",
      entity: "view_state",
      id: "renderer",
      value: {},
    });
    if (!snapshot.found || !snapshot.value) return;
    const value = snapshot.value;
    const category = persistenceCategory(value.category);
    const search = persistenceSearch(value.search);
    const configSource = rememberedConfigSource(value.configSource);
    runtime.persistence = {
      ...runtime.persistence,
      ...(value.theme === "system" || value.theme === "light" || value.theme === "dark" ? { theme: value.theme } : {}),
      ...(isRendererNavigation(value.navigation) ? { navigation: value.navigation } : {}),
      ...(typeof value.siteKey === "string" ? { siteKey: value.siteKey } : {}),
      configSource: configSource !== undefined ? configSource : runtime.persistence.configSource ?? null,
      ...(category !== undefined ? { category } : {}),
      ...(search !== undefined ? { search } : {}),
      ...(typeof value.scrollTop === "number" ? { scrollTop: Math.max(0, value.scrollTop) } : {}),
      ...(typeof value.recentDetailId === "string" ? { recentDetailId: value.recentDetailId } : {}),
    };
  }

  private restoreRememberedSite(): void {
    const runtime = this.requireRuntime();
    const rememberedKey = runtime.persistence.siteKey;
    if (!rememberedKey) return;
    const remembered = runtime.import.sites.find((site) => site.key === rememberedKey);
    if (!remembered) return;
    const site = toSite(remembered);
    runtime.selectedSite = site;
    runtime.import = { ...runtime.import, selectedSiteKey: site.key, selectedApi: site.api };
  }

  private async restoreBusinessFeatures(): Promise<void> {
    for (const feature of ["history", "favorites", "follow"] as const) {
      const snapshot = await requestBusinessFeature({
        action: "snapshot",
        feature,
        value: {},
      });
      this.applyFeatureSnapshot(snapshot);
    }
    this.applyCastSnapshot(await requestCast({ action: "snapshot", value: {} }));
    this.applyPushSnapshot(await requestPush({ action: "snapshot", value: {} }));
    this.applyDesktopSnapshot(await requestDesktopService({ action: "cache-snapshot", value: {} }));
  }

  private async featureAction(
    feature: BusinessFeaturePayload["feature"],
    action: string,
    id = "",
    value: Record<string, unknown> = {},
  ): Promise<RendererEnvelope> {
    const sourceId = this.businessFeatureSourceId(feature);
    const snapshot = await requestBusinessFeature({
      action,
      feature,
      ...(id ? { id } : {}),
      ...(sourceId ? { sourceId } : {}),
      value,
    });
    this.applyFeatureSnapshot(snapshot);
    return this.envelope();
  }

  private async refreshBusinessFeature(feature: BusinessFeaturePayload["feature"]): Promise<void> {
    const sourceId = this.businessFeatureSourceId(feature);
    const snapshot = await requestBusinessFeature({
      action: "snapshot",
      feature,
      ...(sourceId ? { sourceId } : {}),
      value: {},
    });
    this.applyFeatureSnapshot(snapshot);
  }

  private applyFeatureSnapshot(snapshot: BusinessFeatureSnapshot): void {
    const runtime = this.requireRuntime();
    runtime.featureState = {
      ...runtime.featureState,
      ...(snapshot.state as Partial<ApiSpiderState>),
    };
  }

  private businessFeatureSourceId(feature: BusinessFeaturePayload["feature"]): string | undefined {
    if (feature !== "favorites" && feature !== "follow") return undefined;
    const runtime = this.requireRuntime();
    return runtime.sourceId && runtime.selectedSite ? featureSourceId(runtime) : undefined;
  }

  private applyCastSnapshot(snapshot: CastSnapshot): void {
    const runtime = this.requireRuntime();
    const cast = snapshot.state.cast;
    runtime.featureState = {
      ...runtime.featureState,
      ...(isRecord(cast) ? { cast: cast as unknown as NonNullable<ApiSpiderState["cast"]> } : {}),
    };
  }

  private applyPushSnapshot(snapshot: PushSnapshot): void {
    const runtime = this.requireRuntime();
    const push = snapshot.state.push;
    runtime.featureState = {
      ...runtime.featureState,
      ...(isRecord(push) ? { push: push as unknown as NonNullable<ApiSpiderState["push"]> } : {}),
    };
  }

  private applyDesktopSnapshot(snapshot: { state: Record<string, unknown> }): void {
    const runtime = this.requireRuntime();
    const localFallback = runtime.featureState.fallback;
    runtime.featureState = {
      ...runtime.featureState,
      ...(snapshot.state as Partial<ApiSpiderState>),
      ...(localFallback ? { fallback: localFallback } : {}),
    };
  }

  private async castAction(
    action: "snapshot" | "discover" | "pause" | "resume" | "stop" | "seek" | "position" | "transport" | "disconnect",
    value: Record<string, unknown>,
  ): Promise<RendererEnvelope> {
    const snapshot = await requestCast({ action, value });
    this.applyCastSnapshot(snapshot);
    return this.envelope();
  }

  private async castPlay(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const source = runtime.playerSource;
    if (!source?.url?.trim()) throw new Error("TAURI_CAST_MEDIA_NOT_READY");
    const url = source.url.trim();
    const title = stringValue(runtime.detail?.vod_name ?? runtime.detail?.title).trim() || "QX Cast";
    const snapshot = await requestCast({
      action: "play",
      value: {
        ...body,
        url,
        title,
        ...(source.mediaType && source.mediaType !== "unknown"
          ? { contentType: castContentType(source.mediaType) }
          : {}),
      },
    });
    this.applyCastSnapshot(snapshot);
    return this.envelope();
  }

  private async pushAction(
    action: "refresh" | "settings" | "submit" | "cancel" | "clear",
    value: Record<string, unknown>,
  ): Promise<RendererEnvelope> {
    const snapshot = await requestPush({ action, value });
    this.applyPushSnapshot(snapshot);
    return this.envelope();
  }

  private async pushConfirm(
    body: Record<string, unknown>,
    decision: "play" | "reject",
  ): Promise<RendererEnvelope> {
    const snapshot = await requestPush({
      action: decision === "reject" ? "reject" : "confirm",
      value: { ...body, decision },
    });
    this.applyPushSnapshot(snapshot);
    if (decision === "play") await this.startPushPlayback(snapshot);
    return this.envelope();
  }

  private async startPushPlayback(snapshot: PushSnapshot): Promise<void> {
    const runtime = this.requireRuntime();
    const result = record(snapshot.state.result);
    const playback = record(result.playback);
    const url = stringValue(playback.url).trim();
    if (!url) return;
    if (!/^https?:\/\//iu.test(url)) throw new Error("TAURI_PUSH_PLAYBACK_URL_INVALID");
    if (runtime.proxySessionId) {
      await requestPlaybackProxy({ action: "close", sessionId: runtime.proxySessionId });
    }
    const sessionId = stringValue(playback.sessionId).trim() || `${runtime.sessionId}:push`;
    const proxy = await requestPlaybackProxy({ action: "start", sessionId, url });
    if (!proxy.proxyUrl) throw new Error("TAURI_PUSH_PROXY_URL_MISSING");
    runtime.proxySessionId = sessionId;
    runtime.playerSource = {
      parse: 0,
      url: proxy.proxyUrl,
      headers: {},
      backend: "embedded",
      mediaType: proxy.mediaType === "hls" ? "hls" : proxy.mediaType === "dash" ? "dash" : "mp4",
    };
  }

  private async desktopAction(action: string, value: Record<string, unknown>, current?: () => boolean): Promise<RendererEnvelope> {
    const snapshot = await requestDesktopService({ action, value });
    if (current && !current()) return this.envelope();
    const state = { ...snapshot.state };
    const localPlaybackPath = action === "local-play" ? stringValue(state.localPlaybackPath) : "";
    if ("localPlaybackPath" in state) delete state.localPlaybackPath;
    this.applyDesktopSnapshot({ state });
    if (localPlaybackPath) {
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const runtime = this.requireRuntime();
      runtime.playerSource = {
        parse: 0,
        url: convertFileSrc(localPlaybackPath),
        headers: {},
        backend: "embedded",
        mediaType: "unknown",
      };
    }
    return this.envelope();
  }

  private async componentAction(action: ComponentManagerAction, value: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const snapshot = await requestComponentManager({
      action,
      ...(typeof value.componentId === "string" ? { componentId: value.componentId } : {}),
      ...(typeof value.manifestJson === "string" ? { manifestJson: value.manifestJson } : {}),
      ...(typeof value.signatureBase64 === "string" ? { signatureBase64: value.signatureBase64 } : {}),
      ...(typeof value.publicKeyBase64 === "string" ? { publicKeyBase64: value.publicKeyBase64 } : {}),
      ...(typeof value.artifactBase64 === "string" ? { artifactBase64: value.artifactBase64 } : {}),
      ...(typeof value.running === "boolean" ? { running: value.running } : {}),
    });
    runtime.componentManager = snapshot;
    return this.envelope();
  }

  private async openHistory(identity: string): Promise<RendererEnvelope> {
    const item = this.featureItems("history").find((candidate) => stringValue(candidate.identity) === identity);
    if (!item) throw new Error("TAURI_HISTORY_NOT_FOUND");
    const runtime = this.requireRuntime();
    const site = this.featureSiteForItem(item);
    if (!site) throw new Error("TAURI_HISTORY_SOURCE_SWITCH_REQUIRED");
    if (runtime.selectedSite?.key !== site.key) await this.select(site.key);
    await this.detail(stringValue(item.vodId));
    const selection = this.historySelectionForItem(item);
    if (selection) {
      runtime.playbackSelection = { lineIndex: selection.lineIndex, episodeIndex: selection.episodeIndex };
      runtime.featureState = {
        ...runtime.featureState,
        historyResume: historyResumeCandidate(item, selection),
      };
    }
    return this.envelope();
  }

  private async toggleFavoriteDetail(): Promise<RendererEnvelope> {
    const content = this.currentContent();
    const snapshot = await requestBusinessFeature({
      action: "toggle",
      feature: "favorites",
      sourceId: stringValue(content.sourceId),
      value: content,
    });
    this.applyFeatureSnapshot(snapshot);
    await this.refreshBusinessFeature("favorites").catch(() => undefined);
    return this.envelope();
  }

  private favoriteIdForDetail(): string {
    const content = this.currentContent();
    return stringValue(this.featureItems("favorites").find((item) =>
      stringValue(item.sourceId) === stringValue(content.sourceId)
      && stringValue(item.vodId) === stringValue(content.vodId),
    )?.favoriteId);
  }

  private async openFavorite(favoriteId: string): Promise<RendererEnvelope> {
    const item = this.featureItems("favorites").find((candidate) => stringValue(candidate.favoriteId) === favoriteId);
    if (!item) throw new Error("TAURI_FAVORITE_NOT_FOUND");
    const runtime = this.requireRuntime();
    const site = this.featureSiteForItem(item);
    if (!site) throw new Error("TAURI_FAVORITE_SOURCE_SWITCH_REQUIRED");
    if (runtime.selectedSite?.key !== site.key) await this.select(site.key);
    await this.detail(stringValue(item.vodId));
    this.applyHistoryResumeForContent(stringValue(item.vodId));
    return this.envelope();
  }

  private featureSiteForItem(item: Record<string, unknown>): TauriSite | null {
    const runtime = this.requireRuntime();
    const sourceId = stringValue(item.sourceId);
    if (!sourceId || !runtime.sourceId) return null;
    return runtime.import.sites
      .map(toSite)
      .find((site) => featureSourceIdFor(runtime.sourceId ?? "", site.key) === sourceId) ?? null;
  }

  private async toggleFollowDetail(favoriteToo = false): Promise<RendererEnvelope> {
    const content = this.currentContent();
    const identity = `${stringValue(content.sourceId)}:${stringValue(content.vodId)}:follow`;
    const existing = this.featureItems("follow").some((item) => stringValue(item.identity) === identity);
    const snapshot = await requestBusinessFeature({
      action: existing ? "delete" : "upsert",
      feature: "follow",
      id: identity,
      sourceId: stringValue(content.sourceId),
      value: { identity, ...content, enabled: true, updateAvailable: false },
    });
    this.applyFeatureSnapshot(snapshot);
    await this.refreshBusinessFeature("follow").catch(() => undefined);
    if (favoriteToo) return this.toggleFavoriteDetail();
    return this.envelope();
  }

  private async openFollow(identity: string): Promise<RendererEnvelope> {
    const item = this.featureItems("follow").find((candidate) => stringValue(candidate.identity) === identity);
    if (!item) throw new Error("TAURI_FOLLOW_NOT_FOUND");
    const runtime = this.requireRuntime();
    if (stringValue(item.sourceId) !== featureSourceId(runtime)) throw new Error("TAURI_FOLLOW_SOURCE_SWITCH_REQUIRED");
    await this.detail(stringValue(item.vodId));
    this.applyHistoryResumeForContent(stringValue(item.vodId));
    return this.envelope();
  }

  private applyHistoryResumeForContent(vodId: string): void {
    const runtime = this.requireRuntime();
    const normalizedVodId = featureIdentifier(vodId, "vod") ?? vodId;
    const item = this.featureItems("history").find((candidate) => (
      stringValue(candidate.sourceId) === featureSourceId(runtime)
      && (stringValue(candidate.vodId) === vodId || stringValue(candidate.vodId) === normalizedVodId)
    ));
    if (!item) return;
    const selection = this.historySelectionForItem(item);
    if (!selection) return;
    runtime.playbackSelection = { lineIndex: selection.lineIndex, episodeIndex: selection.episodeIndex };
    runtime.featureState = {
      ...runtime.featureState,
      historyResume: historyResumeCandidate(item, selection),
    };
  }

  private async refreshFollow(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    for (const item of this.featureItems("follow")) {
      if (stringValue(item.sourceId) !== featureSourceId(runtime)) continue;
      const result = await this.sourceRequest({
        action: "call",
        sessionId: runtime.sessionId,
        method: "detail",
        params: { ids: [stringValue(item.vodId)] },
      });
      const detail = listItems(result.result)[0] ?? record(result.result);
      const episodes = playbackCatalog(detail, runtime.selectedSite?.api)?.lines.flatMap((line) => line.episodes.map((episode) => ({
        id: featureIdentifier(episode.id, `episode:${episode.index}`),
        name: episode.name,
      }))) ?? [];
      const snapshot = await requestBusinessFeature({
        action: "upsert",
        feature: "follow",
        id: stringValue(item.identity),
        sourceId: featureSourceId(runtime),
        value: {
          ...item,
          title: stringValue(detail.vod_name ?? detail.title) || stringValue(item.title),
          poster: stringValue(detail.vod_pic ?? detail.poster) || null,
          episodes,
          latestEpisodeId: episodes.at(-1)?.id ?? null,
          latestEpisodeName: episodes.at(-1)?.name ?? null,
          lastCheckedAt: Date.now(),
        },
      });
      this.applyFeatureSnapshot(snapshot);
    }
    return this.envelope();
  }

  private currentContent(): Record<string, unknown> {
    const runtime = this.requireRuntime();
    const vodId = runtime.detail ? stringValue(runtime.detail.vod_id ?? runtime.detail.id) : "";
    if (!vodId) throw new Error("TAURI_DETAIL_REQUIRED");
    const episodes = runtime.playbackCatalog?.lines.flatMap((line) => line.episodes.map((episode) => ({
      id: featureIdentifier(episode.id, `episode:${episode.index}`),
      name: episode.name,
    }))) ?? [];
    return {
      sourceId: featureSourceId(runtime),
      vodId: featureIdentifier(vodId, "vod") ?? vodId,
      title: runtime.detail ? stringValue(runtime.detail.vod_name ?? runtime.detail.title) || vodId : vodId,
      poster: runtime.detail ? stringValue(runtime.detail.vod_pic ?? runtime.detail.poster) || null : null,
      episodes,
    };
  }

  private featureItems(feature: "history" | "favorites" | "follow"): Record<string, unknown>[] {
    const runtime = this.requireRuntime();
    const state = runtime.featureState[feature];
    if (!isRecord(state) || !Array.isArray(state.items)) return [];
    return state.items.filter(isRecord).map((item) => ({ ...item }));
  }

  private historySelectionForItem(item: Record<string, unknown>): HistorySelection | null {
    const runtime = this.requireRuntime();
    const catalog = runtime.playbackCatalog;
    if (!catalog) return null;
    const episodeId = stringValue(item.episodeId);
    const episodeNumber = numberValue(item.episode, 0);
    const playbackLine = stringValue(item.playbackLine);
    const preferredLines = playbackLine
      ? catalog.lines.filter((line) => line.name === playbackLine)
      : [];
    const lines = preferredLines.length > 0 ? preferredLines : catalog.lines;
    for (const line of lines) {
      const episodeIndex = line.episodes.findIndex((episode, index) => (
        (episodeId && (episode.id === episodeId || featureIdentifier(episode.id, `episode:${episode.index}`) === episodeId))
        || (episodeNumber > 0 && index === episodeNumber - 1)
        || (episodeNumber === 0 && index === 0)
      ));
      if (episodeIndex < 0) continue;
      const episode = line.episodes[episodeIndex];
      if (!episode) continue;
      return {
        lineIndex: line.index,
        episodeIndex,
        lineName: line.name,
        episodeName: episode.name,
      };
    }
    return null;
  }

  private async sourceRequest(payload: SourceSessionPayload, task?: RequestTask): Promise<SourceSessionResult> {
    const runtime = this.requireRuntime();
    const quickJs = runtime.quickJs;
    if (!task) return quickJs ? this.quickJsRequest(payload) : requestSourceSession(payload);
    task.check();
    const sessionId = payload.sessionId;
    const cancel = (): void => {
      if (runtime.sessionId === sessionId) {
        runtime.sessionReady = false;
        runtime.import = { ...runtime.import, sessionReady: false };
      }
      if (quickJs) void requestQuickJsSession({ action: "close", sessionId }).catch(() => undefined);
      else {
        void requestSourceSession({ action: "cancel", sessionId }).catch(() => undefined);
        void requestSourceSession({ action: "close", sessionId }).catch(() => undefined);
      }
    };
    task.signal.addEventListener("abort", cancel, { once: true });
    const request = quickJs ? this.quickJsRequest(payload) : requestSourceSession({ ...payload, timeoutMs: task.remainingMs() });
    void request.then(() => { if (task.signal.aborted && payload.action === "open") cancel(); }, () => undefined);
    try { return await task.wait(request); }
    finally { task.signal.removeEventListener("abort", cancel); }
  }

  private async quickJsRequest(payload: SourceSessionPayload): Promise<SourceSessionResult> {
    return requestQuickJsSession({
      action: payload.action,
      sessionId: payload.sessionId,
      ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
      ...(payload.siteKey === undefined ? {} : { siteKey: payload.siteKey }),
      ...(payload.api === undefined ? {} : { api: payload.api }),
      ...(payload.siteType === undefined ? {} : { siteType: payload.siteType }),
      ...(payload.ext === undefined ? {} : { ext: payload.ext }),
      ...(payload.method === undefined ? {} : { method: payload.method }),
      ...(payload.params === undefined ? {} : { params: payload.params }),
    });
  }

  private connectingEnvelope(): RendererEnvelope {
    const envelope = this.envelope();
    if (envelope.state) envelope.state = { ...envelope.state, loading: true };
    return envelope;
  }

  private async closeQuickJs(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime.quickJs) return;
    try {
      await requestQuickJsSession({ action: "close", sessionId: runtime.sessionId });
    } finally {
      runtime.quickJs = false;
      runtime.quickJsMethods = {};
      runtime.capabilities = null;
      runtime.sessionReady = false;
      runtime.import = { ...runtime.import, sessionReady: false };
    }
  }

  private async closeSourceSession(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime.sessionReady && !runtime.quickJs) return;
    try {
      await this.sourceRequest({
        action: "close",
        sessionId: runtime.sessionId,
      });
    } finally {
      runtime.sessionReady = false;
      runtime.quickJs = false;
      runtime.quickJsMethods = {};
      runtime.capabilities = null;
      runtime.import = { ...runtime.import, sessionReady: false };
    }
  }

  private envelope(): RendererEnvelope {
    const runtime = this.requireRuntime();
    const base = createRendererState();
    const playerHost = runtime.playerDetached || runtime.playerSource?.backend === "mpv" ? "detached" : "embedded";
    const detailId = runtime.detail
      ? featureIdentifier(stringValue(runtime.detail.vod_id ?? runtime.detail.id), "vod")
      : null;
    const detailSourceId = runtime.sourceId && runtime.selectedSite ? featureSourceId(runtime) : null;
    const favoriteDetail = detailId && detailSourceId
      ? runtime.featureState.favorites?.items.find((item) => stringValue(item.sourceId) === detailSourceId && stringValue(item.vodId) === detailId) ?? null
      : null;
    const followIdentity = detailId && detailSourceId ? `${detailSourceId}:${detailId}:follow` : null;
    const followDetail = followIdentity
      ? runtime.featureState.follow?.items.find((item) => stringValue(item.identity) === followIdentity) ?? null
      : null;
    const syncedPlayer = runtime.featureState.player ?? base.playback.player;
    return {
      import: runtime.import,
      persistence: runtime.persistence,
      state: {
        ...runtime.featureState,
        page: runtime.page,
        source: runtime.source,
        api: runtime.selectedSite?.api ?? null,
        status: runtime.sessionReady ? "idle" : "confirmation_required",
        loading: false,
        warning: runtime.import.warning,
        error: null,
        sidecarRunning: runtime.sessionReady,
        capabilities: runtime.capabilities,
        sourceId: runtime.sourceId,
        playback: runtime.playerSource
          ? {
              available: true,
              label: "Tauri playback proxy",
              message: "已建立 Tauri 播放代理",
              parse: runtime.playerSource.parse,
              url: runtime.playerSource.url,
              headers: {},
            }
          : base.playback.playback,
        player: runtime.playerSource
          ? {
              ...syncedPlayer,
              status: syncedPlayer.status === "idle" ? "loading" : syncedPlayer.status,
              source: runtime.playerSource,
            }
          : syncedPlayer,
        playerHost,
        canPlay: runtime.playbackCatalog?.lines.some((line) => line.episodes.length > 0) ?? false,
        items: runtime.items,
        categories: runtime.categories,
        filters: runtime.filters,
        detail: runtime.detail,
        playbackCatalog: runtime.playbackCatalog,
        playbackSelection: runtime.playbackSelection,
        playbackSession: runtime.playerSource
          ? {
              id: runtime.proxySessionId ?? runtime.sessionId,
              host: playerHost,
              lineIndex: runtime.playbackSelection?.lineIndex ?? null,
              episodeIndex: runtime.playbackSelection?.episodeIndex ?? null,
              lineName: runtime.playbackCatalog?.lines.find((line) => line.index === runtime.playbackSelection?.lineIndex)?.name ?? null,
              episodeName: runtime.playbackCatalog?.lines
                .find((line) => line.index === runtime.playbackSelection?.lineIndex)
                ?.episodes[runtime.playbackSelection?.episodeIndex ?? 0]?.name ?? null,
              media: {
                detailId: runtime.detail ? stringValue(runtime.detail.vod_id ?? runtime.detail.id) || null : null,
                title: runtime.detail ? stringValue(runtime.detail.vod_name ?? runtime.detail.title) || null : null,
                url: runtime.playerSource.url,
              },
            }
          : null,
        favoriteDetail,
        followDetail,
        componentManager: runtime.componentManager,
      },
    };
  }

  private requireRuntime(): TauriRuntimeState {
    if (!this.runtime) throw new Error("TAURI_RENDERER_IMPORT_REQUIRED");
    return this.runtime;
  }
}

function playerWindowPlayerSnapshot(player: PlayerState): PlayerState {
  return {
    status: player.status,
    source: player.source ? playerWindowSourceSnapshot(player.source) : null,
    currentTime: numberValue(player.currentTime, 0),
    duration: numberValue(player.duration, 0),
    volume: Math.min(1, Math.max(0, numberValue(player.volume, 1))),
    muted: player.muted === true,
    fullscreen: player.fullscreen === true,
    playbackRate: numberValue(player.playbackRate, 1),
    resumePaused: player.status === "paused" || player.resumePaused === true,
    error: playerWindowErrorSnapshot(player.error),
    ...(player.parse
      ? {
          parse: {
            status: player.parse.status,
            parserId: typeof player.parse.parserId === "string" ? player.parse.parserId : null,
            attempts: Array.isArray(player.parse.attempts)
              ? player.parse.attempts.map((attempt) => ({
                  parserId: String(attempt.parserId ?? ""),
                  parserType: String(attempt.parserType ?? ""),
                  status: attempt.status,
                  elapsedMs: numberValue(attempt.elapsedMs, 0),
                  ...(typeof attempt.code === "string" ? { code: attempt.code } : {}),
                  ...(typeof attempt.message === "string" ? { message: attempt.message } : {}),
                }))
              : [],
            error: playerWindowErrorSnapshot(player.parse.error),
          },
        }
      : {}),
  };
}

function playerWindowSourceSnapshot(source: PlayerSource): PlayerSource {
  return {
    parse: numberValue(source.parse, 0),
    url: typeof source.url === "string" ? source.url : "",
    headers: headersValue(source.headers),
    ...(source.backend === "embedded" || source.backend === "mpv" ? { backend: source.backend } : {}),
    ...(source.mediaType === "hls" || source.mediaType === "dash" || source.mediaType === "mp4"
      || source.mediaType === "flv" || source.mediaType === "web" || source.mediaType === "unknown"
      ? { mediaType: source.mediaType }
      : {}),
    ...(source.drm
      ? {
          drm: {
            ...(source.drm.clearKeys ? { clearKeys: headersValue(source.drm.clearKeys) } : {}),
            ...(source.drm.servers ? { servers: headersValue(source.drm.servers) } : {}),
          },
        }
      : {}),
    ...(typeof source.playUrl === "string" ? { playUrl: source.playUrl } : {}),
    ...(typeof source.jx === "number" && Number.isFinite(source.jx) ? { jx: source.jx } : {}),
    ...(typeof source.format === "string" ? { format: source.format } : {}),
    ...(typeof source.flag === "string" ? { flag: source.flag } : {}),
    ...(typeof source.jxFrom === "string" ? { jxFrom: source.jxFrom } : {}),
    ...(Array.isArray(source.subtitles)
      ? {
          subtitles: source.subtitles.map((track) => ({
            id: String(track.id ?? ""),
            label: String(track.label ?? ""),
            language: String(track.language ?? ""),
            format: track.format,
            ...(typeof track.url === "string" ? { url: track.url } : {}),
            ...(typeof track.localPath === "string" ? { localPath: track.localPath } : {}),
            ...(track.headers ? { headers: headersValue(track.headers) } : {}),
            default: track.default === true,
            forced: track.forced === true,
            ...(track.source ? { source: track.source } : {}),
          })),
        }
      : {}),
  };
}

function playerWindowErrorSnapshot(error: RendererError | null): RendererError | null {
  if (!error || typeof error.code !== "string" || typeof error.message !== "string") return null;
  return {
    code: error.code,
    message: error.message,
    ...(typeof error.title === "string" ? { title: error.title } : {}),
    ...(typeof error.source === "string" ? { source: error.source } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(typeof error.diagnosticId === "string" ? { diagnosticId: error.diagnosticId } : {}),
    ...(typeof error.timestamp === "string" ? { timestamp: error.timestamp } : {}),
    ...(error.safeDetails ? { safeDetails: headersValue(error.safeDetails) } : {}),
    ...(typeof error.causeCode === "string" ? { causeCode: error.causeCode } : {}),
  };
}

function playerWindowSessionSnapshot(session: RendererPlaybackSession): RendererPlaybackSession {
  return {
    id: String(session.id ?? ""),
    host: session.host === "detached" ? "detached" : "embedded",
    lineIndex: typeof session.lineIndex === "number" && Number.isFinite(session.lineIndex) ? session.lineIndex : null,
    episodeIndex: typeof session.episodeIndex === "number" && Number.isFinite(session.episodeIndex) ? session.episodeIndex : null,
    lineName: typeof session.lineName === "string" ? session.lineName : null,
    episodeName: typeof session.episodeName === "string" ? session.episodeName : null,
    media: {
      detailId: typeof session.media?.detailId === "string" ? session.media.detailId : null,
      title: typeof session.media?.title === "string" ? session.media.title : null,
      url: typeof session.media?.url === "string" ? session.media.url : "",
    },
  };
}

function castContentType(mediaType: NonNullable<PlayerSource["mediaType"]>): string {
  switch (mediaType) {
    case "hls": return "application/vnd.apple.mpegurl";
    case "dash": return "application/dash+xml";
    case "flv": return "video/x-flv";
    case "web": return "text/html";
    case "mp4": return "video/mp4";
    default: return "video/mp4";
  }
}

function toSite(site: ConfigSiteSummary | { key: string; name: string; api: string }): TauriSite {
  const siteType = "siteType" in site && (site.siteType === 0 || site.siteType === 1 || site.siteType === 3 || site.siteType === 4)
    ? site.siteType
    : inferSiteType(site.api);
  return {
    key: site.key,
    name: site.name,
    api: site.api,
    siteType,
    ...("ext" in site && site.ext !== undefined ? { ext: site.ext } : {}),
  };
}

function isJianpianSite(site: TauriSite): boolean {
  return site.key.trim().toLowerCase() === "jianpian"
    || site.api.trim().toLowerCase() === "csp_jianpian"
    || site.name.includes("荐片");
}

function isFeimaoSite(site: TauriSite): boolean {
  return site.key.includes("肥猫");
}

function homeSourceCandidates(sites: readonly TauriSite[], preferredSiteKey: string | null): TauriSite[] {
  const remembered = preferredSiteKey?.trim()
    ? sites.find((site) => site.key === preferredSiteKey.trim())
    : undefined;
  const jianpian = sites.find(isJianpianSite);
  const ordered = [remembered, jianpian, ...sites].filter((site): site is TauriSite => Boolean(site));
  const seen = new Set<string>();
  return ordered.filter((site) => {
    if (seen.has(site.key)) return false;
    seen.add(site.key);
    return true;
  });
}

function isDefaultSourceUrl(value: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(DEFAULT_SOURCE_URL);
    return actual.protocol === expected.protocol
      && actual.hostname.toLowerCase() === expected.hostname.toLowerCase()
      && (actual.port || "") === (expected.port || "")
      && actual.pathname.replace(/\/+$/u, "") === expected.pathname.replace(/\/+$/u, "")
      && actual.search === expected.search;
  } catch {
    return value.trim() === DEFAULT_SOURCE_URL;
  }

}

function stableSourceIdForSite(site: TauriSite): string {
  return `site:${site.key.trim()}`;
}

function summaryFor(snapshot: ConfigCatalogSnapshot, sites: readonly TauriSite[]): ImportState["summary"] {
  const engineCounts: Record<string, number> = {};
  for (const site of sites) {
    const engine = site.api.toLowerCase() === "csp_jianpian" || site.api.toLowerCase() === "csp_douban"
      ? "native"
      : site.siteType === 3 ? "runtime" : "http";
    engineCounts[engine] = (engineCounts[engine] ?? 0) + 1;
  }
  return {
    siteCount: snapshot.siteCount,
    parseCount: 0,
    ruleCount: 0,
    hasSpider: sites.some((site) => site.siteType === 3),
    topLevelKeys: ["sites"],
    engineCounts,
  };
}

function importStateFor(
  snapshot: ConfigCatalogSnapshot,
  inputKind: Exclude<ImportState["inputKind"], null>,
  sourceKind: Exclude<ImportState["sourceKind"], null>,
  sites: readonly TauriSite[],
): ImportState {
  const preferred = (isDefaultSourceUrl(snapshot.source)
    ? sites.find((site) => site.key === DEFAULT_SOURCE_SITE_KEY)
    : sites.find(isJianpianSite)) ?? sites[0];
  return {
    status: "confirmation_required",
    loading: false,
    inputKind,
    source: snapshot.source,
    sourceKind,
    warning: snapshot.warningCode ?? null,
    error: null,
    trusted: false,
    summary: summaryFor(snapshot, sites),
    sites: sites.map((site) => ({
      key: site.key,
      name: site.name,
      api: site.api,
      ...(site.ext === undefined ? {} : { ext: site.ext }),
    })),
    selectedSiteKey: preferred?.key ?? null,
    selectedApi: preferred?.api ?? null,
    sessionReady: false,
  };
}

function inputKindForCatalogKind(sourceKind: ConfigCatalogSnapshot["sourceKind"]): Exclude<ImportState["inputKind"], null> {
  return sourceKind === "url" ? "url" : sourceKind === "file" ? "file" : "json";
}

function importSourceKindForCatalogKind(sourceKind: ConfigCatalogSnapshot["sourceKind"]): Exclude<ImportState["sourceKind"], null> {
  return sourceKind === "url" ? "remote" : sourceKind === "file" ? "local" : "inline";
}

function rememberedConfigSource(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const source = value.trim();
  if (!source) return null;
  if (/^(?:file|inline):/iu.test(source)) return source;
  try {
    const url = new URL(source);
    if (!/^https?:$/iu.test(url.protocol) || url.username || url.password) return null;
    const sensitiveQuery = new Set(["token", "access_token", "authorization", "cookie", "password", "secret"]);
    for (const key of url.searchParams.keys()) {
      if (sensitiveQuery.has(key.toLowerCase())) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function listItems(value: unknown): Record<string, unknown>[] {
  const object = record(value);
  const list = Array.isArray(object.list) ? object.list : Array.isArray(object.items) ? object.items : [];
  return list.filter(isRecord).map((item) => ({ ...item }));
}

function sanitizeVodDescriptionFields(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...value };
  for (const field of ["vod_content", "vod_blurb"] as const) {
    if (typeof sanitized[field] === "string") {
      sanitized[field] = sanitizeVodDisplayText(sanitized[field]);
    }
  }
  return sanitized;
}

function browseMetadata(value: unknown): { categories: BrowseCategory[]; filters: BrowseFilter[] } {
  const object = record(value);
  const categoryValues = Array.isArray(object.class)
    ? object.class
    : Array.isArray(object.categories)
      ? object.categories
      : [];
  const categories = categoryValues.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = stringValue(candidate.type_id ?? candidate.typeId ?? candidate.id).trim();
    const name = stringValue(candidate.type_name ?? candidate.name ?? candidate.title).trim();
    return id && name ? [{ id, name }] : [];
  });
  const filterValues = Array.isArray(object.filters) ? object.filters : [];
  const filters = filterValues.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = stringValue(candidate.id ?? candidate.key ?? candidate.type).trim();
    const name = stringValue(candidate.name ?? candidate.label ?? candidate.title).trim();
    const values = Array.isArray(candidate.options)
      ? candidate.options
      : Array.isArray(candidate.values)
        ? candidate.values
        : [];
    const options = values.flatMap((option) => {
      if (!isRecord(option)) return [];
      const optionId = stringValue(option.id ?? option.value ?? option.key).trim();
      const optionName = stringValue(option.name ?? option.label ?? option.title ?? option.value).trim();
      return optionId && optionName ? [{ id: optionId, name: optionName }] : [];
    });
    return id && name && options.length > 0 ? [{ id, name, options }] : [];
  });
  return {
    categories: uniqueById(categories),
    filters: uniqueById(filters),
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

export function playbackCatalog(value: Record<string, unknown>, sourceApi = ""): PlaybackCatalog | null {
  const from = stringValue(value.vod_play_from);
  const urls = stringValue(value.vod_play_url);
  if (!from || !urls) return null;
  const preservePlayerHandoff = sourceApi.trim().toLowerCase() === "csp_apprj";
  const fromLines = from.split("$$$");
  const urlLines = urls.split("$$$");
  const lines: PlaybackLine[] = [];
  for (let index = 0; index < urlLines.length; index += 1) {
    const episodes = urlLines[index]?.split("#").flatMap((entry, episodeIndex) => {
      const dollar = entry.indexOf("$");
      const label = dollar >= 0 ? entry.slice(0, dollar) : String(episodeIndex + 1);
      const rawId = dollar >= 0 ? entry.slice(dollar + 1) : entry;
      const id = preservePlayerHandoff ? rawId : rawId.split("|")[0];
      if (!id) return [];
      return [{ index: episodeIndex, name: label || String(episodeIndex + 1), id }];
    }) ?? [];
    const orderedEpisodes = sortPlaybackEpisodes(episodes);
    if (episodes.length > 0) {
      lines.push({
        index,
        name: fromLines[index] || `线路 ${index + 1}`,
        protocol: orderedEpisodes.some((episode) => /\.m3u8(?:$|[?#])/iu.test(episode.id)) ? "HLS" : "MP4",
        episodes: orderedEpisodes,
      });
    }
  }
  return lines.length > 0 ? { lines } : null;
}

function sortPlaybackEpisodes(episodes: PlaybackEpisode[]): PlaybackEpisode[] {
  return episodes
    .map((episode, originalIndex) => ({
      episode,
      originalIndex,
      number: episodeNumber(episode.name),
      version: episodeVersion(episode.name),
    }))
    .sort((left, right) => {
      if (left.number === null && right.number === null) return left.originalIndex - right.originalIndex;
      if (left.number === null) return 1;
      if (right.number === null) return -1;
      return left.number - right.number
        || left.version - right.version
        || left.originalIndex - right.originalIndex;
    })
    .map(({ episode }, index) => ({ ...episode, index }));
}

function episodeNumber(label: string): number | null {
  const normalized = label.trim();
  const match = normalized.match(/第\s*(\d+)\s*集/u)
    ?? normalized.match(/(?:^|[\s_-])(?:ep(?:isode)?\s*)?(\d+)(?=\D|$)/iu);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function episodeVersion(label: string): number {
  const match = label.match(/v(\d+)\b/iu);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : 0;
}

function headersValue(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function candidateCandidateId(candidate: PlayableCandidate): string {
  const vodId = String(candidate.vod.vod_id ?? candidate.vod.id ?? "").trim();
  return recoveryCandidateId(candidate.siteKey, vodId);
}

function fallbackCandidate(candidate: PlayableCandidate): PlaybackFallbackCandidate {
  const vodName = String(candidate.vod.vod_name ?? candidate.vod.name ?? "").trim();
  return {
    id: candidateCandidateId(candidate),
    label: `${candidate.siteName}${vodName ? ` · ${vodName}` : ""}`,
    kind: "same-content",
    sourceId: candidate.siteKey,
  };
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value);
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function inferSiteType(api: string): 0 | 1 | 3 | 4 {
  return /^https?:\/\//iu.test(api) ? 1 : 3;
}

function isQuickJsSite(api: string): boolean {
  const value = api.trim().toLowerCase();
  return value.startsWith("js:") || /\.m?js(?:[?#].*)?$/iu.test(value);
}

function usesQuickJsRuntime(site: TauriSite): boolean {
  if (!isQuickJsSite(site.api)) return false;
  const api = site.api.trim().toLowerCase();
  const ext = (site.ext ?? "").trim().toLowerCase();
  const drpy2 = ["/drpy2.min.js", "/drpy2.js"].some((suffix) => (
    api.endsWith(suffix) || api.includes(`${suffix}?`) || api.includes(`${suffix}#`)
  ));
  const tuxiaobei = [
    "/tuxiaobei.js",
    "/兔小贝.js",
    "/%e5%85%94%e5%b0%8f%e8%b4%9d.js",
  ].some((suffix) => (
    ext.endsWith(suffix) || ext.includes(`${suffix}?`) || ext.includes(`${suffix}#`)
  ));
  return !(drpy2 && tuxiaobei);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRendererNavigation(value: unknown): value is RendererPersistenceState["navigation"] {
  return value === "home"
    || value === "category"
    || value === "search"
    || value === "detail"
    || value === "history"
    || value === "favorites"
    || value === "follow"
    || value === "settings"
    || value === "local"
    || value === "downloads";
}

function persistenceCategory(value: unknown): RendererPersistenceState["category"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const typeId = stringValue(value.typeId).trim();
  const page = numberValue(value.page, 0);
  if (!typeId || !Number.isInteger(page) || page <= 0) return undefined;
  const filters = isRecord(value.filters)
    ? Object.fromEntries(
        Object.entries(value.filters)
          .filter(([key, item]) => key.trim().length > 0 && typeof item === "string" && item.trim().length > 0)
          .map(([key, item]) => [key.trim().slice(0, 120), String(item).trim().slice(0, 240)]),
      )
    : {};
  return { typeId, page, filters };
}

function persistenceSearch(value: unknown): RendererPersistenceState["search"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const key = stringValue(value.key).trim();
  const page = numberValue(value.page, 0);
  return key && Number.isInteger(page) && page > 0 ? { key, page } : undefined;
}

function featureSourceId(runtime: TauriRuntimeState): string {
  const sourceId = requireSourceId(runtime);
  const siteKey = runtime.selectedSite?.key;
  if (!siteKey) throw new Error("TAURI_SITE_NOT_FOUND");
  return featureSourceIdFor(sourceId, siteKey);
}

function featureSourceIdFor(sourceId: string, siteKey: string): string {
  return `source:${stableDigest(`${sourceId}:${siteKey}`)}`;
}

function requireSourceId(runtime: TauriRuntimeState): string {
  if (!runtime.sourceId) throw new Error("TAURI_SOURCE_ID_UNAVAILABLE");
  return runtime.sourceId;
}

function stableSourceId(value: string, sessionId: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized === sessionId || /^https?:\/\//iu.test(normalized)) return null;
  return normalized;
}

function featureIdentifier(value: string, prefix: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^(?:https?|file|data|blob):/iu.test(normalized) || /[?#]/u.test(normalized)) {
    return `${prefix}:${stableDigest(normalized)}`;
  }
  return normalized.slice(0, 256);
}

function historyResumeCandidate(item: Record<string, unknown>, selection: HistorySelection): HistoryResumeCandidate {
  const position = Math.max(0, numberValue(item.position, 0));
  const completed = item.completed === true;
  return {
    identity: stringValue(item.identity),
    sourceId: stringValue(item.sourceId),
    vodId: stringValue(item.vodId),
    seasonId: typeof item.seasonId === "string" ? item.seasonId : null,
    episodeId: typeof item.episodeId === "string" ? item.episodeId : null,
    title: stringValue(item.title),
    poster: typeof item.poster === "string" ? item.poster : null,
    episode: typeof item.episode === "number" ? item.episode : null,
    episodeName: typeof item.episodeName === "string" ? item.episodeName : null,
    playbackLine: typeof item.playbackLine === "string" ? item.playbackLine : null,
    position,
    duration: Math.max(0, numberValue(item.duration, 0)),
    updatedAt: numberValue(item.updatedAt, 0),
    completed,
    sourceDisplayName: typeof item.sourceDisplayName === "string" ? item.sourceDisplayName : null,
    ...(item.sourceType === "local" ? { sourceType: "local" as const } : {}),
    lineIndex: selection.lineIndex,
    episodeIndex: selection.episodeIndex,
    lineName: selection.lineName,
    canResume: position > 0 || completed,
  };
}

function stableDigest(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function rendererHistoryCompleted(position: number, duration: number, ended = false): boolean {
  if (ended) return true;
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return false;
  const safePosition = Math.max(0, position);
  const safeDuration = Math.max(0, duration);
  if (safeDuration < 60 || safePosition <= 0) return false;
  return safePosition / safeDuration >= 0.9
    || (safeDuration >= 300 && safeDuration - safePosition <= 90);
}
