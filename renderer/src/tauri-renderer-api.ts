import {
  ingestConfigCatalog,
  requestBusinessData,
  requestBusinessFeature,
  requestComponentManager,
  requestDesktopService,
  requestEpg,
  requestLive,
  requestMpv,
  requestPlaybackProxy,
  requestPlaybackSources,
  requestPlayerWindow,
  requestQuickJsSidecar,
  requestRuntimeCapability,
  requestSourceSession,
  requestWebviewSniffer,
} from "./tauri-rpc.js";
import type {
  ConfigCatalogPayload,
  ConfigCatalogSnapshot,
  ConfigSiteSummary,
  BusinessFeaturePayload,
  BusinessFeatureSnapshot,
  ComponentManagerAction,
  ComponentManagerSnapshot,
  EpgSnapshot,
  LiveSnapshot,
  PlaybackProxyPayload,
  PlaybackSourceResolvePayload,
  WebviewSnifferPayload,
  SourceCapabilities,
  SourceSessionPayload,
  SourceSessionResult,
} from "./contracts.js";
import {
  PlaybackFallbackCoordinator,
  type FallbackCandidate,
  type PlaybackFallbackState,
} from "../../src/health/playback-health.js";
import type {
  PlayableCandidate,
  PlaybackSourceResolution,
} from "../../src/desktop/playback-source-resolver.js";
import {
  createRendererState,
  type ApiSpiderState,
  type ImportState,
  type PlaybackCatalog,
  type PlaybackLine,
  type PlayerSource,
  type RendererEnvelope,
  type RendererPersistenceState,
  type RendererState,
} from "./state.js";
import { normalizeSubtitleTracks } from "../../src/subtitles.js";
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
  selectedSite: TauriSite | null;
  sessionId: string;
  sessionReady: boolean;
  quickJs: boolean;
  quickJsMethods: Record<string, boolean>;
  page: ApiSpiderState["page"];
  items: Record<string, unknown>[];
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
  fallbackCoordinator: PlaybackFallbackCoordinator | null;
  fallbackResolution: PlaybackSourceResolution | null;
  playbackFallbackRequests: Map<string, { lineIndex: number; episodeIndex: number }>;
}

const EMPTY_PERSISTENCE: RendererPersistenceState = {
  theme: "system",
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

  private async load(input: string): Promise<RendererEnvelope> {
    const value = input.trim();
    if (!value) throw new Error("TAURI_CONFIG_INPUT_EMPTY");
    const isUrl = /^https?:\/\//iu.test(value);
    const isInline = value.startsWith("{") || value.startsWith("[") || /^tvbox:|^2423|\*\*/iu.test(value);
    if (!isUrl && !isInline) {
      throw new Error("TAURI_CONFIG_FILE_IMPORT_UNSUPPORTED");
    }
    const payload: ConfigCatalogPayload = isUrl
      ? { source: value, sourceKind: "url", raw: "", fetchRemote: true }
      : { source: "inline:tauri", sourceKind: "json", raw: value };
    const snapshot = await ingestConfigCatalog(payload);
    if (!Array.isArray(snapshot.sites)) {
      const keys = isRecord(snapshot) ? Object.keys(snapshot).sort().join(",") : typeof snapshot;
      throw new Error(`TAURI_CONFIG_SNAPSHOT_INVALID:sites:${keys}`);
    }
    const sites = snapshot.sites.map(toSite);
    const sourceKind: ImportState["sourceKind"] = isUrl ? "remote" : "inline";
    const importState: ImportState = {
      status: "confirmation_required",
      loading: false,
      inputKind: isUrl ? "url" : "json",
      source: snapshot.source,
      sourceKind,
      warning: snapshot.warningCode ?? null,
      error: null,
      trusted: false,
      summary: summaryFor(snapshot, sites),
      sites: sites.map((site) => ({ key: site.key, name: site.name, api: site.api })),
      selectedSiteKey: sites[0]?.key ?? null,
      selectedApi: sites[0]?.api ?? null,
      sessionReady: false,
    };
    this.runtime = {
      import: importState,
      source: snapshot.source,
      selectedSite: sites[0] ?? null,
      sessionId: crypto.randomUUID(),
      sessionReady: false,
      quickJs: false,
      quickJsMethods: {},
      page: "import",
      items: [],
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
      fallbackCoordinator: null,
      fallbackResolution: null,
      playbackFallbackRequests: new Map(),
    };
    await this.restorePersistence();
    await this.restoreBusinessFeatures();
    return this.envelope();
  }

  private async select(siteKey: string): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const selected = runtime.import.sites.find((site) => site.key === siteKey);
    const selectedSite = selected ? toSite(selected) : null;
    if (!selectedSite) throw new Error("TAURI_SITE_NOT_FOUND");
    runtime.selectedSite = selectedSite;
    runtime.import = {
      ...runtime.import,
      selectedSiteKey: selectedSite.key,
      selectedApi: selectedSite.api,
    };
    if (!runtime.sessionReady || !runtime.import.trusted) return this.envelope();
    await this.openSession();
    return this.home();
  }

  private async confirm(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (!runtime.selectedSite) throw new Error("TAURI_SITE_NOT_FOUND");
    await this.openSession();
    runtime.import = { ...runtime.import, status: "ready", trusted: true, sessionReady: true };
    return this.home();
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
    runtime.selectedSite = next;
    runtime.import = {
      ...runtime.import,
      selectedSiteKey: next.key,
      selectedApi: next.api,
    };
    await this.closeSourceSession();
    await this.openSession();
    runtime.page = "home";
    runtime.items = [];
    runtime.detail = null;
    runtime.playbackCatalog = null;
    runtime.playbackSelection = null;
    runtime.playbackFallbackRequests.clear();
    runtime.fallbackCoordinator = null;
    runtime.fallbackResolution = null;
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    return this.home();
  }

  private async closeSource(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    if (runtime.playerSource) await this.stopPlayer();
    else {
      runtime.fallbackCoordinator = null;
      runtime.fallbackResolution = null;
      this.clearFallbackState();
    }
    await this.closeSourceSession();
    await this.closeLiveProxy();
    runtime.items = [];
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
      sourceId: runtime.source,
      siteKey: site.key,
      api: site.api,
      siteType: site.siteType,
      ...(site.ext === undefined ? {} : { ext: site.ext }),
    });
    if (open.session.availabilityReason) throw new Error(open.session.availabilityReason);
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
    const script = quickJsScript(site);
    const allowedOrigins = quickJsAllowedOrigins(script, site.ext);
    const scriptBytes = /^https?:\/\//iu.test(script)
      ? undefined
      : new TextEncoder().encode(script).byteLength;
    const capability = await requestRuntimeCapability({
      api: site.api,
      ...(site.ext === undefined ? {} : { ext: site.ext }),
      ...(scriptBytes === undefined ? {} : { scriptBytes }),
      allowedOrigins,
    });
    if (!capability.supported) throw new Error(capability.reasonCode);
    await requestQuickJsSidecar({
      action: "load",
      sessionId: runtime.sessionId,
      script,
      allowedOrigins,
    });
    const methods = record(await requestQuickJsSidecar({
      action: "capabilities",
      sessionId: runtime.sessionId,
    }));
    runtime.quickJs = true;
    runtime.quickJsMethods = Object.fromEntries(
      Object.entries(methods).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
    if (runtime.quickJsMethods.init) {
      await requestQuickJsSidecar({
        action: "call",
        sessionId: runtime.sessionId,
        name: "init",
        args: [site.ext ?? ""],
      });
    }
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
      runtime.fallbackCoordinator = null;
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
      sourceId: runtime.source,
      sessionId: runtime.sessionId,
      sites: configuredSites,
    } satisfies PlaybackSourceResolvePayload);
    runtime.fallbackCoordinator = null;
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
      await this.closeSourceSession();
      runtime.selectedSite = site;
      runtime.import = { ...runtime.import, selectedSiteKey: site.key, selectedApi: site.api };
      await this.openSession();
    }
    await this.detail(vodId, preserveFallback);
    runtime.fallbackResolution = resolution;
    if (!preserveFallback) this.beginFallback(resolution, candidate);
    runtime.featureState = { ...runtime.featureState, playbackSources: null };
    return this.envelope();
  }

  private async play(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const lineIndex = numberValue(body.lineIndex, runtime.playbackSelection?.lineIndex ?? 0);
    const episodeIndex = numberValue(body.episodeIndex, runtime.playbackSelection?.episodeIndex ?? 0);
    const line = runtime.playbackCatalog?.lines.find((candidate) => candidate.index === lineIndex);
    const episode = line?.episodes[episodeIndex];
    if (!line || !episode) throw new Error("TAURI_PLAYBACK_EPISODE_NOT_FOUND");
    if (!runtime.fallbackCoordinator) this.beginPlaybackFallback(lineIndex, episodeIndex);
    const selectedApi = runtime.selectedSite?.api ?? "";
    const directCmsEpisode = /^https?:\/\//iu.test(selectedApi) && /^https?:\/\//iu.test(episode.id);
    const raw = directCmsEpisode
      ? { parse: 0, url: episode.id, header: {} }
      : record((await this.sourceRequest({
        action: "call",
        sessionId: runtime.sessionId,
        method: "player",
        params: { flag: line.name, id: episode.id, vipFlags: [] },
      })).result);
    const parse = numberValue(raw.parse, 0);
    const subtitles = normalizeSubtitleTracks(
      raw.subtitles
        ?? raw.subtitleTracks
        ?? raw.subtitle
        ?? runtime.detail?.subtitles
        ?? runtime.detail?.subtitleTracks,
    );
    let url = stringValue(raw.url ?? raw.playUrl ?? raw.link);
    let headers = headersValue(raw.header ?? raw.headers);
    if (parse !== 0) {
      const initialUrl = /^https?:\/\//iu.test(url) ? url : /^https?:\/\//iu.test(episode.id) ? episode.id : "";
      if (!initialUrl) throw new Error("TAURI_PLAYBACK_SNIFFER_URL_INVALID");
      const sniffPayload: WebviewSnifferPayload = {
        action: "sniff",
        sessionId: runtime.sessionId,
        sourceId: runtime.source,
        playbackSessionId: runtime.sessionId,
        initialUrl,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(Array.isArray(raw.allowedOrigins)
          ? {
              allowedOrigins: raw.allowedOrigins.filter(
                (origin): origin is string => typeof origin === "string",
              ),
            }
          : {}),
      };
      const sniffed = await requestWebviewSniffer(sniffPayload);
      const media = record(sniffed.media);
      url = stringValue(media.url);
      headers = headersValue(media.headers);
      if (!/^https?:\/\//iu.test(url)) throw new Error("TAURI_PLAYBACK_SNIFFER_MEDIA_INVALID");
    }
    if (!/^https?:\/\//iu.test(url)) throw new Error("TAURI_PLAYBACK_URL_INVALID");
    const proxy = await requestPlaybackProxy({
      action: "start",
      sessionId: runtime.sessionId,
      url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    } satisfies PlaybackProxyPayload);
    if (!proxy.proxyUrl) throw new Error("TAURI_PLAYBACK_PROXY_URL_MISSING");
    const backend = raw.backend === "mpv" || stringValue(raw.format).toLowerCase() === "flv" ? "mpv" : "embedded";
    if (backend === "mpv") {
      try {
        await requestMpv({ action: "start", sessionId: runtime.sessionId, source: proxy.proxyUrl });
      } catch (error) {
        await requestPlaybackProxy({ action: "close", sessionId: runtime.sessionId });
        throw error;
      }
    }
    runtime.proxySessionId = runtime.sessionId;
    runtime.playbackSelection = { lineIndex, episodeIndex };
    const drm = drmValue(raw.drm);
    runtime.playerSource = {
      parse,
      url: proxy.proxyUrl,
      headers: {},
      ...(backend === "mpv" ? { backend } : {}),
      mediaType: proxy.mediaType === "hls" ? "hls" : proxy.mediaType === "dash" ? "dash" : "mp4",
      ...(drm ? { drm } : {}),
      ...(typeof raw.playUrl === "string" ? { playUrl: raw.playUrl } : {}),
      ...(typeof raw.format === "string" ? { format: raw.format } : {}),
      ...(typeof raw.flag === "string" ? { flag: raw.flag } : {}),
      ...(subtitles.length > 0 ? { subtitles } : {}),
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
        runtime.fallbackCoordinator = null;
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
    if (playbackError && !runtime.fallbackCoordinator && runtime.playbackSelection) {
      this.beginPlaybackFallback(runtime.playbackSelection.lineIndex, runtime.playbackSelection.episodeIndex);
    }
    try {
      await this.desktopAction("player-sync", body);
    } catch (error) {
      if (!runtime.fallbackCoordinator) throw error;
    }
    if (runtime.playerSource) {
      runtime.playerSource = { ...runtime.playerSource };
      if (runtime.detail && runtime.playbackCatalog && runtime.playbackSelection) {
        const line = runtime.playbackCatalog.lines.find((candidate) => candidate.index === runtime.playbackSelection?.lineIndex);
        const episode = line?.episodes[runtime.playbackSelection.episodeIndex];
        const rawVodId = stringValue(runtime.detail.vod_id ?? runtime.detail.id);
        const sourceId = featureSourceId(runtime);
        const vodId = featureIdentifier(rawVodId, "vod");
        const episodeId = episode ? featureIdentifier(episode.id, `episode:${episode.index}`) : null;
        if (line && episode && vodId && episodeId) {
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
    if (body.status === "playing" && runtime.fallbackCoordinator?.state.status === "trying") {
      this.setFallbackState(runtime.fallbackCoordinator.finishAttempt(true));
    } else if (body.status === "error") {
      await this.handlePlaybackFailure(body);
    }
    return this.envelope();
  }

  private async setFallbackMode(body: Record<string, unknown>): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const mode = stringValue(body.mode);
    await this.desktopAction("player-fallback-mode", body);
    if (runtime.fallbackCoordinator && (mode === "off" || mode === "prompt" || mode === "auto")) {
      this.setFallbackState(runtime.fallbackCoordinator.setMode(mode));
    }
    return this.envelope();
  }

  private async approveFallback(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    await this.desktopAction("player-fallback-approve", {});
    const decision = runtime.fallbackCoordinator?.approveNext();
    if (!decision || decision.kind !== "attempt") {
      if (runtime.fallbackCoordinator) this.setFallbackState(runtime.fallbackCoordinator.state);
      return this.envelope();
    }
    return runtime.fallbackResolution
      ? this.attemptFallback(decision.candidate)
      : this.attemptPlaybackFallback(decision.candidate);
  }

  private async cancelFallback(): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    await this.desktopAction("player-fallback-cancel", {});
    if (runtime.fallbackCoordinator) this.setFallbackState(runtime.fallbackCoordinator.cancel());
    return this.envelope();
  }

  private beginFallback(resolution: PlaybackSourceResolution, selected: PlayableCandidate): void {
    const runtime = this.requireRuntime();
    const candidates = resolution.candidates
      .filter((candidate) => candidate.playable && candidateCandidateId(candidate) !== candidateCandidateId(selected))
      .map(fallbackCandidate);
    runtime.fallbackCoordinator = new PlaybackFallbackCoordinator({
      mode: "prompt",
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    });
    runtime.fallbackCoordinator.begin(candidates);
    this.setFallbackState(runtime.fallbackCoordinator.state);
  }

  private async handlePlaybackFailure(body: Record<string, unknown>): Promise<void> {
    const runtime = this.requireRuntime();
    const coordinator = runtime.fallbackCoordinator;
    if (!coordinator) return;
    if (coordinator.state.status === "trying") coordinator.finishAttempt(false);
    const decision = coordinator.trigger(
      "player-fatal",
      stringValue(body.error ?? body.reason ?? body.event) || "player playback failed",
    );
    this.setFallbackState(coordinator.state);
    if (decision.kind === "attempt") {
      if (runtime.fallbackResolution) await this.attemptFallback(decision.candidate);
      else await this.attemptPlaybackFallback(decision.candidate);
    }
  }

  private beginPlaybackFallback(lineIndex: number, episodeIndex: number): void {
    const runtime = this.requireRuntime();
    const requests = new Map<string, { lineIndex: number; episodeIndex: number }>();
    const candidates: FallbackCandidate[] = [];
    for (const line of runtime.playbackCatalog?.lines ?? []) {
      for (const episode of line.episodes) {
        if (line.index === lineIndex && episode.index === episodeIndex) continue;
        const id = `line:${line.index}:episode:${episode.index}`;
        requests.set(id, { lineIndex: line.index, episodeIndex: episode.index });
        candidates.push({
          id,
          label: `${line.name} · ${episode.name}`,
          kind: "same-content",
          sourceId: runtime.source,
          lineKey: String(line.index),
        });
      }
    }
    runtime.playbackFallbackRequests = requests;
    runtime.fallbackCoordinator = new PlaybackFallbackCoordinator({
      mode: "prompt",
      maxAttempts: 3,
      totalTimeoutMs: 45_000,
    });
    runtime.fallbackCoordinator.begin(candidates);
    this.setFallbackState(runtime.fallbackCoordinator.state);
  }

  private async attemptPlaybackFallback(candidate: FallbackCandidate): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const request = runtime.playbackFallbackRequests.get(candidate.id);
    if (!request) {
      runtime.fallbackCoordinator?.stop("fallback candidate is unavailable");
      this.setFallbackState(runtime.fallbackCoordinator?.state ?? null);
      return this.envelope();
    }
    try {
      await this.stopPlayer(true);
      await this.play(request);
      this.setFallbackState(runtime.fallbackCoordinator?.state ?? null);
      return this.envelope();
    } catch (error) {
      runtime.fallbackCoordinator?.finishAttempt(false);
      this.setFallbackState(runtime.fallbackCoordinator?.state ?? null);
      throw error;
    }
  }

  private async attemptFallback(candidate: FallbackCandidate): Promise<RendererEnvelope> {
    const runtime = this.requireRuntime();
    const resolution = runtime.fallbackResolution;
    const selected = resolution?.candidates.find(
      (item) => candidateCandidateId(item) === candidate.id,
    );
    if (!selected?.playable) {
      runtime.fallbackCoordinator?.stop("fallback candidate is unavailable");
      this.setFallbackState(runtime.fallbackCoordinator?.state ?? null);
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
      this.setFallbackState(runtime.fallbackCoordinator?.state ?? null);
      return this.envelope();
    } catch (error) {
      runtime.fallbackCoordinator?.finishAttempt(false);
      this.setFallbackState(runtime.fallbackCoordinator?.state ?? null);
      throw error;
    }
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
    runtime.persistence = {
      ...runtime.persistence,
      ...(body.theme === "system" || body.theme === "light" || body.theme === "dark" ? { theme: body.theme } : {}),
      ...(typeof body.scrollTop === "number" ? { scrollTop: Math.max(0, body.scrollTop) } : {}),
      ...(typeof body.siteKey === "string" ? { siteKey: body.siteKey } : {}),
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
    runtime.persistence = {
      ...runtime.persistence,
      ...(value.theme === "system" || value.theme === "light" || value.theme === "dark" ? { theme: value.theme } : {}),
      ...(value.navigation === "home" || value.navigation === "category" || value.navigation === "search" || value.navigation === "detail" || value.navigation === "history" || value.navigation === "favorites" || value.navigation === "follow" || value.navigation === "settings" || value.navigation === "live" || value.navigation === "local" || value.navigation === "downloads" ? { navigation: value.navigation } : {}),
      ...(typeof value.siteKey === "string" ? { siteKey: value.siteKey } : {}),
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

  private applyDesktopSnapshot(snapshot: { state: Record<string, unknown> }): void {
    const runtime = this.requireRuntime();
    const localFallback = runtime.fallbackCoordinator?.state;
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
    const runtime = this.requireRuntime();
    if (payload.action !== "call") {
      if (payload.action === "close") await this.closeQuickJs();
      return {
        session: quickJsSnapshot(runtime),
        ...(payload.method === undefined ? {} : { method: payload.method }),
        cancelled: payload.action === "cancel",
      };
    }
    const requestedMethod = payload.method ?? "home";
    const method = requestedMethod === "home" && !runtime.quickJsMethods.home && runtime.quickJsMethods.homeVod
      ? "homeVod"
      : requestedMethod;
    if (!runtime.quickJsMethods[method]) throw new Error(`TAURI_QUICKJS_UNSUPPORTED_METHOD:${requestedMethod}`);
    const result = await requestQuickJsSidecar({
      action: "call",
      sessionId: runtime.sessionId,
      name: method,
      args: quickJsArgs(method, payload.params),
    });
    return {
      session: quickJsSnapshot(runtime),
      method,
      result,
      cancelled: false,
    };
  }

  private async closeQuickJs(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime.quickJs) return;
    try {
      await requestQuickJsSidecar({ action: "close", sessionId: runtime.sessionId });
    } finally {
      runtime.quickJs = false;
      runtime.quickJsMethods = {};
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

function listItems(value: unknown): Record<string, unknown>[] {
  const object = record(value);
  const list = Array.isArray(object.list) ? object.list : Array.isArray(object.items) ? object.items : [];
  return list.filter(isRecord).map((item) => ({ ...item }));
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

function drmValue(value: unknown): PlayerSource["drm"] | undefined {
  if (!isRecord(value)) return undefined;
  const clearKeys = Object.fromEntries(
    Object.entries(headersValue(value.clearKeys)).map(([keyId, key]) => [
      normalizeClearKeyHex(keyId),
      normalizeClearKeyHex(key),
    ]),
  );
  const servers = headersValue(value.servers);
  if (Object.keys(clearKeys).length === 0 && Object.keys(servers).length === 0) return undefined;
  return {
    ...(Object.keys(clearKeys).length === 0 ? {} : { clearKeys }),
    ...(Object.keys(servers).length === 0 ? {} : { servers }),
  };
}

function normalizeClearKeyHex(value: string): string {
  const compact = value.replaceAll("-", "").toLowerCase();
  return /^[a-f0-9]{32}$/u.test(compact) ? compact : value;
}

function candidateCandidateId(candidate: PlayableCandidate): string {
  const vodId = String(candidate.vod.vod_id ?? candidate.vod.id ?? "").trim();
  return `${candidate.siteKey}:${vodId}`;
}

function fallbackCandidate(candidate: PlayableCandidate): FallbackCandidate {
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

function quickJsScript(site: TauriSite): string {
  const api = site.api.trim();
  if (api.toLowerCase().startsWith("js:")) return api.slice(3).trim();
  if (/^https?:\/\//iu.test(api)) return api;
  if (site.ext?.trim()) return site.ext.trim();
  throw new Error("TAURI_QUICKJS_SCRIPT_REQUIRED");
}

function quickJsAllowedOrigins(script: string, ext?: string): string[] {
  const origins = new Set<string>();
  for (const value of [script, ext ?? ""]) {
    for (const match of value.matchAll(/https?:\/\/[^\s"'\\]+/giu)) {
      try {
        origins.add(new URL(match[0]).origin);
      } catch {
        // Ignore URLs embedded in an opaque ext payload; the sidecar remains deny-by-default.
      }
    }
  }
  return [...origins];
}

function quickJsArgs(method: string, params: Record<string, unknown> | undefined): unknown[] {
  const value = params ?? {};
  switch (method) {
    case "init":
      return [stringValue(value.ext)];
    case "home":
    case "homeVod":
      return [Boolean(value.filter)];
    case "category":
      return [
        stringValue(value.typeId ?? value.type_id),
        numberValue(value.page, 1),
        Boolean(value.filter),
        record(value.extend),
      ];
    case "search":
      return [stringValue(value.key ?? value.wd), Boolean(value.quick), numberValue(value.page, 1)];
    case "detail":
      return [Array.isArray(value.ids) ? value.ids.map(String) : [stringValue(value.id)]];
    case "player":
      return [stringValue(value.flag), stringValue(value.id), Array.isArray(value.vipFlags) ? value.vipFlags.map(String) : []];
    default:
      return [];
  }
}

function quickJsSnapshot(runtime: TauriRuntimeState): SourceSessionResult["session"] {
  const capabilities: SourceCapabilities = {
    home: Boolean(runtime.quickJsMethods.home || runtime.quickJsMethods.homeVod),
    category: Boolean(runtime.quickJsMethods.category),
    search: Boolean(runtime.quickJsMethods.search),
    detail: Boolean(runtime.quickJsMethods.detail),
    playback: Boolean(runtime.quickJsMethods.player),
    localProxy: Boolean(runtime.quickJsMethods.localProxy),
    filters: Boolean(runtime.quickJsMethods.category),
    pagination: Boolean(runtime.quickJsMethods.category || runtime.quickJsMethods.search),
    engine: "quickjs",
  };
  return {
    sessionId: runtime.sessionId,
    sourceId: runtime.source,
    ...(runtime.selectedSite?.key === undefined ? {} : { siteKey: runtime.selectedSite.key }),
    api: runtime.selectedSite?.api ?? "",
    siteType: runtime.selectedSite?.siteType ?? 3,
    state: runtime.sessionReady ? "ready" : "closed",
    capabilities,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function featureSourceId(runtime: TauriRuntimeState): string {
  const source = runtime.selectedSite?.key || runtime.source;
  return `source:${stableDigest(source)}`;
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
