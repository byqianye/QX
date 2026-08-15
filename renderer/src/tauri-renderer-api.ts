import {
  ingestConfigCatalog,
  requestConfigCatalogMaintenance,
  requestBusinessData,
  requestBusinessFeature,
  requestComponentManager,
  requestCast,
  requestPush,
  requestDesktopService,
  requestEpg,
  requestLive,
  requestMpv,
  requestPlaybackFallback,
  requestPlaybackProxy,
  requestPlaybackSources,
  requestPlayerWindow,
  requestPlaybackStart,
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
  EpgSnapshot,
  LiveSnapshot,
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
import {
  createRendererState,
  type ApiSpiderState,
  type BrowseCategory,
  type BrowseFilter,
  type ImportState,
  type PlaybackCatalog,
  type PlaybackLine,
  type PlayerSource,
  type RendererEnvelope,
  type RendererPersistenceState,
  type RendererState,
} from "./state.js";
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
  liveProxySessionId: string | null;
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

const EMPTY_PERSISTENCE: RendererPersistenceState = {
  theme: "light",
  navigation: "home",
  siteKey: null,
  category: null,
  search: null,
  scrollTop: 0,
  recentDetailId: null,
};

export class TauriRendererApi {
  private runtime: TauriRuntimeState | null = null;

  public async getState(): Promise<RendererEnvelope> {
    if (!this.runtime) return {};
    return this.envelope();
  }

  public async post(path: string, body: Record<string, unknown> = {}): Promise<RendererEnvelope> {
    const action = this.actions()[path];
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

  private actions(): Record<string, TauriAction> {
    return {
      "/api/import/load": (body) => this.load(String(body.input ?? "")),
      "/api/import/load-file": (body) => this.load(String(body.input ?? ""), String(body.sourceName ?? "")),
      "/api/import/history": () => this.configHistory(),
      "/api/import/activate": (body) => this.activateConfig(String(body.versionHash ?? "")),
      "/api/import/select": (body) => this.select(String(body.siteKey ?? "")),
      "/api/import/confirm": () => this.confirm(),
      "/api/import/cancel": () => this.cancel(),
      "/api/open": () => this.openAndHome(),
      "/api/home": () => this.home(),
      "/api/category": (body) => this.callBrowse("category", body),
      "/api/search": (body) => this.callBrowse("search", body),
      "/api/detail": (body) => this.detail(String(body.vodId ?? "")),
      "/api/detail/close": () => this.closeDetail(),
      "/api/playback-sources/search": () => this.searchPlaybackSources(),
      "/api/playback-sources/select": (body) => this.selectPlaybackSource(body),
      "/api/switch": () => this.switchSource(),
      "/api/close": () => this.closeSource(),
      "/api/player": (body) => this.play(body),
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
      "/api/live/source/preview": (body) => this.liveAction("preview", "", body),
      "/api/live/source/apply": (body) => this.liveAction("apply", String(body.previewId ?? ""), body),
      "/api/live/source/refresh": (body) => this.liveAction("refresh", String(body.sourceId ?? ""), body),
      "/api/live/source/toggle": (body) => this.liveAction("toggle", "", body),
      "/api/live/source/remove": (body) => this.liveAction("remove", String(body.sourceId ?? ""), body),
      "/api/live/preview/clear": (body) => this.liveAction("clear-preview", "", body),
      "/api/live/play": (body) => this.livePlay(body),
      "/api/live/line": (body) => this.liveLine(body),
      "/api/live/stop": () => this.liveStop(),
      "/api/live/sync": (body) => this.liveAction("sync", "", body),
      "/api/live/failover/mode": (body) => this.liveAction("failover-mode", "", body),
      "/api/live/failover/approve": () => this.liveAction("failover-approve", "", {}),
      "/api/live/failover/cancel": () => this.liveAction("failover-cancel", "", {}),
      "/api/live/failover/stay": () => this.liveAction("failover-stay", "", {}),
      "/api/live/failover/return": () => this.liveAction("failover-return", "", {}),
      "/api/live/smart/create": (body) => this.liveAction("smart-create", "", body),
      "/api/live/smart/update": (body) => this.liveAction("smart-update", String(body.smartChannelId ?? ""), body),
      "/api/live/smart/delete": (body) => this.liveAction("smart-delete", String(body.smartChannelId ?? ""), body),
      "/api/live/smart/member/add": (body) => this.liveAction("smart-member-add", "", body),
      "/api/live/smart/member/remove": (body) => this.liveAction("smart-member-remove", "", body),
      "/api/live/smart/member/update": (body) => this.liveAction("smart-member-update", "", body),
      "/api/live/smart/member/priority": (body) => this.liveAction("smart-member-priority", "", body),
      "/api/live/smart/member/enable": (body) => this.liveAction("smart-member-enable", "", body),
      "/api/live/smart/member/reorder": (body) => this.liveAction("smart-member-reorder", "", body),
      "/api/live/smart/select": (body) => this.liveAction("smart-select", "", body),
      "/api/live/smart/play": (body) => this.smartPlay(body),
      "/api/live/smart/epg": (body) => this.liveAction("smart-epg", "", body),
      "/api/live/smart/member/health": (body) => this.liveAction("smart-member-health", "", body),
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
      "/api/epg/source/preview": (body) => this.epgAction("preview", "", body),
      "/api/epg/source/apply": (body) => this.epgAction("apply", String(body.previewId ?? ""), body),
      "/api/epg/source/refresh": (body) => this.epgAction("refresh", String(body.sourceId ?? ""), body),
      "/api/epg/source/toggle": (body) => this.epgAction("toggle", "", body),
      "/api/epg/source/remove": (body) => this.epgAction("remove", String(body.sourceId ?? ""), body),
      "/api/epg/preview/clear": (body) => this.epgAction("clear-preview", "", body),
      "/api/epg/mapping/set": (body) => this.epgAction("mapping-set", "", body),
      "/api/epg/mapping/confirm": (body) => this.epgAction("mapping-confirm", "", body),
      "/api/epg/mapping/clear": (body) => this.epgAction("mapping-clear", "", body),
      "/api/epg/mapping/confirm-high": () => this.epgAction("mapping-confirm-high", "", {}),
      "/api/epg/alias/set": (body) => this.epgAction("alias-set", "", body),
      "/api/epg/alias/remove": (body) => this.epgAction("alias-remove", "", body),
      "/api/epg/timeline": (body) => this.epgAction("timeline", "", body),
      "/api/epg/timeline/clear": () => this.epgAction("timeline-clear", "", {}),
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

  private async load(input: string, sourceName = ""): Promise<RendererEnvelope> {
    const value = input.trim();
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
    const snapshot = await ingestConfigCatalog(payload);
    if (!Array.isArray(snapshot.sites)) {
      const keys = isRecord(snapshot) ? Object.keys(snapshot).sort().join(",") : typeof snapshot;
      throw new Error(`TAURI_CONFIG_SNAPSHOT_INVALID:sites:${keys}`);
    }
    const inputKind: ImportState["inputKind"] = isFile ? "file" : isUrl ? "url" : "json";
    const sourceKind: ImportState["sourceKind"] = isFile ? "local" : isUrl ? "remote" : "inline";
    const sites = snapshot.sites.map(toSite);
    const importState = importStateFor(snapshot, inputKind, sourceKind, sites);
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
      liveProxySessionId: null,
      playerDetached: false,
      componentManager: null,
      fallbackSessionId: null,
      fallbackResolution: null,
      playbackFallbackRequests: new Map(),
    };
    await this.restorePersistence();
    await this.restoreBusinessFeatures();
    return this.envelope();
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
    await this.closeLiveProxy();
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
    runtime.liveProxySessionId = null;
    runtime.playerDetached = false;
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    runtime.fallbackSessionId = null;
    runtime.fallbackResolution = null;
    runtime.playbackFallbackRequests.clear();
    const history = await requestConfigCatalogMaintenance({ action: "history", source: runtime.source });
    return { ...this.envelope(), configHistory: history };
  }

  private async select(siteKey: string): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const selected = runtime.import.sites.find((site) => site.key === siteKey);
    const selectedSite = selected ? toSite(selected) : null;
    if (!selectedSite) throw new Error("TAURI_SITE_NOT_FOUND");
    const shouldOpen = runtime.sessionReady && runtime.import.trusted;
    const snapshot = shouldOpen ? this.sourceSwitchSnapshot() : null;
    try {
      const changed = await this.changeSite(selectedSite);
      if (!shouldOpen) return this.envelope();
      if (changed) await this.openSession();
      return this.home();
    } catch (error) {
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

  private async confirm(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.selectedSite) throw new Error("TAURI_SITE_NOT_FOUND");
    await this.openSession();
    runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: true };
    try {
      return await this.home();
    } catch (error) {
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
    await this.closeLiveProxy();
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
    await this.closeLiveProxy();
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

  private async openAndHome(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.sessionReady) await this.openSession();
    return this.home();
  }

  private async openSession(): Promise<void> {
    const runtime = this.requireRuntime();
    const site = runtime.selectedSite;
    if (!site) throw new Error("TAURI_SITE_NOT_FOUND");
    if (runtime.quickJs && !isQuickJsSite(site.api)) await this.closeQuickJs();
    if (isQuickJsSite(site.api)) {
      await this.openQuickJsSession(site);
      return;
    }
    const open = await this.sourceRequest({
      action: "open",
      sessionId: runtime.sessionId,
      ...(runtime.sourceId ? { sourceId: runtime.sourceId } : {}),
      siteKey: site.key,
      api: site.api,
      siteType: site.siteType,
      ...(site.ext === undefined ? {} : { ext: site.ext }),
    });
    if (open.session.availabilityReason) throw new Error(open.session.availabilityReason);
    runtime.sourceId = stableSourceId(open.session.sourceId, runtime.sessionId);
    runtime.capabilities = { ...open.session.capabilities };
    if (site.api.toLowerCase() === "csp_jianpian") {
      await this.sourceRequest({
        action: "call",
        sessionId: runtime.sessionId,
        method: "init",
        params: {},
      });
    }
    runtime.sessionReady = true;
    runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: true };
  }

  private async openQuickJsSession(site: TauriSite): Promise<void> {
    const runtime = this.requireRuntime();
    const open = await requestQuickJsSession({
      action: "open",
      sessionId: runtime.sessionId,
      ...(runtime.sourceId === null ? {} : { sourceId: runtime.sourceId }),
      siteKey: site.key,
      api: site.api,
      siteType: site.siteType,
      ...(site.ext === undefined ? {} : { ext: site.ext }),
    });
    runtime.quickJs = true;
    runtime.sourceId = stableSourceId(open.session.sourceId, runtime.sessionId);
    runtime.quickJsMethods = { ...open.methods };
    runtime.capabilities = { ...open.session.capabilities };
    runtime.sessionReady = true;
    runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: true };
  }

  private async home(): Promise<RendererEnvelope> {
    return this.callBrowse("home", {});
  }

  private async callBrowse(method: "home" | "category" | "search", body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.sessionReady) await this.openSession();
    const result = await this.sourceRequest({
      action: "call",
      sessionId: runtime.sessionId,
      method,
      params: body,
    });
    runtime.page = method === "home" ? "home" : method;
    runtime.items = listItems(result.result);
    const metadata = browseMetadata(result.result);
    if (metadata.categories.length > 0 || method === "home") runtime.categories = metadata.categories;
    if (metadata.filters.length > 0 || method === "home") runtime.filters = metadata.filters;
    return this.envelope();
  }

  private async detail(vodId: string, preserveFallback = false): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!vodId) throw new Error("TAURI_DETAIL_ID_REQUIRED");
    if (!runtime.sessionReady) await this.openSession();
    const result = await this.sourceRequest({
      action: "call",
      sessionId: runtime.sessionId,
      method: "detail",
      params: { ids: [vodId] },
    });
    const value = listItems(result.result)[0] ?? record(result.result);
    runtime.page = "detail";
    if (!preserveFallback) {
      runtime.playbackFallbackRequests.clear();
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      this.clearFallbackState();
    }
    runtime.detail = value;
    runtime.playbackCatalog = playbackCatalog(value);
    runtime.playbackSelection = runtime.playbackCatalog?.lines[0]?.episodes[0]
      ? { lineIndex: runtime.playbackCatalog.lines[0].index, episodeIndex: 0 }
      : null;
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
    runtime.fallbackResolution = resolution;
    if (!preserveFallback) await this.beginFallback(resolution, candidate);
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    return this.envelope();
  }

  private async changeSite(site: TauriSite, preserveFallback = false): Promise<boolean> {
    const runtime = this.requireRuntime();
    if (runtime.selectedSite?.key === site.key) return false;

    if (runtime.playerSource) await this.stopPlayer(preserveFallback);
    else if (!preserveFallback) {
      runtime.fallbackSessionId = null;
      runtime.fallbackResolution = null;
      runtime.playbackFallbackRequests.clear();
      this.clearFallbackState();
    }
    await this.closeSourceSession();
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

  private async play(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const lineIndex = numberValue(body.lineIndex, runtime.playbackSelection?.lineIndex ?? 0);
    const episodeIndex = numberValue(body.episodeIndex, runtime.playbackSelection?.episodeIndex ?? 0);
    const line = runtime.playbackCatalog?.lines.find((candidate) => candidate.index === lineIndex);
    const episode = line?.episodes[episodeIndex];
    if (!line || !episode) throw new Error("TAURI_PLAYBACK_EPISODE_NOT_FOUND");
    if (!runtime.fallbackSessionId) await this.beginPlaybackFallback(lineIndex, episodeIndex);
    const playback = await requestPlaybackStart({
      sessionId: runtime.sessionId,
      ...(runtime.sourceId ? { sourceId: runtime.sourceId } : {}),
      sourceApi: runtime.selectedSite?.api ?? "",
      ...(runtime.selectedSite?.siteType === undefined ? {} : { siteType: runtime.selectedSite.siteType }),
      ...(runtime.quickJs ? { engine: "quickjs" as const } : {}),
      lineName: line.name,
      episodeId: episode.id,
      vipFlags: [],
      fallbackSubtitles: runtime.detail?.subtitles ?? runtime.detail?.subtitleTracks,
    });
    runtime.proxySessionId = runtime.sessionId;
    runtime.playbackSelection = { lineIndex, episodeIndex };
    runtime.playerSource = {
      ...(playback.playerSource as unknown as PlayerSource),
    };
    return this.envelope();
  }

  private async stopPlayer(preserveFallback = false): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    try {
      if (runtime.playerSource?.backend === "mpv") {
        await requestMpv({ action: "close", sessionId: runtime.sessionId });
      }
    } finally {
      if (runtime.proxySessionId) {
        await requestPlaybackProxy({ action: "close", sessionId: runtime.proxySessionId });
      }
      runtime.proxySessionId = null;
      runtime.playerSource = null;
      runtime.playerDetached = false;
      if (!preserveFallback) {
        if (runtime.fallbackSessionId) {
          await requestPlaybackFallback({ action: "clear", sessionId: runtime.fallbackSessionId }).catch(() => undefined);
        }
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
    await requestPlayerWindow({
      action: "open",
      value: {
        player: current?.player ?? null,
        session: current?.playbackSession ?? null,
      },
    });
    runtime.playerDetached = true;
    return this.envelope();
  }

  private async attachPlayerWindow(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    await requestPlayerWindow({ action: "attach", value: {} });
    runtime.playerDetached = false;
    return this.envelope();
  }

  private async syncPlayer(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const playbackError = body.status === "error";
    if (playbackError && !runtime.fallbackSessionId && runtime.playbackSelection) {
      await this.beginPlaybackFallback(runtime.playbackSelection.lineIndex, runtime.playbackSelection.episodeIndex);
    }
    try {
      await this.desktopAction("player-sync", body);
      await this.desktopAction("danmaku-sync", body);
    } catch (error) {
      if (!runtime.fallbackSessionId) throw error;
    }
    if (runtime.playerSource) {
      runtime.playerSource = { ...runtime.playerSource };
      if (runtime.detail && runtime.playbackCatalog && runtime.playbackSelection) {
        const line = runtime.playbackCatalog.lines.find((candidate) => candidate.index === runtime.playbackSelection?.lineIndex);
        const episode = line?.episodes[runtime.playbackSelection.episodeIndex];
        const rawVodId = stringValue(runtime.detail.vod_id ?? runtime.detail.id);
        const sourceId = runtime.sourceId ? featureSourceId(runtime) : null;
        const vodId = featureIdentifier(rawVodId, "vod");
        const episodeId = episode ? featureIdentifier(episode.id, `episode:${episode.index}`) : null;
        if (line && episode && sourceId && vodId && episodeId) {
          const identity = `${sourceId}:${vodId}:${episodeId}`;
          await this.featureAction("history", "upsert", identity, {
            identity,
            sourceId,
            vodId,
            seasonId: null,
            episodeId,
            title: stringValue(runtime.detail.vod_name ?? runtime.detail.title) || vodId,
            poster: stringValue(runtime.detail.vod_pic ?? runtime.detail.poster) || null,
            episode: episode.index,
            episodeName: episode.name,
            playbackLine: line.name,
            position: numberValue(body.currentTime, 0),
            duration: numberValue(body.duration, 0),
            updatedAt: Date.now(),
            completed: body.status === "ended" || body.completed === true,
            sourceDisplayName: runtime.selectedSite?.name ?? null,
            sourceType: "remote",
          });
        }
      }
    }
    const fallbackState = runtime.featureState.fallback;
    if (body.status === "playing" && runtime.fallbackSessionId && fallbackState?.status === "trying") {
      await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: true });
    } else if (body.status === "error") {
      await this.handlePlaybackFailure(body);
    }
    return this.envelope();
  }

  private async setFallbackMode(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const mode = stringValue(body.mode);
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
    runtime.fallbackSessionId = runtime.sessionId;
    await this.fallbackAction({
      action: "begin",
      sessionId: runtime.fallbackSessionId,
      candidates,
      mode: "prompt",
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    });
  }

  private async handlePlaybackFailure(body: Record<string, unknown>): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime.fallbackSessionId) return;
    if (runtime.featureState.fallback?.status === "trying") {
      await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: false });
    }
    const snapshot = await this.fallbackAction({
      action: "trigger",
      sessionId: runtime.fallbackSessionId,
      trigger: "player-fatal",
      reason: stringValue(body.error ?? body.reason ?? body.event) || "player playback failed",
    });
    if (snapshot.decision.kind === "attempt" && snapshot.decision.candidate) {
      if (runtime.fallbackResolution) await this.attemptFallback(snapshot.decision.candidate);
      else await this.attemptPlaybackFallback(snapshot.decision.candidate);
    }
  }

  private async beginPlaybackFallback(lineIndex: number, episodeIndex: number): Promise<void> {
    const runtime = this.requireRuntime();
    const requests = new Map<string, { lineIndex: number; episodeIndex: number }>();
    const candidates: PlaybackFallbackCandidate[] = [];
    for (const line of runtime.playbackCatalog?.lines ?? []) {
      for (const episode of line.episodes) {
        if (line.index === lineIndex && episode.index === episodeIndex) continue;
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
    }
    runtime.playbackFallbackRequests = requests;
    runtime.fallbackSessionId = runtime.sessionId;
    await this.fallbackAction({
      action: "begin",
      sessionId: runtime.fallbackSessionId,
      candidates,
      mode: "prompt",
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    });
  }

  private async attemptPlaybackFallback(candidate: PlaybackFallbackCandidate): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const request = runtime.playbackFallbackRequests.get(candidate.id);
    if (!request) {
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "stop", sessionId: runtime.fallbackSessionId, reason: "fallback candidate is unavailable" });
      }
      return this.envelope();
    }
    try {
      await this.stopPlayer(true);
      await this.play(request);
      return this.envelope();
    } catch (error) {
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: false });
      }
      throw error;
    }
  }

  private async attemptFallback(candidate: PlaybackFallbackCandidate): Promise<RendererEnvelope> {
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
    try {
      await this.stopPlayer(true);
      await this.selectPlaybackSource({
        siteKey: selected.siteKey,
        vodId: String(selected.vod.vod_id ?? selected.vod.id ?? ""),
        preserveFallback: true,
      });
      await this.play({ lineIndex: 0, episodeIndex: 0 });
      return this.envelope();
    } catch (error) {
      if (runtime.fallbackSessionId) {
        await this.fallbackAction({ action: "finish", sessionId: runtime.fallbackSessionId, success: false });
      }
      throw error;
    }
  }

  private async fallbackAction(
    payload: Omit<PlaybackFallbackPayload, "sessionId"> & { sessionId: string },
  ): Promise<PlaybackFallbackSnapshot> {
    const snapshot = await requestPlaybackFallback(payload);
    this.setFallbackState(snapshot.state);
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
    runtime.persistence = {
      ...runtime.persistence,
      ...(body.theme === "system" || body.theme === "light" || body.theme === "dark" ? { theme: body.theme } : {}),
      ...(isRendererNavigation(body.navigation) ? { navigation: body.navigation } : {}),
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
    runtime.persistence = {
      ...runtime.persistence,
      ...(value.theme === "system" || value.theme === "light" || value.theme === "dark" ? { theme: value.theme } : {}),
      ...(isRendererNavigation(value.navigation) ? { navigation: value.navigation } : {}),
      ...(typeof value.siteKey === "string" ? { siteKey: value.siteKey } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(search !== undefined ? { search } : {}),
      ...(typeof value.scrollTop === "number" ? { scrollTop: Math.max(0, value.scrollTop) } : {}),
      ...(typeof value.recentDetailId === "string" ? { recentDetailId: value.recentDetailId } : {}),
    };
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
    this.applyLiveSnapshot(await requestLive({ action: "snapshot", value: {} }));
    this.applyEpgSnapshot(await requestEpg({ action: "snapshot", value: {} }));
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
    const snapshot = await requestBusinessFeature({
      action,
      feature,
      ...(id ? { id } : {}),
      value,
    });
    this.applyFeatureSnapshot(snapshot);
    return this.envelope();
  }

  private applyFeatureSnapshot(snapshot: BusinessFeatureSnapshot): void {
    const runtime = this.requireRuntime();
    runtime.featureState = {
      ...runtime.featureState,
      ...(snapshot.state as Partial<ApiSpiderState>),
    };
  }

  private applyLiveSnapshot(snapshot: LiveSnapshot): void {
    const runtime = this.requireRuntime();
    const nextLive = snapshot.state.live;
    const currentLive = runtime.featureState.live;
    runtime.featureState = {
      ...runtime.featureState,
      ...(isRecord(nextLive)
        ? {
            live: {
              ...nextLive,
              ...(isRecord(currentLive) && isRecord(currentLive.epg) && !isRecord(nextLive.epg)
                ? { epg: currentLive.epg }
                : isRecord(currentLive) && isRecord(currentLive.epg) && isRecord(nextLive.epg) && Array.isArray(nextLive.epg.sources) && nextLive.epg.sources.length === 0 && Array.isArray(currentLive.epg.sources) && currentLive.epg.sources.length > 0
                  ? { epg: currentLive.epg }
                  : {}),
            } as unknown as NonNullable<ApiSpiderState["live"]>,
          }
        : {}),
    };
  }

  private applyEpgSnapshot(snapshot: EpgSnapshot): void {
    const runtime = this.requireRuntime();
    const live = runtime.featureState.live;
    runtime.featureState = {
      ...runtime.featureState,
      ...(isRecord(live) && isRecord(snapshot.state.epg)
        ? { live: { ...live, epg: snapshot.state.epg } as unknown as NonNullable<ApiSpiderState["live"]> }
        : {}),
    };
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

  private async liveAction(action: string, id: string, value: Record<string, unknown>): Promise<RendererEnvelope> {
    const snapshot = await requestLive({
      action,
      ...(id ? { id } : {}),
      value,
    });
    this.applyLiveSnapshot(snapshot);
    return this.envelope();
  }

  private async epgAction(action: string, id: string, value: Record<string, unknown>): Promise<RendererEnvelope> {
    const snapshot = await requestEpg({
      action,
      ...(id ? { id } : {}),
      value,
    });
    this.applyEpgSnapshot(snapshot);
    return this.envelope();
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

  private async desktopAction(action: string, value: Record<string, unknown>): Promise<RendererEnvelope> {
    const snapshot = await requestDesktopService({ action, value });
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

  private async livePlay(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const snapshot = await requestLive({ action: "play", value: body });
    this.applyLiveSnapshot(snapshot);
    return this.ensureLiveProxy();
  }

  private async smartPlay(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const snapshot = await requestLive({ action: "smart-play", value: body });
    this.applyLiveSnapshot(snapshot);
    return this.ensureLiveProxy();
  }

  private async liveLine(body: Record<string, unknown>): Promise<RendererEnvelope> {
    await this.closeLiveProxy();
    const snapshot = await requestLive({ action: "line", value: body });
    this.applyLiveSnapshot(snapshot);
    return this.ensureLiveProxy();
  }

  private async liveStop(): Promise<RendererEnvelope> {
    await this.closeLiveProxy();
    const snapshot = await requestLive({ action: "stop", value: {} });
    this.applyLiveSnapshot(snapshot);
    return this.envelope();
  }

  private async ensureLiveProxy(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const live = runtime.featureState.live;
    const player = isRecord(live) ? record(live.player) : {};
    const source = record(player.source);
    const url = stringValue(source.url);
    if (!/^https?:\/\//iu.test(url)) throw new Error("TAURI_LIVE_PLAYBACK_URL_INVALID");
    const proxy = await requestPlaybackProxy({
      action: "start",
      sessionId: `${runtime.sessionId}:live`,
      url,
      headers: headersValue(source.headers),
    });
    if (!proxy.proxyUrl) throw new Error("TAURI_LIVE_PROXY_URL_MISSING");
    runtime.liveProxySessionId = `${runtime.sessionId}:live`;
    if (isRecord(live)) {
      const nextLive = { ...live };
      (nextLive as Record<string, unknown>).player = {
        ...player,
        source: { parse: 0, ...source, url: proxy.proxyUrl, headers: {} },
      };
      runtime.featureState = {
        ...runtime.featureState,
        live: nextLive as NonNullable<ApiSpiderState["live"]>,
      };
    }
    return this.envelope();
  }

  private async closeLiveProxy(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime.liveProxySessionId) return;
    try {
      await requestPlaybackProxy({ action: "close", sessionId: runtime.liveProxySessionId });
    } finally {
      runtime.liveProxySessionId = null;
    }
  }

  private async openHistory(identity: string): Promise<RendererEnvelope> {
    const item = this.featureItems("history").find((candidate) => stringValue(candidate.identity) === identity);
    if (!item) throw new Error("TAURI_HISTORY_NOT_FOUND");
    const runtime = this.requireRuntime();
    if (stringValue(item.sourceId) !== featureSourceId(runtime)) throw new Error("TAURI_HISTORY_SOURCE_SWITCH_REQUIRED");
    return this.detail(stringValue(item.vodId));
  }

  private async toggleFavoriteDetail(): Promise<RendererEnvelope> {
    const content = this.currentContent();
    const snapshot = await requestBusinessFeature({
      action: "toggle",
      feature: "favorites",
      value: content,
    });
    this.applyFeatureSnapshot(snapshot);
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
    if (stringValue(item.sourceId) !== featureSourceId(runtime)) throw new Error("TAURI_FAVORITE_SOURCE_SWITCH_REQUIRED");
    return this.detail(stringValue(item.vodId));
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
    if (favoriteToo) return this.toggleFavoriteDetail();
    return this.envelope();
  }

  private async openFollow(identity: string): Promise<RendererEnvelope> {
    const item = this.featureItems("follow").find((candidate) => stringValue(candidate.identity) === identity);
    if (!item) throw new Error("TAURI_FOLLOW_NOT_FOUND");
    const runtime = this.requireRuntime();
    if (stringValue(item.sourceId) !== featureSourceId(runtime)) throw new Error("TAURI_FOLLOW_SOURCE_SWITCH_REQUIRED");
    return this.detail(stringValue(item.vodId));
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
      const episodes = playbackCatalog(detail)?.lines.flatMap((line) => line.episodes.map((episode) => ({
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

  private async sourceRequest(payload: SourceSessionPayload): Promise<SourceSessionResult> {
    const runtime = this.requireRuntime();
    if (runtime.quickJs) return this.quickJsRequest(payload);
    return requestSourceSession(payload);
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
              ...base.playback.player,
              status: "loading",
              source: runtime.playerSource,
            }
          : base.playback.player,
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
              id: runtime.sessionId,
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
        componentManager: runtime.componentManager,
      },
    };
  }

  private requireRuntime(): TauriRuntimeState {
    if (!this.runtime) throw new Error("TAURI_RENDERER_IMPORT_REQUIRED");
    return this.runtime;
  }
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
    liveCount: 0,
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
    selectedSiteKey: sites[0]?.key ?? null,
    selectedApi: sites[0]?.api ?? null,
    sessionReady: false,
  };
}

function inputKindForCatalogKind(sourceKind: ConfigCatalogSnapshot["sourceKind"]): Exclude<ImportState["inputKind"], null> {
  return sourceKind === "url" ? "url" : sourceKind === "file" ? "file" : "json";
}

function importSourceKindForCatalogKind(sourceKind: ConfigCatalogSnapshot["sourceKind"]): Exclude<ImportState["sourceKind"], null> {
  return sourceKind === "url" ? "remote" : sourceKind === "file" ? "local" : "inline";
}

function listItems(value: unknown): Record<string, unknown>[] {
  const object = record(value);
  const list = Array.isArray(object.list) ? object.list : Array.isArray(object.items) ? object.items : [];
  return list.filter(isRecord).map((item) => ({ ...item }));
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

function playbackCatalog(value: Record<string, unknown>): PlaybackCatalog | null {
  const from = stringValue(value.vod_play_from);
  const urls = stringValue(value.vod_play_url);
  if (!from || !urls) return null;
  const fromLines = from.split("$$$");
  const urlLines = urls.split("$$$");
  const lines: PlaybackLine[] = [];
  for (let index = 0; index < urlLines.length; index += 1) {
    const episodes = urlLines[index]?.split("#").flatMap((entry, episodeIndex) => {
      const dollar = entry.indexOf("$");
      const label = dollar >= 0 ? entry.slice(0, dollar) : String(episodeIndex + 1);
      const id = dollar >= 0 ? entry.slice(dollar + 1).split("|")[0] : entry.split("|")[0];
      if (!id) return [];
      return [{ index: episodeIndex, name: label || String(episodeIndex + 1), id }];
    }) ?? [];
    if (episodes.length > 0) {
      lines.push({
        index,
        name: fromLines[index] || `线路 ${index + 1}`,
        protocol: episodes.some((episode) => /\.m3u8(?:$|[?#])/iu.test(episode.id)) ? "HLS" : "MP4",
        episodes,
      });
    }
  }
  return lines.length > 0 ? { lines } : null;
}

function headersValue(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function candidateCandidateId(candidate: PlayableCandidate): string {
  const vodId = String(candidate.vod.vod_id ?? candidate.vod.id ?? "").trim();
  return `${candidate.siteKey}:${vodId}`;
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
    || value === "live"
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

function stableDigest(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
