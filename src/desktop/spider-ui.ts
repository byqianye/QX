import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve as resolvePath } from "node:path";

import type {
  DesktopSpiderPlaybackState,
  DesktopSpiderSessionStatus,
  DesktopSpiderView,
} from "./spider-session.js";
import {
  renderDesktopSpiderImportUi,
  type DesktopSpiderImportController,
} from "./spider-import.js";
import { renderEmbeddedPlayer } from "./embedded-player-ui.js";
import {
  EmbeddedPlaybackController,
  type PlaybackMediaEvent,
  type PlaybackMediaSync,
  type PlaybackStatus,
  type PlaybackState,
  type PlaybackSource,
  type PlaybackTraceStage,
} from "./playback.js";
import {
  PlaybackProxyServer,
  type PlaybackProxySession,
} from "./playback-proxy.js";
import { MediaResolver } from "./media-resolver.js";
import {
  parseVodPlayback,
  type PlaybackCatalog,
  type PlaybackSelection,
} from "./vod-playback.js";
import { mergeVodDisplayFields } from "./vod-merge.js";
import type {
  PlaybackSourceResolution,
  PlayableCandidate,
} from "./playback-source-resolver.js";
import {
  type DesktopStatePatch,
  type DesktopStateStorePort,
  type PageStatePatch,
} from "./state-persistence.js";
import type { SpiderResponse } from "../spider/rpc.js";
import type { QxPlayerResult, SourceCapabilities } from "../source/media-source.js";
import { normalizeVod, normalizeVodDetails, unwrapSpiderResponse } from "../source/normalizers.js";
import type { AggregateSearchSnapshot } from "../search/aggregate-search.js";
import {
  ParseChainError,
  ParseChainResolver,
  type ParseRequest,
  type ParserCandidate,
  type ParseUiState,
} from "./parse-chain.js";
import type { PlaybackRule } from "./playback-rules.js";
import { sanitizeSnifferHeaders, type IsolatedSniffer } from "../electron/isolated-sniffer.js";
import { isRemoteSubtitleTrack, type SubtitleTrack } from "../subtitles.js";
import {
  PlaybackFallbackCoordinator,
  PlaybackHealthRegistry,
  isAutoFallbackRetryable,
  type FallbackCandidate,
  type PlaybackFallbackMode,
  type PlaybackFallbackState,
  type PlaybackFallbackTrigger,
  type PlaybackHealthSnapshot,
} from "../health/playback-health.js";
import type { SourceHealthService } from "../health/source-health.js";
import {
  EMPTY_HISTORY_UI_STATE,
  type HistoryCatalogEpisode,
  type HistoryItem,
  type HistoryResumeCandidate,
  type HistoryResumeMode,
  type HistoryUiState,
} from "../history/history-types.js";
import {
  createHistoryContext,
  HistoryProgressService,
  historyIdentity,
  safeHistoryIdentifier,
  sourceIdForHistory,
  sourceDisplayNameForHistory,
} from "../history/history-progress.js";
import {
  EMPTY_FAVORITES_UI_STATE,
  type FavoriteContentInput,
  type FavoriteGroupDeleteMode,
  type FavoriteItem,
  type FavoritesUiState,
} from "../favorites/favorites-types.js";
import { FavoritesService } from "../favorites/favorites-service.js";
import {
  EMPTY_CACHE_UI_STATE,
  type CacheClearScope,
  type CacheUiState,
} from "../cache/cache-types.js";
import { CacheService } from "../cache/cache-service.js";
import { PosterProxy } from "./poster-proxy.js";
import { DataStorageService } from "../data/data-directory.js";
import { EMPTY_BACKUP_UI_STATE, type BackupUiState } from "../backup-types.js";
import { EMPTY_STORAGE_UI_STATE, type StorageMode, type StorageUiState } from "../storage/storage-types.js";
import {
  EMPTY_FOLLOW_UI_STATE,
  type FollowContentInput,
  type FollowItem,
  type FollowUiState,
} from "../follow/follow-types.js";
import {
  followContentFromDetail,
  FollowService,
} from "../follow/follow-service.js";
import {
  EMPTY_DANMAKU_UI_STATE,
  type DanmakuLoadInput,
  type DanmakuSettingsPatch,
} from "../danmaku/danmaku-types.js";
import { DanmakuService } from "../danmaku/danmaku-service.js";
import { LocalMediaError, LocalMediaService, type LocalMediaStream } from "../local-media/local-media-service.js";
import { EMPTY_LOCAL_MEDIA_UI_STATE, type LocalMediaUiState } from "../local-media/local-media-types.js";
import { DownloadError } from "../downloads/download-backend.js";
import { DownloadService, DownloadServiceError } from "../downloads/download-service.js";
import { EMPTY_DOWNLOAD_UI_STATE, type DownloadUiState } from "../downloads/download-types.js";
import { PushService, PushServiceError, type PushSubmissionResult } from "../push/push-service.js";
import type { PushPlaybackSessionSnapshot, PushRequest, PushSourceReference, PushUrlRequest } from "../push/push-types.js";
import { CastService, CastServiceError } from "../cast/cast-service.js";
import type { CastMediaSource } from "../cast/cast-types.js";
import type { CastUiState } from "../cast/cast-types.js";
import type {
  WebControlBackend,
  WebControlBackendStatus,
  WebControlCastState,
  WebControlDetail,
  WebControlDownloads,
  WebControlNowPlaying,
  WebControlPushResult,
  WebControlSearchResult,
  WebControlSnapshot,
} from "../web-control/web-control-types.js";

const require = createRequire(import.meta.url);

export type {
  DesktopSpiderPlaybackState,
  DesktopSpiderSessionStatus,
  DesktopSpiderView,
} from "./spider-session.js";

class SubtitlePreparationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SubtitlePreparationError";
    this.code = code;
  }
}

class FollowSourceUnavailableError extends Error {
  public readonly code = "FOLLOW_SOURCE_UNAVAILABLE";

  public constructor() {
    super("The source for this follow item is unavailable");
    this.name = "FollowSourceUnavailableError";
  }
}

export interface DesktopSpiderSessionPort {
  readonly view: DesktopSpiderView;
  readonly capabilities?: SourceCapabilities;
  confirmImport(): void;
  open(siteKey: string, ext: string): Promise<SpiderResponse>;
  homeContent(filter?: boolean, timeoutMs?: number): Promise<SpiderResponse>;
  categoryContent(
    typeId: string,
    page: number,
    filter?: boolean,
    extend?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  searchContent(
    key: string,
    quick?: boolean,
    page?: number,
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse>;
  playerContent(
    flag: string,
    id: string,
    vipFlags?: string[],
    timeoutMs?: number,
  ): Promise<SpiderResponse>;
  retrySourceHealth?(): void;
  stopPlayback?(): Promise<void>;
  destroy(): Promise<void>;
}

export type DesktopSpiderUiPage = "import" | "home" | "category" | "search" | "detail" | "closed";

type DetailReturnContext = {
  page: "home" | "category" | "search";
  scrollTop: number;
};

export type PlayerHostMode = "embedded" | "detached";

export interface DesktopPlaybackSession {
  id: string;
  host: PlayerHostMode;
  lineIndex: number | null;
  episodeIndex: number | null;
  lineName: string | null;
  episodeName: string | null;
  media: {
    detailId: string | null;
    title: string | null;
    url: string;
  };
}

interface PlaybackRequest {
  flag: string;
  id: string;
  vipFlags: string[];
  timeoutMs?: number;
  metadata?: Pick<DesktopPlaybackSession, "lineIndex" | "episodeIndex" | "lineName" | "episodeName">;
}

interface PlaybackFailure {
  error: unknown;
  response?: SpiderResponse;
}

export type PlayerMediaSync = PlaybackMediaSync;

export interface DesktopSpiderUiState {
  page: DesktopSpiderUiPage;
  source: string;
  api: string | null;
  status: DesktopSpiderSessionStatus;
  loading: boolean;
  warning: string | null;
  error: { code: string; message: string } | null;
  sidecarRunning: boolean;
  playback: DesktopSpiderPlaybackState;
  capabilities: SourceCapabilities;
  player: PlaybackState;
  canPlay: boolean;
  items: readonly Record<string, unknown>[];
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: PlaybackSelection | null;
  playerHost: PlayerHostMode;
  playbackSession: DesktopPlaybackSession | null;
  scrollTop: number;
  aggregateSearch: AggregateSearchSnapshot | null;
  playbackSources: PlaybackSourceResolution | null;
  playbackHealth: PlaybackHealthSnapshot;
  playbackDiagnostics: PlaybackAttemptDiagnostics | null;
  fallback: PlaybackFallbackState;
  history: HistoryUiState;
  historyResume: HistoryResumeCandidate | null;
  favorites: FavoritesUiState;
  favoriteDetail: FavoriteItem | null;
  follow: FollowUiState;
  followDetail: FollowItem | null;
  cache: CacheUiState;
  storage: StorageUiState;
  backup?: BackupUiState;
  danmaku: import("../danmaku/danmaku-types.js").DanmakuUiState;
  localMedia: LocalMediaUiState;
  downloads: DownloadUiState;
}

export interface PlaybackAttemptDiagnostics {
  siteKey: string;
  flag: string;
  episodeId: string;
  playerContent: { ok: boolean; code: string | null; message: string | null };
  parse: number | null;
  jx: number | null;
  format: string | null;
  jxFrom: string | null;
}

export interface DesktopSpiderUiOptions {
  session: DesktopSpiderSessionPort;
  createSession?: () => DesktopSpiderSessionPort;
  playbackProxyOrigins?: readonly string[];
  parserCandidates?: readonly ParserCandidate[];
  parserAllowedOrigins?: readonly string[];
  parserFetch?: typeof fetch;
  playbackFetch?: typeof fetch;
  playbackRules?: readonly PlaybackRule[];
  sniffer?: IsolatedSniffer;
  playbackFallbackMode?: PlaybackFallbackMode;
  playbackFallbackMaxAttempts?: number;
  playbackFallbackTimeoutMs?: number;
  history?: HistoryProgressService;
  favorites?: FavoritesService;
  follow?: FollowService;
  cache?: CacheService;
  storage?: DataStorageService;
  danmaku?: DanmakuService;
  localMedia?: LocalMediaService;
  downloads?: DownloadService;
  sourceHealth?: SourceHealthService;
  onPlaybackComplete?: () => void | Promise<void>;
}

export class DesktopSpiderUiController {
  private session: DesktopSpiderSessionPort;
  private readonly createSession: (() => DesktopSpiderSessionPort) | undefined;
  private page: Exclude<DesktopSpiderUiPage, "closed"> = "import";
  private activeOperation: string | null = null;
  private localStatus: DesktopSpiderSessionStatus | null = null;
  private localError: { code: string; message: string } | null = null;
  private items: Record<string, unknown>[] = [];
  private detailItem: Record<string, unknown> | null = null;
  private detailReturnContext: DetailReturnContext | null = null;
  private playbackCatalog: PlaybackCatalog | null = null;
  private playbackSelection: PlaybackSelection | null = null;
  private playerHost: PlayerHostMode = "embedded";
  private playbackSession: DesktopPlaybackSession | null = null;
  private scrollTop = 0;
  private aggregateSearchValue: AggregateSearchSnapshot | null = null;
  private playbackSourceResolution: PlaybackSourceResolution | null = null;
  private readonly playerController = new EmbeddedPlaybackController();
  private readonly playbackProxy: PlaybackProxyServer;
  private readonly mediaResolver: MediaResolver;
  private readonly parserCandidates: readonly ParserCandidate[];
  private readonly parseResolver: ParseChainResolver;
  private readonly sniffer: IsolatedSniffer | undefined;
  private readonly playbackHealthRegistry: PlaybackHealthRegistry;
  private readonly fallbackCoordinator: PlaybackFallbackCoordinator;
  private readonly parserAllowedOrigins: readonly string[];
  private parseState: ParseUiState = initialParseState();
  private proxySession: PlaybackProxySession | undefined;
  private subtitleProxySessions: PlaybackProxySession[] = [];
  private currentPlaybackRequest: PlaybackRequest | null = null;
  private currentHealthKey = "playback:idle";
  private playbackDiagnosticsValue: PlaybackAttemptDiagnostics | null = null;
  private readonly fallbackRequests = new Map<string, PlaybackRequest>();
  private pendingFallback: Promise<void> | null = null;
  private readonly historyService: HistoryProgressService | undefined;
  private readonly favoritesService: FavoritesService | undefined;
  private readonly followService: FollowService | undefined;
  private readonly cacheService: CacheService | undefined;
  private readonly storageService: DataStorageService | undefined;
  private readonly danmakuService: DanmakuService | undefined;
  private readonly localMediaService: LocalMediaService | undefined;
  private readonly downloadService: DownloadService | undefined;
  private readonly sourceHealth: SourceHealthService | undefined;
  private onPlaybackComplete: (() => void | Promise<void>) | undefined;
  private historyResume: HistoryResumeCandidate | null = null;
  private pendingResumeSeconds = 0;
  private sourceHealthAttemptStartedAt = 0;
  private sourceHealthPlaybackRecorded = false;

  public constructor(options: DesktopSpiderUiOptions) {
    this.session = options.session;
    this.createSession = options.createSession;
    this.historyService = options.history;
    this.favoritesService = options.favorites;
    this.followService = options.follow;
    this.cacheService = options.cache;
    this.storageService = options.storage;
    this.danmakuService = options.danmaku;
    this.localMediaService = options.localMedia;
    this.downloadService = options.downloads;
    this.sourceHealth = options.sourceHealth;
    this.onPlaybackComplete = options.onPlaybackComplete;
    this.parserCandidates = options.parserCandidates?.map(cloneParserCandidate) ?? [];
    this.sniffer = options.sniffer;
    this.parserAllowedOrigins = options.parserAllowedOrigins ?? [];
    this.playbackHealthRegistry = new PlaybackHealthRegistry();
    this.fallbackCoordinator = new PlaybackFallbackCoordinator({
      ...(options.playbackFallbackMode ? { mode: options.playbackFallbackMode } : {}),
      ...(options.playbackFallbackMaxAttempts ? { maxAttempts: options.playbackFallbackMaxAttempts } : {}),
      ...(options.playbackFallbackTimeoutMs ? { totalTimeoutMs: options.playbackFallbackTimeoutMs } : {}),
      autoFallbackV2: {
        maxSources: 5,
        maxLinesPerSource: 3,
        maxParsesPerSource: 3,
        totalTimeoutMs: options.playbackFallbackTimeoutMs ?? 45_000,
      },
    });
    this.parseResolver = new ParseChainResolver({
      ...(options.parserAllowedOrigins ? { allowedOrigins: options.parserAllowedOrigins } : {}),
      ...(options.parserFetch ? { fetchImpl: options.parserFetch } : {}),
    });
    this.playbackProxy = new PlaybackProxyServer(
      {
        ...(options.playbackProxyOrigins ? { allowedOrigins: options.playbackProxyOrigins } : {}),
        ...(options.playbackRules ? { rules: options.playbackRules } : {}),
        ...(options.playbackFetch ? { fetchImpl: options.playbackFetch } : {}),
      },
    );
    this.mediaResolver = new MediaResolver(this.playbackProxy);
  }

  public get state(): DesktopSpiderUiState {
    const view = this.session.view;
    const capabilities = this.session.capabilities ?? view.capabilities ?? fallbackCapabilities(view);
    const status = this.localStatus ?? view.status;
    return {
      page: status === "destroyed" ? "closed" : this.page,
      source: view.source,
      api: view.api,
      status,
      loading: this.activeOperation !== null || status === "loading",
      warning: view.warning,
      error: this.localError ?? view.error,
      sidecarRunning: view.sidecarRunning,
      playback: publicPlaybackState(view.playback),
      player: {
        ...this.playerController.state,
        parse: cloneParseState(this.parseState),
      },
      capabilities: { ...capabilities },
      canPlay: capabilities.playback && view.playback.available,
      items: this.items.map((item) => ({ ...item })),
      detail: this.detailItem ? { ...this.detailItem } : null,
      playbackCatalog: clonePlaybackCatalog(this.playbackCatalog),
      playbackSelection: this.playbackSelection ? { ...this.playbackSelection } : null,
      playerHost: this.playerHost,
      playbackSession: clonePlaybackSession(this.playbackSession),
      scrollTop: this.scrollTop,
      aggregateSearch: this.aggregateSearchValue,
      playbackSources: clonePlaybackSourceResolution(this.playbackSourceResolution),
      playbackHealth: this.publicPlaybackHealth(),
      playbackDiagnostics: this.playbackDiagnosticsValue ? { ...this.playbackDiagnosticsValue, playerContent: { ...this.playbackDiagnosticsValue.playerContent } } : null,
      fallback: this.fallbackCoordinator.state,
      history: this.historyService?.uiState() ?? EMPTY_HISTORY_UI_STATE,
      historyResume: this.historyResume ? { ...this.historyResume } : null,
      favorites: this.favoritesService?.uiState(sourceIdForHistory(view.source)) ?? EMPTY_FAVORITES_UI_STATE,
      favoriteDetail: this.favoriteForDetail(),
      follow: this.followService?.uiState(sourceIdForHistory(view.source)) ?? EMPTY_FOLLOW_UI_STATE,
      followDetail: this.followForDetail(),
      cache: this.cacheService?.uiState() ?? EMPTY_CACHE_UI_STATE,
      storage: this.storageService?.uiState() ?? EMPTY_STORAGE_UI_STATE,
      danmaku: this.danmakuService?.uiState() ?? EMPTY_DANMAKU_UI_STATE,
      localMedia: this.localMediaService?.uiState() ?? EMPTY_LOCAL_MEDIA_UI_STATE,
      downloads: this.downloadService?.uiState() ?? EMPTY_DOWNLOAD_UI_STATE,
    };
  }

  public toggleFavorite(): DesktopSpiderUiState {
    const favoriteService = this.favoritesService;
    const input = this.favoriteInputForDetail();
    if (!favoriteService || !input) {
      this.localError = { code: "FAVORITE_DETAIL_REQUIRED", message: "请先打开一个媒体详情。" };
      return this.state;
    }
    favoriteService.toggle(input);
    return this.state;
  }

  public moveFavorite(groupId: string): DesktopSpiderUiState {
    const favorite = this.favoriteForDetail();
    if (!this.favoritesService || !favorite) {
      this.localError = { code: "FAVORITE_NOT_FOUND", message: "当前详情尚未收藏。" };
      return this.state;
    }
    this.favoritesService.move(favorite.favoriteId, groupId);
    return this.state;
  }

  public toggleFollow(): DesktopSpiderUiState {
    const service = this.followService;
    const input = this.followInputForDetail();
    if (!service || !input) {
      this.localError = { code: "FOLLOW_DETAIL_REQUIRED", message: "Follow detail required" };
      return this.state;
    }
    service.toggle(input);
    return this.state;
  }

  public followAndFavorite(): DesktopSpiderUiState {
    const followInput = this.followInputForDetail();
    const favoriteInput = this.favoriteInputForDetail();
    if (!this.followService || !followInput || !this.favoritesService || !favoriteInput) {
      this.localError = { code: "FOLLOW_DETAIL_REQUIRED", message: "Follow detail required" };
      return this.state;
    }
    if (!this.favoritesService.findByContent(favoriteInput.sourceId, favoriteInput.vodId)) {
      this.favoritesService.toggle(favoriteInput);
    }
    if (!this.followService.findByContent(followInput.sourceId, followInput.vodId)) {
      this.followService.follow(followInput);
    }
    return this.state;
  }

  public deleteFollow(identity: string): DesktopSpiderUiState {
    this.followService?.unfollow(identity);
    return this.state;
  }

  public markFollowWatched(identity: string): DesktopSpiderUiState {
    this.followService?.markWatched(identity);
    return this.state;
  }

  public markFollowUnwatched(identity: string): DesktopSpiderUiState {
    this.followService?.markUnwatched(identity);
    return this.state;
  }

  public async checkFollow(): Promise<DesktopSpiderUiState> {
    const service = this.followService;
    if (!service) throw new Error("FOLLOW_UNAVAILABLE");
    const currentSourceId = sourceIdForHistory(this.session.view.source);
    if (this.session.capabilities && !this.session.capabilities.detail) {
      throw new Error("FOLLOW_DETAIL_UNAVAILABLE");
    }
    await service.check(async (record) => {
      if (record.sourceId !== currentSourceId) throw new FollowSourceUnavailableError();
      const detail = normalizeVodDetails(
        unwrapSpiderResponse(await this.session.detailContent([record.vodId]), "detail"),
      )[0];
      if (!detail) throw new Error("FOLLOW_DETAIL_NOT_FOUND");
      return followContentFromDetail(detail, currentSourceId, record.vodId);
    });
    return this.state;
  }

  public refreshCache(): DesktopSpiderUiState {
    return this.state;
  }

  public setPlaybackSourceResolution(
    resolution: PlaybackSourceResolution | null,
  ): DesktopSpiderUiState {
    this.playbackSourceResolution = resolution;
    return this.state;
  }

  public playbackSourceCandidate(siteKey: string, vodId: string): PlayableCandidate | null {
    return this.playbackSourceResolution?.candidates.find((candidate) => (
      candidate.siteKey === siteKey && String(candidate.vod.id ?? candidate.vod.vod_id ?? "") === vodId
    )) ?? null;
  }

  public clearCache(scope: CacheClearScope): DesktopSpiderUiState {
    this.cacheService?.clear(scope);
    return this.state;
  }

  public refreshStorage(): DesktopSpiderUiState {
    return this.state;
  }

  private favoriteForDetail(): FavoriteItem | null {
    const input = this.favoriteInputForDetail();
    if (!input || !this.favoritesService) return null;
    const record = this.favoritesService.findByContent(input.sourceId, input.vodId);
    if (!record) return null;
    return this.favoritesService.uiState(input.sourceId).items
      .find((item) => item.favoriteId === record.favoriteId) ?? null;
  }

  private followForDetail(): FollowItem | null {
    const input = this.followInputForDetail();
    if (!input || !this.followService) return null;
    const record = this.followService.findByContent(input.sourceId, input.vodId);
    if (!record) return null;
    return this.followService.uiState(input.sourceId).items
      .find((item) => item.identity === record.identity) ?? null;
  }

  private favoriteInputForDetail(): FavoriteContentInput | null {
    const detail = this.detailItem;
    if (!detail) return null;
    const vodId = firstText(detail, ["vod_id", "id", "video_id"]);
    if (!vodId) return null;
    const view = this.session.view;
    const title = firstText(detail, ["vod_name", "name", "title"]) ?? vodId;
    const metadata = {
      area: firstText(detail, ["vod_area", "area"]),
      director: firstText(detail, ["vod_director", "director"]),
      actor: firstText(detail, ["vod_actor", "actor"]),
      remarks: firstText(detail, ["vod_remarks", "remark", "remarks"]),
    };
    return {
      sourceId: sourceIdForHistory(view.source),
      vodId,
      title,
      poster: firstText(detail, ["vod_pic", "poster", "image"]),
      year: firstText(detail, ["vod_year", "year"]),
      category: firstText(detail, ["vod_class", "type_name", "category", "type"]),
      sourceName: sourceDisplayNameForHistory(view.source),
      metadata,
    };
  }

  private followInputForDetail(): FollowContentInput | null {
    const detail = this.detailItem;
    if (!detail) return null;
    const vodId = firstText(detail, ["vod_id", "id", "video_id"]);
    if (!vodId) return null;
    const view = this.session.view;
    const episodes = this.playbackCatalog?.lines
      .filter((line) => line.episodes.length > 0)
      .sort((left, right) => right.episodes.length - left.episodes.length)[0]
      ?.episodes
      .map((episode) => ({ id: episode.id, name: episode.name }))
      ?? followContentFromDetail(detail, sourceIdForHistory(view.source), vodId).episodes;
    return {
      sourceId: sourceIdForHistory(view.source),
      vodId,
      title: firstText(detail, ["vod_name", "name", "title"]) ?? vodId,
      poster: firstText(detail, ["vod_pic", "poster", "image"]),
      episodes,
    };
  }

  public get playbackProxySessionCount(): number {
    return this.playbackProxy.activeSessionCount;
  }

  public confirmImport(): DesktopSpiderUiState {
    this.localError = null;
    try {
      this.session.confirmImport();
      this.localStatus = null;
    } catch (error) {
      void this.setError(error);
    }
    return this.state;
  }

  public open(siteKey: string, ext: string): Promise<DesktopSpiderUiState> {
    return this.run("open", () => this.session.open(siteKey, ext), () => {
      this.page = "home";
      this.items = [];
      this.detailItem = null;
      this.detailReturnContext = null;
      this.clearPlaybackCatalog();
      this.playbackSourceResolution = null;
      this.scrollTop = 0;
      this.aggregateSearchValue = null;
    });
  }

  public home(filter = false, timeoutMs?: number): Promise<DesktopSpiderUiState> {
    return this.run(
      "home",
      () => this.session.homeContent(filter, timeoutMs),
      (response) => {
        this.page = "home";
        this.items = listFrom(response);
        this.detailItem = null;
        this.detailReturnContext = null;
        this.playbackSourceResolution = null;
        this.scrollTop = 0;
        this.aggregateSearchValue = null;
      },
    );
  }

  public category(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<DesktopSpiderUiState> {
    return this.run(
      "category",
      () => this.session.categoryContent(typeId, page, filter, extend, timeoutMs),
      (response) => {
        this.page = "category";
        this.items = listFrom(response);
        this.detailItem = null;
        this.detailReturnContext = null;
        this.playbackSourceResolution = null;
        this.scrollTop = 0;
        this.aggregateSearchValue = null;
      },
    );
  }

  public search(
    key: string,
    quick = false,
    page = 1,
    timeoutMs?: number,
  ): Promise<DesktopSpiderUiState> {
    return this.run(
      "search",
      () => this.session.searchContent(key, quick, page, timeoutMs),
      (response) => {
        this.page = "search";
        this.items = listFrom(response);
        this.detailItem = null;
        this.detailReturnContext = null;
        this.playbackSourceResolution = null;
        this.scrollTop = 0;
        this.aggregateSearchValue = null;
      },
    );
  }

  public detail(vodId: string, timeoutMs?: number): Promise<DesktopSpiderUiState> {
    if (this.page !== "detail" && isDetailReturnPage(this.page)) {
      this.detailReturnContext = { page: this.page, scrollTop: this.scrollTop };
    }
    return this.run(
      "detail",
      () => this.session.detailContent([vodId], timeoutMs),
      (response) => {
        this.page = "detail";
        const detailItem = listFrom(response)[0] ?? null;
        const listItem = this.items.find((item) => String(item.vod_id ?? "") === vodId) ?? null;
        this.detailItem = mergeVodDisplayFields(listItem, detailItem);
        this.playbackCatalog = this.detailItem ? parseVodPlayback(this.detailItem) : null;
        this.playbackSourceResolution = null;
        this.playbackSelection = null;
        this.historyResume = this.findDetailResume();
        this.scrollTop = 0;
        this.aggregateSearchValue = null;
      },
    );
  }

  public closeDetail(): DesktopSpiderUiState {
    if (this.page !== "detail") return this.state;
    const returnContext = this.detailReturnContext ?? { page: "home" as const, scrollTop: 0 };
    this.page = returnContext.page;
    this.scrollTop = returnContext.scrollTop;
    this.detailItem = null;
    this.clearPlaybackCatalog();
    this.playbackSourceResolution = null;
    this.playbackSelection = null;
    this.historyResume = null;
    this.aggregateSearchValue = null;
    this.detailReturnContext = null;
    return this.state;
  }

  public player(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
    resumeMode?: HistoryResumeMode,
  ): Promise<DesktopSpiderUiState> {
    return this.playPlayer(flag, id, vipFlags, timeoutMs, undefined, resumeMode);
  }

  public async playLocalMedia(
    itemId: string,
    baseUrl: string,
    resumeMode?: HistoryResumeMode,
  ): Promise<DesktopSpiderUiState> {
    const localMedia = this.localMediaService;
    if (!localMedia) throw new LocalMediaError("LOCAL_MEDIA_UNAVAILABLE", "本地媒体服务不可用。");
    const prepared = localMedia.preparePlayback(itemId, baseUrl);
    const context = createHistoryContext({
      source: `local:${itemId}`,
      sourceType: "local",
      vodId: itemId,
      episodeId: itemId,
      title: prepared.item.displayName,
      playbackLine: "本地媒体",
    });
    if (!context) throw new LocalMediaError("LOCAL_MEDIA_HISTORY_INVALID", "本地媒体历史身份无效。");
    const existing = this.historyService?.get(historyIdentity(context.identity));
    this.historyResume = existing && (existing.position > 0 || existing.completed)
      ? {
          ...existing,
          lineIndex: null,
          episodeIndex: null,
          lineName: "本地媒体",
          episodeName: prepared.item.displayName,
          canResume: existing.position > 0 || existing.completed,
        }
      : null;
    if (resumeMode === "beginning" && existing) this.historyService?.deleteProgress(existing.identity);
    this.pendingResumeSeconds = resumeMode === "continue" && existing ? existing.position : 0;
    await this.stopPlayer();
    this.currentPlaybackRequest = null;
    this.fallbackCoordinator.cancel("切换到本地媒体");
    this.page = "home";
    this.detailItem = null;
    this.clearPlaybackCatalog();
    this.playbackSelection = null;
    this.localStatus = null;
    this.localError = null;
    this.historyService?.begin(context);
    const loaded = this.playerController.load({
      parse: 0,
      url: prepared.url,
      headers: {},
      ...(prepared.subtitles.length > 0 ? { subtitles: prepared.subtitles } : {}),
    });
    if (loaded.error) throw new LocalMediaError(loaded.error.code, loaded.error.message);
    if (this.pendingResumeSeconds > 0) this.playerController.seek(this.pendingResumeSeconds);
    this.playbackSession = {
      id: randomUUID(),
      host: "embedded",
      lineIndex: null,
      episodeIndex: null,
      lineName: "本地媒体",
      episodeName: prepared.item.displayName,
      media: {
        detailId: prepared.item.id,
        title: prepared.item.displayName,
        url: prepared.url,
      },
    };
    return this.state;
  }

  public async playPushUrl(request: PushUrlRequest): Promise<DesktopSpiderUiState> {
    await this.stopPlayer();
    this.currentPlaybackRequest = null;
    this.fallbackCoordinator.cancel("切换到 Push 媒体");
    this.page = "home";
    this.detailItem = null;
    this.clearPlaybackCatalog();
    this.playbackSelection = null;
    this.localStatus = null;
    this.localError = null;
    this.parseState = {
      status: "succeeded",
      parserId: "push-url",
      attempts: [],
      error: null,
    };
    const playbackSessionId = randomUUID();
    const mediaSource = await this.createMediaProxy(
      { url: request.url, headers: request.headers ?? {} },
      playbackSessionId,
    );
    const loaded = this.playerController.load(mediaSource);
    if (loaded.error) {
      await this.releasePlaybackProxy();
      throw new PushServiceError(loaded.error.code, loaded.error.message);
    }
    const source = this.playerController.state.source;
    if (!source) {
      await this.releasePlaybackProxy();
      throw new PushServiceError("PUSH_PLAYBACK_FAILED", "Push 媒体地址未能加载。");
    }
    this.playbackSession = {
      id: playbackSessionId,
      host: "embedded",
      lineIndex: null,
      episodeIndex: null,
      lineName: "Push",
      episodeName: request.title?.trim() || "外部媒体",
      media: {
        detailId: null,
        title: request.title?.trim() || "外部媒体",
        url: source.url,
      },
    };
    return this.state;
  }

  public async playPushSourceItem(reference: PushSourceReference): Promise<DesktopSpiderUiState> {
    const currentSourceId = sourceIdForHistory(this.session.view.source);
    if (reference.sourceId && reference.sourceId !== currentSourceId && reference.sourceId !== this.session.view.source) {
      throw new PushServiceError("PUSH_SOURCE_UNAVAILABLE", "Push 来源与当前来源不匹配。", undefined);
    }
    return this.player(reference.flag ?? "default", reference.episodeId ?? reference.contentId);
  }

  public setPlaybackCompleteHandler(handler: (() => void | Promise<void>) | undefined): void {
    this.onPlaybackComplete = handler;
  }

  public setAggregateSearch(snapshot: AggregateSearchSnapshot): DesktopSpiderUiState {
    this.page = "search";
    this.aggregateSearchValue = snapshot;
    this.items = snapshot.groups.map((group) => {
      const representative = group.items[0];
      return {
        ...(representative?.raw ?? {}),
        vod_id: group.items.length === 1 ? representative?.id ?? group.key : group.key,
        vod_name: group.name,
        source_ids: [...group.sourceIds],
      };
    });
    this.detailItem = null;
    this.playbackCatalog = null;
    this.playbackSourceResolution = null;
    this.playbackSelection = null;
    return this.state;
  }

  public playEpisode(
    lineIndex: number,
    episodeIndex: number,
    vipFlags: string[] = [],
    timeoutMs?: number,
    resumeMode?: HistoryResumeMode,
  ): Promise<DesktopSpiderUiState> {
    const line = this.playbackCatalog?.lines[lineIndex];
    const episode = line?.episodes[episodeIndex];
    if (!line || !episode || !Number.isInteger(lineIndex) || !Number.isInteger(episodeIndex)) {
      this.localStatus = "error";
      this.localError = {
        code: "PLAYBACK_FORMAT_INVALID",
        message: "播放线路或选集不存在。",
      };
      return Promise.resolve(this.state);
    }
    this.playbackSelection = { lineIndex, episodeIndex };
    return this.playPlayer(line.name, episode.id, vipFlags, timeoutMs, {
      lineIndex,
      episodeIndex,
      lineName: line.name,
      episodeName: episode.name,
    }, resumeMode);
  }

  public detachPlayer(): DesktopSpiderUiState {
    if (!this.playbackSession || !this.playerController.state.source) {
      this.localError = {
        code: "PLAYBACK_NOT_LOADED",
        message: "当前没有可拆分的播放会话。",
      };
      return this.state;
    }
    this.playerHost = "detached";
    this.playbackSession.host = "detached";
    return this.state;
  }

  public attachPlayer(): DesktopSpiderUiState {
    this.playerHost = "embedded";
    if (this.playbackSession) this.playbackSession.host = "embedded";
    return this.state;
  }

  public syncPlayerState(patch: PlayerMediaSync): DesktopSpiderUiState {
    if (patch.sessionId !== undefined && patch.sessionId !== this.playbackSession?.id) return this.state;
    this.playerController.syncMedia(patch);
    if (patch.event?.type === "completion") this.playerController.markEnded();
    this.historyService?.sync(patch);
    if (patch.currentTime !== undefined && Number.isFinite(patch.currentTime)) {
      this.danmakuService?.sync(patch.currentTime * 1_000, patch.event?.type, patch.status);
    }
    this.recordMediaEvent(patch);
    if (patch.error) this.localError = { ...patch.error };
    return this.state;
  }

  public async syncPlayerStateAsync(patch: PlayerMediaSync): Promise<DesktopSpiderUiState> {
    this.syncPlayerState(patch);
    const pending = this.pendingFallback;
    if (pending) await pending;
    return this.state;
  }

  public setFallbackMode(mode: PlaybackFallbackMode): DesktopSpiderUiState {
    this.fallbackCoordinator.setMode(mode);
    return this.state;
  }

  public cancelFallback(reason = "用户取消"): DesktopSpiderUiState {
    this.fallbackCoordinator.cancel(reason);
    return this.state;
  }

  public async approveFallback(): Promise<DesktopSpiderUiState> {
    const decision = this.fallbackCoordinator.approveNext();
    if (decision.kind !== "attempt") return this.state;
    const request = this.fallbackRequests.get(decision.candidate.id);
    if (!request) {
      this.fallbackCoordinator.stop("回退线路不存在");
      return this.state;
    }
    await this.runPlayerAttempt(request, true);
    return this.state;
  }

  public setScrollTop(scrollTop: number): DesktopSpiderUiState {
    this.scrollTop = Math.max(0, Math.min(10_000_000, Math.floor(scrollTop)));
    return this.state;
  }

  public clearHistoryResume(): DesktopSpiderUiState {
    this.historyResume = null;
    return this.state;
  }

  public restoreHistoryResume(item: HistoryItem): DesktopSpiderUiState {
    if (!this.playbackCatalog || !this.historyService) return this.state;
    const sourceId = sourceIdForHistory(this.session.view.source);
    if (item.sourceId !== sourceId) return this.state;
    const episodeId = item.episodeId ?? "";
    const episodeNumber = typeof item.episode === "number" ? item.episode : 0;
    const playbackLine = item.playbackLine ?? "";
    const preferredLines = playbackLine
      ? this.playbackCatalog.lines.filter((line) => line.name === playbackLine)
      : [];
    const lines = preferredLines.length > 0 ? preferredLines : this.playbackCatalog.lines;
    for (const line of lines) {
      const episodeIndex = line.episodes.findIndex((episode, index) => (
        (episodeId && safeHistoryIdentifier(episode.id) === episodeId)
        || (episodeNumber > 0 && index === episodeNumber - 1)
        || (episodeNumber === 0 && index === 0)
      ));
      if (episodeIndex < 0) continue;
      const episode = line.episodes[episodeIndex];
      if (!episode) continue;
      const latest = this.historyService.get(item.identity) ?? item;
      this.playbackSelection = { lineIndex: line.index, episodeIndex };
      this.historyResume = {
        ...latest,
        lineIndex: line.index,
        episodeIndex,
        lineName: line.name,
        canResume: latest.position > 0 || latest.completed,
      };
      return this.state;
    }
    return this.state;
  }

  public restoreHistoryResumeForContent(vodId: string): DesktopSpiderUiState {
    if (!this.historyService) return this.state;
    const sourceId = sourceIdForHistory(this.session.view.source);
    const item = this.historyService.uiState().items
      .filter((candidate) => candidate.sourceId === sourceId && candidate.vodId === vodId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return item ? this.restoreHistoryResume(item) : this.state;
  }

  public async stopPlayer(): Promise<DesktopSpiderUiState> {
    this.fallbackCoordinator.cancel("用户停止播放");
    this.historyService?.stop();
    this.playerController.stop();
    this.danmakuService?.clear();
    this.sniffer?.cancelAll();
    await this.releasePlaybackProxy();
    await this.session.stopPlayback?.();
    this.playerHost = "embedded";
    this.playbackSession = null;
    return this.state;
  }

  private playPlayer(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
    metadata?: Pick<DesktopPlaybackSession, "lineIndex" | "episodeIndex" | "lineName" | "episodeName">,
    resumeMode?: HistoryResumeMode,
  ): Promise<DesktopSpiderUiState> {
    const request: PlaybackRequest = {
      flag,
      id,
      vipFlags: [...vipFlags],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(metadata ? { metadata: { ...metadata } } : {}),
    };
    this.prepareHistoryForPlayback(request, resumeMode);
    this.currentPlaybackRequest = request;
    this.currentHealthKey = healthKeyFor(request);
    this.fallbackRequests.clear();
    const candidates = this.buildFallbackCandidates(request);
    for (const candidate of candidates) {
      const candidateRequest = this.requestForCandidate(candidate, request);
      if (candidateRequest) this.fallbackRequests.set(candidate.id, candidateRequest);
    }
    this.fallbackCoordinator.begin(candidates);
    return this.runPlayerAttempt(request, true);
  }

  private async runPlayerAttempt(
    request: PlaybackRequest,
    allowFallback: boolean,
  ): Promise<DesktopSpiderUiState> {
    const previousSession = this.playbackSession;
    const previousPlayer = this.playerController.state;
    const carryCurrentTime = previousSession?.lineIndex !== null
      && previousSession?.lineIndex !== undefined
      && request.metadata?.lineIndex !== null
      && request.metadata?.lineIndex !== undefined
      && previousSession.lineIndex !== request.metadata.lineIndex
      ? previousPlayer.currentTime
      : 0;
    this.currentPlaybackRequest = request;
    this.currentHealthKey = healthKeyFor(request);
    if (request.metadata?.lineIndex !== null && request.metadata?.lineIndex !== undefined
      && request.metadata.episodeIndex !== null && request.metadata.episodeIndex !== undefined) {
      this.playbackSelection = {
        lineIndex: request.metadata.lineIndex,
        episodeIndex: request.metadata.episodeIndex,
      };
    }
    this.playbackHealthRegistry.tracker(this.currentHealthKey).beginAttempt();
    this.sourceHealthAttemptStartedAt = Date.now();
    this.sourceHealthPlaybackRecorded = false;
    this.historyService?.flush("stop");
    this.playerController.stop();
    this.danmakuService?.clear();
    this.parseState = initialParseState();
    this.playbackSession = null;
    this.playerHost = "embedded";
    const state = await this.run(
      "player",
      async () => {
        await this.session.stopPlayback?.();
        return this.session.playerContent(request.flag, request.id, request.vipFlags, request.timeoutMs);
      },
      async (response) => {
        this.page = "detail";
        const playback = this.session.view.playback;
        this.playbackDiagnosticsValue = playbackAttemptDiagnostics(
          request,
          response,
          playback,
          undefined,
          this.session.view.api ?? this.session.view.source,
        );
        if (playback.available) {
          const playbackSessionId = randomUUID();
          const source = await this.preparePlayback(playback, playbackSessionId, request.flag, request.id);
          this.playerController.load(source);
          this.playerController.recordStage("DETAIL");
          this.playerController.recordStage("EPISODE");
          this.playerController.recordStage("PLAYER_CONTENT");
          this.playerController.recordStage("MEDIA_RESOLVE");
          this.playerController.recordStage("PROXY_START");
          if (carryCurrentTime > 0) this.playerController.seek(carryCurrentTime);
          else if (this.pendingResumeSeconds > 0) this.playerController.seek(this.pendingResumeSeconds);
          const sourceState = this.playerController.state.source;
          if (!sourceState) throw new Error("Playback source was not loaded");
          if (playback.danmaku !== undefined && this.danmakuService) {
            try {
              await this.danmakuService.load({
                format: "auto",
                data: playback.danmaku,
                source: this.session.view.source,
                timeline: "vod",
              });
            } catch {
              // Optional danmaku must not make an otherwise playable source fail.
              this.danmakuService.clear();
            }
          }
          this.playbackHealthRegistry.tracker(this.currentHealthKey).recordResolve(true);
          this.playbackSession = {
            id: playbackSessionId,
            host: "embedded",
            lineIndex: request.metadata?.lineIndex ?? null,
            episodeIndex: request.metadata?.episodeIndex ?? null,
            lineName: request.metadata?.lineName ?? null,
            episodeName: request.metadata?.episodeName ?? null,
            media: {
              detailId: this.detailItem ? firstText(this.detailItem, ["vod_id", "id", "video_id"]) : null,
              title: this.detailItem ? firstText(this.detailItem, ["vod_name", "name", "title"]) : null,
              url: sourceState.url,
            },
          };
          this.sourceHealth?.recordPlayerSuccess(this.sourceHealthId(), Date.now() - this.sourceHealthAttemptStartedAt);
        }
      },
      allowFallback ? async (failure) => {
        this.sourceHealth?.recordPlayerFailure(this.sourceHealthId(), failure.error, Date.now() - this.sourceHealthAttemptStartedAt);
        this.playbackDiagnosticsValue = playbackAttemptDiagnostics(
          request,
          failure.response,
          this.session.view.playback,
          failure.error,
          this.session.view.api ?? this.session.view.source,
        );
        return this.handlePlaybackFailure(request, failure);
      } : undefined,
    );
    if (state.player.status !== "error" && this.fallbackCoordinator.state.status === "trying") {
      this.fallbackCoordinator.finishAttempt(true);
    }
    return state;
  }

  public async switchSource(): Promise<DesktopSpiderUiState> {
    this.historyService?.appClose();
    this.sniffer?.cancelAll();
    await this.session.destroy();
    this.playerController.stop();
    this.danmakuService?.clear();
    await this.releasePlaybackProxy();
    this.clearPlaybackSession();
    const nextSession = this.createSession?.();
    if (!nextSession) {
      this.localStatus = "destroyed";
      this.localError = null;
      return this.state;
    }

    this.session = nextSession;
    this.page = "import";
    this.activeOperation = null;
    this.localStatus = null;
    this.localError = null;
    this.items = [];
    this.detailItem = null;
    this.clearPlaybackCatalog();
    this.historyResume = null;
    return this.state;
  }

  public async close(): Promise<DesktopSpiderUiState> {
    this.activeOperation = null;
    this.historyService?.appClose();
    this.sniffer?.cancelAll();
    this.parseResolver.close();
    try {
      await this.session.destroy();
      this.playerController.stop();
      this.danmakuService?.clear();
      await this.releasePlaybackProxy();
      this.clearPlaybackSession();
      this.localStatus = "destroyed";
      this.localError = null;
    } catch (error) {
      await this.setError(error);
    }
    return this.state;
  }

  public async releaseResources(): Promise<void> {
    this.historyService?.appClose();
    this.playerController.stop();
    this.danmakuService?.clear();
    this.sniffer?.cancelAll();
    await this.releasePlaybackProxy();
    await this.session.stopPlayback?.();
    this.clearPlaybackSession();
  }

  private async run(
    operation: string,
    request: () => Promise<SpiderResponse>,
    onSuccess: (response: SpiderResponse) => void | Promise<void>,
    onFailure?: (failure: PlaybackFailure) => Promise<boolean>,
  ): Promise<DesktopSpiderUiState> {
    this.activeOperation = operation;
    this.localStatus = "loading";
    this.localError = null;
    try {
      const response = await request();
      if (response.ok) {
        await onSuccess(response);
        this.localStatus = null;
      } else {
        const error = response.error ?? {
          code: "SPIDER_RPC_ERROR",
          message: "Desktop Spider returned an unsuccessful response",
        };
        if (onFailure && await onFailure({ response, error })) return this.state;
        this.localStatus = "error";
        this.localError = error;
        if (operation === "player") {
          await this.releasePlaybackProxy();
          this.clearPlaybackSession();
          this.playerController.markError(error.code, error.message);
        }
      }
    } catch (error) {
      if (onFailure && await onFailure({ error })) return this.state;
      await this.setError(error, operation);
    } finally {
      this.activeOperation = null;
    }
    return this.state;
  }

  private async handlePlaybackFailure(request: PlaybackRequest, failure: PlaybackFailure): Promise<boolean> {
    const trigger = playbackFallbackTrigger(failure.error, failure.response?.error?.code);
    const tracker = this.playbackHealthRegistry.tracker(healthKeyFor(request));
    const code = playbackErrorCode(failure.error) ?? failure.response?.error?.code ?? "PLAYBACK_FAILURE";
    const reason = playbackErrorMessage(failure.error, failure.response?.error?.message ?? "播放失败");
    if (trigger === "player-content-failure" || trigger === "parse-failure") {
      tracker.recordResolve(false);
    } else if (trigger === "proxy-fatal" || trigger === "player-fatal") {
      tracker.recordFatalError(code);
    }
    if (this.fallbackCoordinator.state.mode === "auto" && !isAutoFallbackRetryable(code)) return false;
    const decision = this.fallbackCoordinator.trigger(trigger, reason);
    if (decision.kind !== "attempt") return false;
    const nextRequest = this.fallbackRequests.get(decision.candidate.id);
    if (!nextRequest) {
      this.fallbackCoordinator.stop("回退线路不存在");
      return false;
    }
    this.session.retrySourceHealth?.();
    const nextState = await this.runPlayerAttempt(nextRequest, true);
    return nextState.player.source !== null && nextState.player.status !== "error";
  }

  private prepareHistoryForPlayback(
    request: PlaybackRequest,
    resumeMode?: HistoryResumeMode,
  ): void {
    const context = this.historyContextForRequest(request);
    this.pendingResumeSeconds = 0;
    this.historyResume = null;
    if (!context || !this.historyService) return;
    const candidate = request.metadata?.lineIndex !== null && request.metadata?.lineIndex !== undefined
      && request.metadata.episodeIndex !== null && request.metadata.episodeIndex !== undefined
      ? this.historyService.findResumeForEpisode(context, {
        lineIndex: request.metadata.lineIndex,
        episodeIndex: request.metadata.episodeIndex,
        lineName: request.metadata.lineName ?? context.playbackLine ?? "当前线路",
        episodeName: request.metadata.episodeName ?? context.episodeName ?? "当前集数",
        episodeId: context.identity.episodeId ?? request.id,
      })
      : null;
    this.historyService.begin(context);
    if (resumeMode === "continue" && candidate) this.pendingResumeSeconds = candidate.position;
    if (resumeMode === "beginning" && candidate) this.historyService.deleteProgress(candidate.identity);
  }

  private historyContextForRequest(request: PlaybackRequest) {
    const detail = this.detailItem;
    if (!detail) return null;
    const vodId = firstText(detail, ["vod_id", "id", "video_id"]);
    if (!vodId) return null;
    return createHistoryContext({
      source: this.session.view.source,
      vodId,
      episodeId: request.id,
      title: firstText(detail, ["vod_name", "name", "title"]),
      poster: firstText(detail, ["vod_pic", "poster", "image"]),
      episode: request.metadata?.episodeIndex === null || request.metadata?.episodeIndex === undefined
        ? null
        : request.metadata.episodeIndex + 1,
      ...(request.metadata?.episodeName === undefined ? {} : { episodeName: request.metadata.episodeName }),
      playbackLine: request.metadata?.lineName ?? request.flag,
    });
  }

  private findDetailResume(): HistoryResumeCandidate | null {
    if (!this.historyService || !this.detailItem || !this.playbackCatalog) return null;
    const vodId = firstText(this.detailItem, ["vod_id", "id", "video_id"]);
    if (!vodId) return null;
    const episodes: HistoryCatalogEpisode[] = this.playbackCatalog.lines.flatMap((line) => line.episodes.map((episode) => ({
      lineIndex: line.index,
      episodeIndex: episode.index,
      lineName: line.name,
      episodeName: episode.name,
      episodeId: episode.id,
    })));
    return this.historyService.findResumeForDetail(this.session.view.source, vodId, episodes);
  }

  private recordMediaEvent(patch: PlaybackMediaSync): void {
    const tracker = this.playbackHealthRegistry.tracker(this.currentHealthKey);
    if (patch.currentTime !== undefined && Number.isFinite(patch.currentTime)) {
      tracker.recordPlaybackDuration(Math.max(0, patch.currentTime));
    }
    const event = patch.event;
    if (!event) {
      if (patch.status === "playing") tracker.recordFirstFrame();
      if (patch.error) {
        void this.triggerMediaFailure(playbackFallbackTrigger(patch.error, patch.error.code), patch.error.message, patch.error.code);
      }
      return;
    }
    switch (event.type) {
      case "first-frame":
        tracker.recordFirstFrame(event.at);
        if (!this.sourceHealthPlaybackRecorded) {
          this.sourceHealthPlaybackRecorded = true;
          this.sourceHealth?.recordPlaybackSuccess(this.sourceHealthId(), Date.now() - this.sourceHealthAttemptStartedAt);
        }
        break;
      case "startup-timeout":
        tracker.recordStartupFailure(event.reason, event.at);
        void this.triggerMediaFailure("startup-timeout", event.reason ?? "起播超时");
        break;
      case "buffer-start":
        tracker.recordBufferStart(event.at);
        break;
      case "buffer-end":
        tracker.recordBufferEnd(event.at);
        break;
      case "fatal-error":
        tracker.recordFatalError(event.code, event.at);
        this.sourceHealth?.recordPlaybackFailure(this.sourceHealthId(), { code: event.code ?? "PLAYER_FATAL_ERROR" }, Date.now() - this.sourceHealthAttemptStartedAt);
        void this.triggerMediaFailure("player-fatal", event.code ?? "播放器致命错误");
        break;
      case "segment-failure":
        tracker.recordSegmentFailure(event.reason, event.at);
        this.sourceHealth?.recordPlaybackFailure(this.sourceHealthId(), { code: "HLS_SEGMENT_FAILED" }, Date.now() - this.sourceHealthAttemptStartedAt);
        if (tracker.shouldTriggerSegmentFailure()) {
          void this.triggerMediaFailure("segment-errors", event.reason ?? "连续分片错误");
        }
        break;
      case "playlist-refresh-failure":
      case "disconnect":
        break;
      case "http-status":
        tracker.recordHttpStatus(event.status ?? 0, event.at);
        if ((event.status ?? 0) >= 500) {
          void this.triggerMediaFailure("proxy-fatal", `HTTP ${event.status}`, `MEDIA_HTTP_${event.status}`);
        }
        break;
      case "completion":
        tracker.recordCompletion(event.at);
        void this.onPlaybackComplete?.();
        break;
      case "user-pause":
        tracker.recordUserPause(event.at);
        break;
      case "seek":
        tracker.recordSeek(event.at);
        break;
    }
  }

  private async triggerMediaFailure(trigger: PlaybackFallbackTrigger, reason: string, codeHint?: string): Promise<void> {
    const request = this.currentPlaybackRequest;
    if (!request) return;
    const code = codeHint ?? mediaFailureCode(trigger);
    if (this.fallbackCoordinator.state.mode === "auto" && !isAutoFallbackRetryable(code)) return;
    const decision = this.fallbackCoordinator.trigger(trigger, reason);
    if (decision.kind !== "attempt") return;
    const nextRequest = this.fallbackRequests.get(decision.candidate.id);
    if (!nextRequest) {
      this.fallbackCoordinator.stop("回退线路不存在");
      return;
    }
    const task = this.runPlayerAttempt(nextRequest, true).then(() => undefined);
    this.pendingFallback = task;
    try {
      await task;
    } finally {
      if (this.pendingFallback === task) this.pendingFallback = null;
    }
  }

  private sourceHealthId(): string {
    return this.session.view.api?.trim() || this.session.view.source;
  }

  private buildFallbackCandidates(request: PlaybackRequest): FallbackCandidate[] {
    const candidates: FallbackCandidate[] = [
      { id: "current-retry", label: "当前线路重试", kind: "retry-current", sourceId: this.session.view.source, parseAttempt: 0 },
      { id: "current-reparse", label: "当前线路重新解析", kind: "reparse-current", sourceId: this.session.view.source, parseAttempt: 1 },
    ];
    const currentLine = request.metadata?.lineIndex ?? null;
    const currentEpisode = request.metadata?.episodeIndex ?? null;
    const currentScore = this.playbackHealthRegistry.score(healthKeyFor(request));
    for (const line of this.playbackCatalog?.lines ?? []) {
      for (const episode of line.episodes) {
        if (line.index === currentLine && episode.index === currentEpisode) continue;
        const alternateRequest: PlaybackRequest = {
          ...request,
          flag: line.name,
          id: episode.id,
          metadata: {
            lineIndex: line.index,
            episodeIndex: episode.index,
            lineName: line.name,
            episodeName: episode.name,
          },
        };
        const score = this.playbackHealthRegistry.score(healthKeyFor(alternateRequest));
        candidates.push({
          id: `line:${line.index}:episode:${episode.index}`,
          label: `${line.name} · ${episode.name}`,
          kind: score !== null && (currentScore === null || score > currentScore) ? "healthier" : "same-content",
          healthScore: score,
          sourceId: this.session.view.source,
          lineKey: String(line.index),
        });
      }
    }
    return candidates;
  }

  private requestForCandidate(candidate: FallbackCandidate, current: PlaybackRequest): PlaybackRequest | null {
    if (candidate.kind === "retry-current" || candidate.kind === "reparse-current") {
      return { ...current, vipFlags: [...current.vipFlags], ...(current.metadata ? { metadata: { ...current.metadata } } : {}) };
    }
    const match = /^line:(\d+):episode:(\d+)$/.exec(candidate.id);
    if (!match) return null;
    const line = this.playbackCatalog?.lines.find((item) => item.index === Number(match[1]));
    const episode = line?.episodes.find((item) => item.index === Number(match[2]));
    if (!line || !episode) return null;
    return {
      ...current,
      flag: line.name,
      id: episode.id,
      vipFlags: [...current.vipFlags],
      metadata: {
        lineIndex: line.index,
        episodeIndex: episode.index,
        lineName: line.name,
        episodeName: episode.name,
      },
    };
  }

  private publicPlaybackHealth(): PlaybackHealthSnapshot {
    return {
      ...this.playbackHealthRegistry.snapshot(this.currentHealthKey),
      sourceId: "当前播放线路",
    };
  }

  private async setError(error: unknown, operation?: string): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error
      && (error.name === "JvmSidecarTimeoutError" || /timeout/i.test(message));
    const sessionError = this.session.view.error;
    const thrownCode = isRecord(error) && typeof error.code === "string" ? error.code : null;
    const code = sessionError?.code ?? thrownCode ?? (isTimeout ? "SPIDER_TIMEOUT" : "SPIDER_RUNTIME_ERROR");
    const displayMessage = sessionError?.message ?? message;
    this.localStatus = "error";
    this.localError = {
      code,
      message: displayMessage,
    };
    if (operation === "player") {
      await this.releasePlaybackProxy();
      this.clearPlaybackSession();
      this.playerController.markError(code, displayMessage);
    }
  }

  private async preparePlayback(
    playback: Extract<DesktopSpiderPlaybackState, { available: true }>,
    playbackSessionId: string,
    flag: string,
    episodeId: string,
  ): Promise<PlaybackSource> {
    await this.releasePlaybackProxy();
    let resolved = {
      parse: playback.parse,
      url: playback.url,
      headers: { ...playback.headers },
    };
    let parsedThroughResolver = false;
    if (playback.parse === 1 || playback.jx === 1) {
      this.parseState = { ...initialParseState(), status: "resolving" };
      try {
        const parsed = await this.parseResolver.resolve({
          sourceId: this.session.view.source,
          flag,
          originalUrl: playback.url,
          parserCandidates: this.parserCandidates,
          headers: playback.headers,
          timeout: 15_000,
          playbackSessionId,
          parse: 1,
          onAttempt: (attempt) => {
            this.parseState = {
              status: "attempting",
              parserId: attempt.parserId,
              attempts: [...this.parseState.attempts, { ...attempt }],
              error: null,
            };
          },
        } satisfies ParseRequest);
        this.parseState = {
          status: "succeeded",
          parserId: parsed.parserId,
          attempts: parsed.attempts.map((attempt) => ({ ...attempt })),
          error: null,
        };
        resolved = parsed;
        parsedThroughResolver = true;
      } catch (error) {
        const parseError = error instanceof ParseChainError
          ? error
          : new ParseChainError("PARSE_ERROR", error instanceof Error ? error.message : String(error));
        if (!this.sniffer) {
          this.parseState = {
            status: parseError.code === "PARSE_CANCELLED" ? "cancelled" : "failed",
            parserId: this.parseState.parserId,
            attempts: parseError.attempts.map((attempt) => ({ ...attempt })),
            error: { code: parseError.code, message: parseError.message },
          };
          throw parseError;
        }
        try {
          const mediaOrigin = httpOrigin(playback.url);
          const sniffed = await this.sniffer.sniff({
            sourceId: this.session.view.source,
            playbackSessionId,
            initialUrl: playback.url,
            headers: sanitizeSnifferHeaders(playback.headers),
            allowedOrigins: [
              ...this.parserAllowedOrigins,
              ...(mediaOrigin ? [mediaOrigin] : []),
            ],
          });
          this.parseState = {
            status: "succeeded",
            parserId: "isolated-sniffer",
            attempts: parseError.attempts.map((attempt) => ({ ...attempt })),
            error: null,
          };
          resolved = {
            parse: 0,
            url: sniffed.url,
            headers: sanitizeSnifferHeaders(playback.headers, sniffed.headers),
          };
          parsedThroughResolver = true;
        } catch (snifferError) {
          const snifferCode = isRecord(snifferError) && typeof snifferError.code === "string"
            ? snifferError.code
            : "SNIFF_ERROR";
          const snifferMessage = snifferError instanceof Error ? snifferError.message : String(snifferError);
          this.parseState = {
            status: snifferCode === "SNIFF_CANCELLED" ? "cancelled" : "failed",
            parserId: "isolated-sniffer",
            attempts: parseError.attempts.map((attempt) => ({ ...attempt })),
            error: { code: snifferCode, message: snifferMessage },
          };
          throw snifferError;
        }
      }
    } else if (playback.parse !== 0) {
      throw new Error(`Unsupported playback parse mode: ${playback.parse}`);
    } else {
      this.parseState = {
        status: "succeeded",
        parserId: "direct",
        attempts: [],
        error: null,
      };
    }
    const resolvedJx = parsedThroughResolver ? 0 : playback.jx ?? 0;
    const playerResult: QxPlayerResult = {
      parse: 0,
      url: resolved.url,
      headers: { ...resolved.headers },
      // ParseManager and MediaResolver have already reduced this to a direct
      // media URL, so the unified result must not re-enter the parse branch.
      jx: resolvedJx,
      sourceKey: playback.sourceKey ?? this.session.view.source,
      sourceName: playback.sourceName ?? this.session.view.api ?? this.session.view.source,
      episodeId: playback.episodeId ?? episodeId,
      ...(playback.playUrl ? { playUrl: playback.playUrl } : {}),
      ...(playback.format ? { format: playback.format } : {}),
      ...(playback.flag ? { flag: playback.flag } : {}),
      ...(playback.jxFrom ? { jxFrom: playback.jxFrom } : {}),
    };
    const resolvedMedia = await this.mediaResolver.resolve(playerResult, {
      playbackSessionId,
      sourceKey: playerResult.sourceKey,
      sourceName: playerResult.sourceName,
      episodeId: playerResult.episodeId,
    });
    this.proxySession = resolvedMedia.proxySession;
    const baseMediaSource: PlaybackSource = {
      parse: 0,
      url: resolvedMedia.url,
      headers: { ...resolvedMedia.headers },
      mediaType: resolvedMedia.mediaType,
      jx: resolvedJx,
    };
    const mediaSource: PlaybackSource = {
      ...baseMediaSource,
      ...(playback.playUrl ? { playUrl: playback.playUrl } : {}),
      ...(playback.format ? { format: playback.format } : {}),
      ...(playback.flag ? { flag: playback.flag } : {}),
      ...(playback.jxFrom ? { jxFrom: playback.jxFrom } : {}),
    };
    const subtitles = await this.prepareSubtitleTracks(playback.subtitles ?? [], playbackSessionId);
    return subtitles.length > 0 ? { ...mediaSource, subtitles } : mediaSource;
  }

  private async createMediaProxy(
    resolved: { url: string; headers: Record<string, string> },
    playbackSessionId: string,
  ): Promise<PlaybackSource> {
    this.proxySession = await this.playbackProxy.createSession({
      parse: 0,
      url: resolved.url,
      headers: resolved.headers,
      sourceId: this.session.view.source,
      playbackSessionId,
    });
    return { parse: 0, url: this.proxySession.url, headers: {} };
  }

  private async prepareSubtitleTracks(
    tracks: readonly SubtitleTrack[],
    playbackSessionId: string,
  ): Promise<SubtitleTrack[]> {
    const prepared: SubtitleTrack[] = [];
    for (const track of tracks) {
      if (track.localPath) {
        throw new SubtitlePreparationError(
          "SUBTITLE_LOCAL_FILE_SELECTION_REQUIRED",
          "本地字幕必须由用户在播放器中选择，不能接受来源返回的本机路径。",
        );
      }
      if (track.url && !/^https?:/i.test(track.url)) {
        throw new SubtitlePreparationError(
          "SUBTITLE_PROTOCOL_UNSUPPORTED",
          "远程字幕地址必须使用 HTTP(S)，本地字幕请由用户选择文件。",
        );
      }
      if (!isRemoteSubtitleTrack(track)) {
        prepared.push(cloneSubtitleTrack(track));
        continue;
      }
      const proxy = await this.playbackProxy.createSession({
        parse: 0,
        url: track.url,
        headers: { ...(track.headers ?? {}) },
        sourceId: this.session.view.source,
        playbackSessionId,
      });
      this.subtitleProxySessions.push(proxy);
      const { headers: _headers, ...safeTrack } = track;
      prepared.push({ ...safeTrack, url: proxy.url, source: "local-proxy" });
    }
    return prepared;
  }

  private async releasePlaybackProxy(): Promise<void> {
    const session = this.proxySession;
    this.proxySession = undefined;
    if (session) await session.close();
    const subtitles = this.subtitleProxySessions.splice(0);
    for (const subtitle of subtitles) await subtitle.close();
    await this.playbackProxy.close();
  }

  private clearPlaybackCatalog(): void {
    this.playbackCatalog = null;
    this.playbackSelection = null;
  }

  private clearPlaybackSession(): void {
    this.playerHost = "embedded";
    this.playbackSession = null;
  }
}

export interface DesktopSpiderUiServerOptions {
  ui?: DesktopSpiderUiController;
  importer?: DesktopSpiderImportController;
  stateStore?: DesktopStateStorePort;
  onPlayerOpen?: () => void | Promise<void>;
  onPlayerAttach?: () => void | Promise<void>;
  onPlayerStop?: () => void | Promise<void>;
  rendererDirectory?: string;
  siteKey?: string;
  ext?: string;
  host?: string;
  port?: number;
  playbackProxyOrigins?: readonly string[];
  parserCandidates?: readonly ParserCandidate[];
  parserAllowedOrigins?: readonly string[];
  parserFetch?: typeof fetch;
  playbackFetch?: typeof fetch;
  playbackRules?: readonly PlaybackRule[];
  sniffer?: IsolatedSniffer;
  playbackFallbackMode?: PlaybackFallbackMode;
  playbackFallbackMaxAttempts?: number;
  playbackFallbackTimeoutMs?: number;
  history?: HistoryProgressService;
  favorites?: FavoritesService;
  follow?: FollowService;
  cache?: CacheService;
  storage?: DataStorageService;
  danmaku?: DanmakuService;
  localMedia?: LocalMediaService;
  downloads?: DownloadService;
  push?: PushService;
  cast?: CastService;
  onStorageOpen?: () => void | Promise<void>;
  onStorageSwitch?: (mode: StorageMode) => void;
  onBackupCreate?: (includeCache: boolean) => Promise<BackupUiState>;
  onBackupPick?: () => Promise<BackupUiState>;
  onBackupApply?: () => void | Promise<void>;
  onBackupClear?: () => void;
  onBackupOpen?: () => void | Promise<void>;
  onLocalFilePicker?: () => Promise<readonly string[]>;
  onLocalFolderPicker?: () => Promise<string | null>;
  onDownloadFolderPicker?: () => Promise<string | null>;
  onDownloadFolderOpen?: (directoryPath: string) => void | Promise<void>;
}

export class DesktopSpiderUiServer {
  private readonly directUi: DesktopSpiderUiController | undefined;
  private readonly importer: DesktopSpiderImportController | undefined;
  private readonly stateStore: DesktopStateStorePort | undefined;
  private readonly onPlayerOpen: (() => void | Promise<void>) | undefined;
  private readonly onPlayerAttach: (() => void | Promise<void>) | undefined;
  private readonly onPlayerStop: (() => void | Promise<void>) | undefined;
  private readonly rendererDirectory: string | undefined;
  private readonly siteKey: string | undefined;
  private readonly ext: string | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly playbackProxyOrigins: readonly string[] | undefined;
  private readonly parserCandidates: readonly ParserCandidate[] | undefined;
  private readonly parserAllowedOrigins: readonly string[] | undefined;
  private readonly parserFetch: typeof fetch | undefined;
  private readonly playbackFetch: typeof fetch | undefined;
  private readonly playbackRules: readonly PlaybackRule[] | undefined;
  private readonly sniffer: IsolatedSniffer | undefined;
  private readonly playbackFallbackMode: PlaybackFallbackMode | undefined;
  private readonly playbackFallbackMaxAttempts: number | undefined;
  private readonly playbackFallbackTimeoutMs: number | undefined;
  private readonly historyService: HistoryProgressService | undefined;
  private readonly favoritesService: FavoritesService | undefined;
  private readonly followService: FollowService | undefined;
  private readonly cacheService: CacheService | undefined;
  private readonly posterProxy: PosterProxy;
  private readonly storageService: DataStorageService | undefined;
  private readonly danmakuService: DanmakuService | undefined;
  private readonly localMediaService: LocalMediaService | undefined;
  private readonly downloadService: DownloadService | undefined;
  private readonly pushService: PushService | undefined;
  private readonly castService: CastService | undefined;
  private readonly onStorageOpen: (() => void | Promise<void>) | undefined;
  private readonly onStorageSwitch: ((mode: StorageMode) => void) | undefined;
  private readonly onBackupCreate: ((includeCache: boolean) => Promise<BackupUiState>) | undefined;
  private readonly onBackupPick: (() => Promise<BackupUiState>) | undefined;
  private readonly onBackupApply: (() => void | Promise<void>) | undefined;
  private readonly onBackupClear: (() => void) | undefined;
  private readonly onBackupOpen: (() => void | Promise<void>) | undefined;
  private backupState: BackupUiState = EMPTY_BACKUP_UI_STATE;
  private readonly onLocalFilePicker: (() => Promise<readonly string[]>) | undefined;
  private readonly onLocalFolderPicker: (() => Promise<string | null>) | undefined;
  private readonly onDownloadFolderPicker: (() => Promise<string | null>) | undefined;
  private readonly onDownloadFolderOpen: ((directoryPath: string) => void | Promise<void>) | undefined;
  private server: Server | undefined;
  private boundUrl: string | undefined;
  private boundSession: DesktopSpiderSessionPort | undefined;
  private importedUi: DesktopSpiderUiController | undefined;
  private readonly importedUiBySession = new Map<DesktopSpiderSessionPort, DesktopSpiderUiController>();

  public constructor(options: DesktopSpiderUiServerOptions) {
    if ((options.ui === undefined) === (options.importer === undefined)) {
      throw new Error("Desktop Spider UI server needs exactly one of ui or importer");
    }
    if (options.importer === undefined && (options.siteKey === undefined || options.ext === undefined)) {
      throw new Error("Direct Desktop Spider UI server needs siteKey and ext");
    }
    this.directUi = options.ui;
    this.importer = options.importer;
    this.stateStore = options.stateStore;
    this.onPlayerOpen = options.onPlayerOpen;
    this.onPlayerAttach = options.onPlayerAttach;
    this.onPlayerStop = options.onPlayerStop;
    this.rendererDirectory = options.rendererDirectory
      ? resolvePath(options.rendererDirectory)
      : undefined;
    this.siteKey = options.siteKey;
    this.ext = options.ext;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.playbackProxyOrigins = options.playbackProxyOrigins;
    this.parserCandidates = options.parserCandidates?.map(cloneParserCandidate);
    this.parserAllowedOrigins = options.parserAllowedOrigins;
    this.parserFetch = options.parserFetch;
    this.playbackFetch = options.playbackFetch;
    this.playbackRules = options.playbackRules;
    this.sniffer = options.sniffer;
    this.playbackFallbackMode = options.playbackFallbackMode;
    this.playbackFallbackMaxAttempts = options.playbackFallbackMaxAttempts;
    this.playbackFallbackTimeoutMs = options.playbackFallbackTimeoutMs;
    this.historyService = options.history;
    this.favoritesService = options.favorites;
    this.followService = options.follow;
    this.cacheService = options.cache;
    this.posterProxy = new PosterProxy({ ...(this.cacheService ? { cache: this.cacheService } : {}) });
    this.storageService = options.storage;
    this.danmakuService = options.danmaku;
    this.localMediaService = options.localMedia;
    this.downloadService = options.downloads;
    this.pushService = options.push;
    this.castService = options.cast;
    this.directUi?.setPlaybackCompleteHandler(() => this.pushService?.drainQueue());
    this.onStorageOpen = options.onStorageOpen;
    this.onStorageSwitch = options.onStorageSwitch;
    this.onBackupCreate = options.onBackupCreate;
    this.onBackupPick = options.onBackupPick;
    this.onBackupApply = options.onBackupApply;
    this.onBackupClear = options.onBackupClear;
    this.onBackupOpen = options.onBackupOpen;
    this.onLocalFilePicker = options.onLocalFilePicker;
    this.onLocalFolderPicker = options.onLocalFolderPicker;
    this.onDownloadFolderPicker = options.onDownloadFolderPicker;
    this.onDownloadFolderOpen = options.onDownloadFolderOpen;
  }

  public get url(): string {
    if (!this.boundUrl) throw new Error("Desktop Spider UI server is not running");
    return this.boundUrl;
  }

  public get resourceCounts(): { playbackProxySessions: number; snifferSessions: number } {
    const controllers = this.importer
      ? [...this.importedUiBySession.values()]
      : this.directUi
        ? [this.directUi]
        : [];
    return {
      playbackProxySessions: controllers.reduce((total, ui) => total + ui.playbackProxySessionCount, 0),
      snifferSessions: this.sniffer?.activeSessionCount ?? 0,
    };
  }

  public attachPlayerHost(): DesktopSpiderUiState | null {
    return this.activeUi()?.attachPlayer() ?? null;
  }

  /**
   * The Web control surface is deliberately an allowlisted adapter. It does
   * not expose the renderer state object or route arbitrary HTTP requests into
   * the desktop UI server.
   */
  public webControlBackend(): WebControlBackend {
    return {
      snapshot: () => this.webControlSnapshot(),
      play: async ({ flag, id, vipFlags }) => {
        const ui = this.playbackUi() ?? this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_UI_UNAVAILABLE");
        await ui.player(flag, id, [...vipFlags]);
      },
      pause: async () => {
        const ui = this.playbackUi() ?? this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_PLAYBACK_UNAVAILABLE");
        await ui.syncPlayerStateAsync({ status: "paused" });
      },
      stop: async () => {
        const ui = this.playbackUi() ?? this.activeUi();
        if (ui) await ui.stopPlayer();
      },
      seek: async (position) => {
        const ui = this.playbackUi() ?? this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_PLAYBACK_UNAVAILABLE");
        await ui.syncPlayerStateAsync({ currentTime: position });
      },
      volume: async (volume, muted) => {
        const ui = this.playbackUi() ?? this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_PLAYBACK_UNAVAILABLE");
        await ui.syncPlayerStateAsync({
          volume,
          ...(muted === undefined ? {} : { muted }),
        });
      },
      search: async (query) => {
        const ui = this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_SEARCH_UNAVAILABLE");
        return toWebSearchResult(query, (await ui.search(query)).items);
      },
      detail: async (id) => {
        const ui = this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_DETAIL_UNAVAILABLE");
        const state = await ui.detail(id);
        return toWebDetail(id, state.detail, state.playbackCatalog);
      },
      playEpisode: async ({ lineIndex, episodeIndex, vipFlags }) => {
        const ui = this.activeUi();
        if (!ui) throw webControlUnavailable("WEB_PLAYBACK_UNAVAILABLE");
        await ui.playEpisode(lineIndex, episodeIndex, [...vipFlags]);
      },
      push: async ({ url, title }) => {
        if (!this.pushService) throw webControlUnavailable("WEB_PUSH_UNAVAILABLE");
        const result = await this.pushService.submit({
          type: "url",
          url,
          requestedBy: "user",
          ...(title === undefined ? {} : { title }),
        });
        return toWebPushResult(result);
      },
      downloads: () => toWebDownloads(this.downloadService?.uiState()),
      castDevices: () => toWebCastState(this.castService?.uiState()),
      cast: async (deviceId) => {
        if (!this.castService) throw webControlUnavailable("WEB_CAST_UNAVAILABLE");
        const ui = this.playbackUi() ?? this.activeUi();
        const player = ui?.state.player;
        const source = player?.source;
        if (!source) throw webControlUnavailable("WEB_CAST_NO_MEDIA");
        const title = ui?.state.playbackSession?.media.title ?? "QX 影视媒体";
        const media: CastMediaSource = {
          url: source.url,
          title,
          headers: { ...source.headers },
          ...(source.url.includes(".m3u8") ? { contentType: "application/vnd.apple.mpegurl" } : {}),
        };
        await this.castService.cast({ deviceId, media });
      },
      safeStatus: () => this.webControlStatus(),
    };
  }

  private webControlSnapshot(): WebControlSnapshot {
    return {
      nowPlaying: this.webControlNowPlaying(),
      search: { query: "", items: [] },
      downloads: toWebDownloads(this.downloadService?.uiState()),
      cast: toWebCastState(this.castService?.uiState()),
      status: this.webControlStatus(),
    };
  }

  private webControlNowPlaying(): WebControlNowPlaying {
    const ui = this.playbackUi() ?? this.activeUi();
    return toWebNowPlaying(
      ui?.state.player ?? null,
      ui?.state.playbackSession?.media.title ?? null,
      ui?.state.playbackSession?.episodeName ?? null,
    );
  }

  private webControlStatus(): WebControlBackendStatus {
    const ui = this.activeUi();
    return {
      uiReady: Boolean(ui),
      capabilities: {
        search: Boolean(ui),
        playback: Boolean(ui?.state.canPlay),
        push: Boolean(this.pushService),
        downloads: Boolean(this.downloadService),
        cast: Boolean(this.castService),
      },
      lanControl: "disabled",
    };
  }

  public async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.boundUrl = `http://${this.host}:${address.port}/`;
    try {
      await this.pushService?.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.castService?.close();
    await this.pushService?.close();
    if (this.importer) {
      await this.releaseImportedUiResources();
      await this.importer.close();
      this.importedUiBySession.clear();
    } else {
      await this.directUi?.close();
    }
    await this.sniffer?.close();
    const server = this.server;
    this.server = undefined;
    this.boundUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  public pushPlaybackSession(): PushPlaybackSessionSnapshot | null {
    const ui = this.playbackUi();
    if (ui && ["ended", "stopped", "error"].includes(ui.state.player.status)) return null;
    const session = ui?.state.playbackSession;
    if (!session) return null;
    return {
      id: session.id,
      kind: "vod",
      title: session.media.title,
      state: "active",
    };
  }

  public async replacePush(request: PushRequest): Promise<PushPlaybackSessionSnapshot> {
    const current = this.playbackUi();
    await current?.stopPlayer();
    if (request.type === "url" || request.type === "fixture") {
      if (request.type === "fixture" && !request.url) {
        throw new PushServiceError("PUSH_FIXTURE_UNAVAILABLE", "Push fixture 没有可播放地址。");
      }
      const ui = this.activeUi();
      if (!ui) throw new PushServiceError("PUSH_PLAYBACK_UNAVAILABLE", "当前没有可用的点播播放会话。");
      await ui.playPushUrl({
        type: "url",
        url: request.url ?? "",
        requestedBy: request.requestedBy,
        ...(request.title ? { title: request.title } : {}),
        ...(request.headers ? { headers: { ...request.headers } } : {}),
      });
    } else if (request.type === "source-item") {
      const ui = this.activeUi();
      if (!ui) throw new PushServiceError("PUSH_PLAYBACK_UNAVAILABLE", "当前没有可用的点播播放会话。");
      const reference = request.sourceReference;
      await ui.playPushSourceItem(reference);
    } else if (request.type === "local-file") {
      const ui = this.activeUi();
      if (!ui) throw new PushServiceError("PUSH_PLAYBACK_UNAVAILABLE", "当前没有可用的点播播放会话。");
      await ui.playLocalMedia(request.localFileReference.itemId, this.url);
    }
    const session = this.pushPlaybackSession();
    if (!session) throw new PushServiceError("PUSH_PLAYBACK_FAILED", "Push 播放会话未能建立。");
    return session;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.url);
      if (request.method === "GET" && await this.posterProxy.handle(url.pathname, response)) return;
      if (request.method === "GET" && this.localMediaService && url.pathname.startsWith("/api/local-media/")) {
        this.writeLocalMediaStream(request, response, url.pathname);
        return;
      }
      if (request.method === "GET"
        && this.rendererDirectory
        && !url.pathname.startsWith("/api/")) {
        if (this.writeRendererAsset(response, url.pathname)) return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const ui = this.activeUi();
        if (this.importer && (this.importer.state.status !== "ready" || !ui)) {
          writeHtml(response, renderDesktopSpiderImportUi(this.importer.state));
        } else if (ui) {
          writeHtml(response, renderDesktopSpiderUi(this.visibleState(ui) ?? ui.state));
        } else {
          writeJson(response, { error: "Import UI is not ready" }, 409);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/hls.min.js") {
        this.writeHlsAsset(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        this.writeCurrentState(response);
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, { error: "Not found" }, 404);
        return;
      }

      const body = await readJson(request);
      if (url.pathname.startsWith("/api/push/")) {
        await this.handlePushRequest(url.pathname, body);
        this.writeCurrentState(response);
        return;
      }
      if (url.pathname.startsWith("/api/cast/")) {
        await this.handleCastRequest(url.pathname, body);
        this.writeCurrentState(response);
        return;
      }
      if (url.pathname.startsWith("/api/downloads/")) {
        await this.handleDownloadRequest(url.pathname, body);
        this.writeCurrentState(response);
        return;
      }
      if (url.pathname.startsWith("/api/local-media/")) {
        await this.handleLocalMediaRequest(url.pathname, body);
        this.writeCurrentState(response);
        return;
      }
      if (url.pathname.startsWith("/api/danmaku/")) {
        await this.handleDanmakuRequest(url.pathname, body);
        this.writeCurrentState(response);
        return;
      }
      if (this.importer && url.pathname.startsWith("/api/import/")) {
        switch (url.pathname) {
          case "/api/import/load":
            await this.releaseImportedUiResources();
            await this.importer.import(stringValue(body.input, ""));
            this.persistImportedSite(this.importer.selectedSiteKey);
            break;
          case "/api/import/select":
            this.importer.selectSite(stringValue(body.siteKey, ""));
            this.persistImportedSite(this.importer.selectedSiteKey);
            break;
          case "/api/import/site-enabled":
            this.importer.setSiteEnabled(stringValue(body.siteKey, ""), booleanValue(body.enabled, false));
            break;
          case "/api/import/site-search":
            this.importer.setSiteSearchEnabled(stringValue(body.siteKey, ""), booleanValue(body.enabled, false));
            break;
          case "/api/import/site-alias":
            this.importer.setSiteAlias(stringValue(body.siteKey, ""), stringValue(body.alias, ""));
            break;
          case "/api/import/site-clear-cache":
            this.importer.clearSiteCache(stringValue(body.siteKey, ""));
            break;
          case "/api/import/site-reinitialize":
            await this.importer.reinitializeSite(stringValue(body.siteKey, ""));
            break;
          case "/api/import/site-retry":
            this.importer.retrySite(stringValue(body.siteKey, ""));
            break;
          case "/api/import/site-reorder":
            this.importer.reorderSites(stringList(body.siteKeys));
            break;
          case "/api/import/refresh":
            await this.importer.refreshConfiguration();
            break;
          case "/api/import/refresh-approve":
            await this.importer.approveConfigurationRefresh(
              typeof body.versionId === "string" ? body.versionId : undefined,
            );
            break;
          case "/api/import/refresh-reject":
            this.importer.rejectConfigurationRefresh();
            break;
          case "/api/import/confirm":
            this.importer.confirm();
            break;
          case "/api/import/cancel":
            await this.importer.cancel();
            break;
          default:
            writeJson(response, { error: "Not found" }, 404);
            return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname === "/api/view-state") {
        this.stateStore?.patch(statePatchFromRequest(body));
        const ui = this.activeUi();
        if (typeof body.scrollTop === "number" && Number.isFinite(body.scrollTop)) {
          ui?.setScrollTop(body.scrollTop);
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname.startsWith("/api/history/")) {
        const historyService = this.historyService;
        if (!historyService) throw new Error("HISTORY_UNAVAILABLE");
        if (url.pathname === "/api/history/delete") {
          historyService.delete(stringValue(body.identity, ""));
          this.activeUi()?.clearHistoryResume();
        } else if (url.pathname === "/api/history/delete-progress") {
          historyService.deleteProgress(stringValue(body.identity, ""));
          this.activeUi()?.clearHistoryResume();
        } else if (url.pathname === "/api/history/clear") {
          const identities = stringList(body.identities);
          if (identities.length === 0) historyService.clear();
          else historyService.deleteMany(identities);
        } else if (url.pathname === "/api/history/pause") {
          historyService.setPaused(booleanValue(body.paused, false));
        } else if (url.pathname === "/api/history/open") {
          const item = historyService.get(stringValue(body.identity, ""));
          if (!item) throw new Error("HISTORY_NOT_FOUND");
          const ui = this.activeUi();
          if (!ui) throw new Error("HISTORY_SOURCE_SWITCH_REQUIRED");
          if (sourceIdForHistory(ui.state.source) !== item.sourceId) {
            throw new Error("HISTORY_SOURCE_SWITCH_REQUIRED");
          }
          await ui.detail(item.vodId);
          ui.restoreHistoryResume(item);
        } else {
          writeJson(response, { error: "Not found" }, 404);
          return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname.startsWith("/api/favorites/")) {
        const favoritesService = this.favoritesService;
        if (!favoritesService) throw new Error("FAVORITES_UNAVAILABLE");
        if (url.pathname === "/api/favorites/toggle-detail") {
          const ui = this.activeUi();
          if (!ui) throw new Error("FAVORITE_DETAIL_REQUIRED");
          ui.toggleFavorite();
        } else if (url.pathname === "/api/favorites/move-detail") {
          const ui = this.activeUi();
          if (!ui) throw new Error("FAVORITE_DETAIL_REQUIRED");
          ui.moveFavorite(stringValue(body.groupId, ""));
        } else if (url.pathname === "/api/favorites/delete") {
          favoritesService.delete(stringValue(body.favoriteId, ""));
        } else if (url.pathname === "/api/favorites/move") {
          favoritesService.move(stringValue(body.favoriteId, ""), stringValue(body.groupId, ""));
        } else if (url.pathname === "/api/favorites/reorder") {
          favoritesService.reorder(stringValue(body.groupId, ""), stringList(body.favoriteIds));
        } else if (url.pathname === "/api/favorites/group/create") {
          favoritesService.createGroup(stringValue(body.name, ""));
        } else if (url.pathname === "/api/favorites/group/rename") {
          favoritesService.renameGroup(stringValue(body.groupId, ""), stringValue(body.name, ""));
        } else if (url.pathname === "/api/favorites/group/reorder") {
          favoritesService.reorderGroups(stringList(body.groupIds));
        } else if (url.pathname === "/api/favorites/group/delete") {
          const disposition = body.disposition === "default" || body.disposition === "delete"
            ? body.disposition
            : undefined;
          favoritesService.deleteGroup(stringValue(body.groupId, ""), disposition);
        } else if (url.pathname === "/api/favorites/open") {
          const item = favoritesService.get(stringValue(body.favoriteId, ""));
          if (!item) throw new Error("FAVORITE_NOT_FOUND");
          const ui = this.activeUi();
          if (!ui || sourceIdForHistory(ui.state.source) !== item.sourceId) {
            throw new Error("FAVORITE_SOURCE_SWITCH_REQUIRED");
          }
          await ui.detail(item.vodId);
          ui.restoreHistoryResumeForContent(item.vodId);
        } else {
          writeJson(response, { error: "Not found" }, 404);
          return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname.startsWith("/api/follow/")) {
        const followService = this.followService;
        if (!followService) throw new Error("FOLLOW_UNAVAILABLE");
        const ui = this.activeUi();
        if (url.pathname === "/api/follow/toggle-detail") {
          if (!ui) throw new Error("FOLLOW_DETAIL_REQUIRED");
          ui.toggleFollow();
        } else if (url.pathname === "/api/follow/favorite-detail") {
          if (!ui) throw new Error("FOLLOW_DETAIL_REQUIRED");
          ui.followAndFavorite();
        } else if (url.pathname === "/api/follow/refresh") {
          if (!ui) throw new Error("FOLLOW_SOURCE_UNAVAILABLE");
          await ui.checkFollow();
        } else if (url.pathname === "/api/follow/delete") {
          followService.unfollow(stringValue(body.identity, ""));
        } else if (url.pathname === "/api/follow/mark-watched") {
          followService.markWatched(stringValue(body.identity, ""));
        } else if (url.pathname === "/api/follow/mark-unwatched") {
          followService.markUnwatched(stringValue(body.identity, ""));
        } else if (url.pathname === "/api/follow/open") {
          const item = followService.get(stringValue(body.identity, ""));
          if (!item) throw new Error("FOLLOW_NOT_FOUND");
          if (!ui || sourceIdForHistory(ui.state.source) !== item.sourceId) {
            throw new Error("FOLLOW_SOURCE_SWITCH_REQUIRED");
          }
          await ui.detail(item.vodId);
          ui.restoreHistoryResumeForContent(item.vodId);
        } else {
          writeJson(response, { error: "Not found" }, 404);
          return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname.startsWith("/api/cache/")) {
        const cacheService = this.cacheService;
        if (!cacheService) throw new Error("CACHE_UNAVAILABLE");
        if (url.pathname === "/api/cache/refresh") {
          // State is read below; keeping this endpoint explicit makes the UI intent clear.
        } else if (url.pathname === "/api/cache/clear") {
          const scope = body.scope;
          if (!isCacheClearScope(scope)) throw new Error("CACHE_CLEAR_SCOPE_INVALID");
          cacheService.clear(scope);
        } else {
          writeJson(response, { error: "Not found" }, 404);
          return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname.startsWith("/api/storage/")) {
        const storageService = this.storageService;
        if (!storageService) throw new Error("STORAGE_UNAVAILABLE");
        if (url.pathname === "/api/storage/refresh") {
          // State is read below; keeping this endpoint explicit makes the UI intent clear.
        } else if (url.pathname === "/api/storage/open") {
          if (!this.onStorageOpen) throw new Error("STORAGE_OPEN_UNAVAILABLE");
          await this.onStorageOpen();
        } else if (url.pathname === "/api/storage/switch") {
          const mode = body.mode;
          if (!isStorageMode(mode)) throw new Error("STORAGE_MODE_INVALID");
          if (body.confirmed !== true) throw new Error("STORAGE_CONFIRMATION_REQUIRED");
          if (!this.onStorageSwitch) throw new Error("STORAGE_SWITCH_UNAVAILABLE");
          this.onStorageSwitch(mode);
        } else {
          writeJson(response, { error: "Not found" }, 404);
          return;
        }
        this.writeCurrentState(response);
        return;
      }

      if (url.pathname.startsWith("/api/backup/")) {
        await this.handleBackupRequest(url.pathname, body, response);
        return;
      }

      const ui = this.activeUi();
      if (!ui) throw new Error("Import confirmation is required before Spider actions");
      switch (url.pathname) {
        case "/api/import/confirm":
          ui.confirmImport();
          break;
        case "/api/open":
          if (this.importer) {
            const siteKey = this.importer.selectedSiteKey;
            if (!siteKey) throw new Error("No supported media source site is selected");
            await ui.open(siteKey, this.importer.selectedExt);
          } else {
            await ui.open(this.siteKey as string, this.ext as string);
          }
          this.persistPage({
            siteKey: this.importer?.selectedSiteKey ?? this.siteKey ?? null,
          });
          break;
        case "/api/home":
          await ui.home(Boolean(body.filter));
          this.persistPage({ navigation: "home", scrollTop: 0 });
          break;
        case "/api/category":
          {
            const typeId = stringValue(body.typeId, "hot_gaia");
            const page = numberValue(body.page, 1);
            await ui.category(
              typeId,
              page,
              Boolean(body.filter),
              recordOfStrings(body.extend),
            );
            this.persistPage({
              navigation: "category",
              category: { typeId, page },
              scrollTop: 0,
            });
          }
          break;
        case "/api/search":
          {
            const key = stringValue(body.key, "");
            const page = numberValue(body.page, 1);
            if (this.importer && body.aggregate !== false) {
              const sourceIds = stringList(body.sourceIds);
              await this.importer.aggregateSearch(key, {
                page,
                quick: Boolean(body.quick),
                ...(sourceIds.length > 0 ? { sourceIds } : {}),
                onUpdate: (snapshot) => { ui.setAggregateSearch(snapshot); },
              });
            } else {
              await ui.search(key, Boolean(body.quick), page);
            }
            this.persistPage({
              navigation: "search",
              search: { key, page },
              scrollTop: 0,
            });
          }
          break;
        case "/api/detail":
          {
            const vodId = stringValue(body.vodId, "");
            await ui.detail(vodId);
            this.persistPage({ navigation: "detail", recentDetailId: vodId });
          }
          break;
        case "/api/detail/close":
          {
            const closed = ui.closeDetail();
            if (closed.page === "home" || closed.page === "category" || closed.page === "search") {
              this.persistPage({
                navigation: closed.page,
                scrollTop: closed.scrollTop,
                recentDetailId: null,
              });
            }
          }
          break;
        case "/api/playback-sources/search":
          {
            if (!this.importer) throw new Error("PLAYBACK_SOURCE_RESOLVER_UNAVAILABLE");
            if (!ui.state.detail) throw new Error("PLAYBACK_SOURCE_DETAIL_REQUIRED");
            const resolution = await this.importer.resolvePlaybackSources(
              normalizeVod(ui.state.detail),
              {
                currentSiteKey: this.importer.selectedSiteKey,
                progressive: {
                  tierASize: 6,
                  onTier: (tierResolution) => { ui.setPlaybackSourceResolution(tierResolution); },
                },
              },
            );
            ui.setPlaybackSourceResolution(resolution);
          }
          break;
        case "/api/playback-sources/select":
          {
            if (!this.importer) throw new Error("PLAYBACK_SOURCE_RESOLVER_UNAVAILABLE");
            const siteKey = stringValue(body.siteKey, "");
            const vodId = stringValue(body.vodId, "");
            const candidate = ui.playbackSourceCandidate(siteKey, vodId);
            if (!candidate || !candidate.playable) {
              const availableCandidates = ui.state.playbackSources?.candidates.map((value) => ({
                siteKey: value.siteKey,
                vodId: String(value.vod.id ?? value.vod.vod_id ?? ""),
                playable: value.playable,
              })) ?? [];
              throw new Error(`PLAYBACK_SOURCE_CANDIDATE_INVALID: ${JSON.stringify({ siteKey, vodId, availableCandidates })}`);
            }
            const selected = this.importer.selectSite(siteKey);
            if (selected.selectedSiteKey !== siteKey || selected.status === "error") {
              throw new Error("PLAYBACK_SOURCE_SITE_UNAVAILABLE");
            }
            const selectedUi = this.activeUi();
            if (!selectedUi) throw new Error("PLAYBACK_SOURCE_SITE_UNAVAILABLE");
            // resolvePlaybackSources() may have already opened the candidate's
            // session. Re-opening that same session breaks the real DEX
            // Spider lifecycle, so only open newly selected idle sessions.
            if (selectedUi.state.status !== "ready") {
              const opened = await selectedUi.open(siteKey, this.importer.selectedExt);
              if (opened.status === "error") throw new Error("PLAYBACK_SOURCE_SITE_UNAVAILABLE");
            }
            await selectedUi.detail(vodId);
            if (!selectedUi.state.playbackCatalog?.lines.some((line) => line.episodes.length > 0)) {
              throw new Error("PLAYBACK_SOURCE_DETAIL_UNPLAYABLE");
            }
            selectedUi.setPlaybackSourceResolution(null);
            this.persistPage({ navigation: "detail", recentDetailId: vodId, siteKey });
          }
          break;
        case "/api/player/detach":
          (this.playbackUi() ?? ui).detachPlayer();
          break;
        case "/api/player/open":
          if ((this.playbackUi() ?? ui).state.playerHost === "detached") await this.onPlayerOpen?.();
          break;
        case "/api/player/attach":
          (this.playbackUi() ?? ui).attachPlayer();
          await this.onPlayerAttach?.();
          break;
        case "/api/player/stop":
          await (this.playbackUi() ?? ui).stopPlayer();
          await this.onPlayerStop?.();
          await this.pushService?.drainQueue();
          break;
        case "/api/player/fallback/cancel":
          (this.playbackUi() ?? ui).cancelFallback();
          break;
        case "/api/player/fallback/mode":
          {
            const mode = body.mode;
            if (!isPlaybackFallbackMode(mode)) throw new Error("PLAYBACK_FALLBACK_MODE_INVALID");
            (this.playbackUi() ?? ui).setFallbackMode(mode);
          }
          break;
        case "/api/player/fallback/approve":
          await (this.playbackUi() ?? ui).approveFallback();
          break;
        case "/api/player/sync":
          await (this.playbackUi() ?? ui).syncPlayerStateAsync(playerMediaSyncFromRequest(body));
          break;
        case "/api/player":
          if (this.playbackUi() && this.playbackUi() !== ui) {
            await this.playbackUi()?.stopPlayer();
          }
          if (Object.prototype.hasOwnProperty.call(body, "lineIndex")
            || Object.prototype.hasOwnProperty.call(body, "episodeIndex")) {
            await ui.playEpisode(
              indexValue(body.lineIndex),
              indexValue(body.episodeIndex),
              stringList(body.vipFlags),
              undefined,
              historyResumeMode(body.resume),
            );
          } else {
            await ui.player(
              stringValue(body.flag, "default"),
              stringValue(body.id, ""),
              stringList(body.vipFlags),
              undefined,
              historyResumeMode(body.resume),
            );
          }
          break;
        case "/api/switch":
          if (this.importer) {
            await this.releaseImportedUiResources();
            await this.importer.cancel();
          } else {
            await ui.switchSource();
          }
          break;
        case "/api/close":
          if (this.importer) {
            await this.releaseImportedUiResources();
            await this.importer.close();
          } else {
            await ui.close();
          }
          break;
        default:
          writeJson(response, { error: "Not found" }, 404);
          return;
      }
      this.writeCurrentState(response);
    } catch (error) {
      const ui = this.activeUi();
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof DownloadServiceError || error instanceof DownloadError
          ? error.code
        : error instanceof PushServiceError
          ? error.code
        : error instanceof CastServiceError
          ? error.code
        : error instanceof LocalMediaError
          ? error.code
        : errorCodeFromMessage(message);
      writeJson(response, {
        error: message,
        ...(errorCode ? { errorCode } : {}),
        import: this.importer?.state ?? null,
        state: ui ? this.posterProxy.decorateState(ui.state) : null,
        ...(this.pushService ? { push: this.pushService.uiState() } : {}),
        ...(this.castService ? { cast: this.castService.uiState() } : {}),
      }, 400);
    }
  }

  private async handleDownloadRequest(pathname: string, body: Record<string, unknown>): Promise<void> {
    const service = this.downloadService;
    if (!service) throw new DownloadServiceError("DOWNLOAD_OPERATION_INVALID", "下载服务不可用。");
    if (pathname === "/api/downloads/select-folder") {
      if (!this.onDownloadFolderPicker) throw new DownloadServiceError("DOWNLOAD_TARGET_INVALID", "下载目录选择器不可用。");
      const selected = await this.onDownloadFolderPicker();
      if (selected) await service.selectTargetDirectory(selected);
      return;
    }
    if (pathname === "/api/downloads/add") {
      await service.add({
        title: stringValue(body.title, ""),
        requestReference: stringValue(body.url, ""),
        suggestedFilename: stringValue(body.filename, ""),
        targetDirectoryId: stringValue(body.targetDirectoryId, ""),
        // This route is only reachable from the explicit Add Download action.
        explicitUserUrl: true,
      });
      return;
    }
    if (pathname === "/api/downloads/refresh") {
      await service.refresh();
      return;
    }
    const taskId = stringValue(body.taskId, "");
    if (pathname === "/api/downloads/pause") await service.pause(taskId);
    else if (pathname === "/api/downloads/resume") await service.resume(taskId);
    else if (pathname === "/api/downloads/cancel") await service.cancel(taskId);
    else if (pathname === "/api/downloads/retry") await service.retry(taskId);
    else if (pathname === "/api/downloads/remove") await service.remove(taskId);
    else if (pathname === "/api/downloads/open-folder") {
      if (!this.onDownloadFolderOpen) throw new DownloadServiceError("DOWNLOAD_TARGET_INVALID", "打开下载目录不可用。");
      await this.onDownloadFolderOpen(service.targetDirectoryPath(stringValue(body.targetDirectoryId, "")));
    } else {
      throw new DownloadServiceError("DOWNLOAD_OPERATION_INVALID", "下载请求不存在。");
    }
  }

  private async handlePushRequest(pathname: string, body: Record<string, unknown>): Promise<void> {
    const service = this.pushService;
    if (!service) throw new PushServiceError("PUSH_UNAVAILABLE", "Push 服务不可用。");
    if (pathname === "/api/push/settings") {
      const patch: {
        enabled?: boolean;
        port?: number;
        confirmationPolicy?: "ask" | "allow-trusted-local";
        conflictMode?: "replace" | "queue" | "reject";
      } = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.port === "number") patch.port = body.port;
      if (body.confirmationPolicy === "ask" || body.confirmationPolicy === "allow-trusted-local") {
        patch.confirmationPolicy = body.confirmationPolicy;
      }
      if (body.conflictMode === "replace" || body.conflictMode === "queue" || body.conflictMode === "reject") {
        patch.conflictMode = body.conflictMode;
      }
      await service.configure(patch);
      return;
    }
    if (pathname === "/api/push/confirm") {
      const mode = body.mode === "replace" || body.mode === "queue" || body.mode === "reject"
        ? body.mode
        : undefined;
      if (mode) await service.confirm(stringValue(body.id, ""), "play", mode);
      else await service.confirm(stringValue(body.id, ""), "play");
      return;
    }
    if (pathname === "/api/push/reject") {
      await service.confirm(stringValue(body.id, ""), "reject");
      return;
    }
    if (pathname === "/api/push/cancel") {
      service.cancel(stringValue(body.id, ""));
      return;
    }
    if (pathname === "/api/push/clear") {
      service.clearRecent();
      return;
    }
    if (pathname === "/api/push/refresh") {
      await service.drainQueue();
      return;
    }
    throw new PushServiceError("PUSH_ROUTE_NOT_FOUND", "Push 请求不存在。");
  }

  private async handleCastRequest(pathname: string, body: Record<string, unknown>): Promise<void> {
    const service = this.castService;
    if (!service) throw new CastServiceError("DLNA_UNAVAILABLE", "DLNA 投屏服务不可用。");
    if (pathname === "/api/cast/discover" || pathname === "/api/cast/refresh") {
      await service.discover();
      return;
    }
    if (pathname === "/api/cast/play") {
      const ui = this.playbackUi() ?? this.activeUi();
      const player = ui?.state.player;
      const source = player?.source;
      if (!source) throw new CastServiceError("DLNA_MEDIA_UNAVAILABLE", "当前没有可投屏的媒体。");
      const selectedSubtitle = source.subtitles?.find((track) => track.default || track.forced) ?? source.subtitles?.[0];
      const media: CastMediaSource = {
        url: new URL(source.url, this.url).toString(),
        title: ui?.state.playbackSession?.media.title ?? "当前媒体",
        ...(Object.keys(source.headers).length > 0 ? { headers: { ...source.headers } } : {}),
        ...(selectedSubtitle?.url ? {
          subtitle: {
            url: new URL(selectedSubtitle.url, this.url).toString(),
            ...(selectedSubtitle.headers ? { headers: { ...selectedSubtitle.headers } } : {}),
            contentType: subtitleContentType(selectedSubtitle.format),
          },
        } : {}),
      };
      await service.cast({
        deviceId: stringValue(body.deviceId, ""),
        media,
        ...(typeof player.currentTime === "number" ? { startPosition: player.currentTime } : {}),
      });
      return;
    }
    if (pathname === "/api/cast/pause") {
      await service.pause();
      return;
    }
    if (pathname === "/api/cast/resume") {
      await service.play();
      return;
    }
    if (pathname === "/api/cast/stop") {
      await service.stop();
      return;
    }
    if (pathname === "/api/cast/disconnect") {
      await service.disconnect();
      return;
    }
    if (pathname === "/api/cast/seek") {
      const position = typeof body.position === "number" ? body.position : Number(body.position);
      await service.seek(position);
      return;
    }
    if (pathname === "/api/cast/position") {
      await service.refreshPosition();
      return;
    }
    if (pathname === "/api/cast/transport") {
      await service.refreshTransport();
      return;
    }
    throw new CastServiceError("DLNA_ROUTE_NOT_FOUND", "DLNA 投屏请求不存在。");
  }

  private async handleLocalMediaRequest(pathname: string, body: Record<string, unknown>): Promise<void> {
    const service = this.localMediaService;
    if (!service) throw new LocalMediaError("LOCAL_MEDIA_UNAVAILABLE", "本地媒体服务不可用。");
    if (pathname === "/api/local-media/open-file") {
      if (!this.onLocalFilePicker) throw new LocalMediaError("LOCAL_MEDIA_PICKER_UNAVAILABLE", "本地文件选择器不可用。");
      await service.openFiles(await this.onLocalFilePicker());
      return;
    }
    if (pathname === "/api/local-media/add-folder") {
      if (!this.onLocalFolderPicker) throw new LocalMediaError("LOCAL_MEDIA_PICKER_UNAVAILABLE", "本地目录选择器不可用。");
      const path = await this.onLocalFolderPicker();
      if (path) await service.addFolder(path);
      return;
    }
    if (pathname === "/api/local-media/drop") {
      await service.importDrop(stringList(body.paths));
      return;
    }
    if (pathname === "/api/local-media/rescan") {
      const rootId = typeof body.rootId === "string" && body.rootId.length > 0 ? body.rootId : undefined;
      await service.rescan(rootId);
      return;
    }
    if (pathname === "/api/local-media/cancel-scan") {
      service.cancelScan(typeof body.rootId === "string" ? body.rootId : undefined);
      return;
    }
    if (pathname === "/api/local-media/remove-folder") {
      await service.removeFolder(stringValue(body.rootId, ""));
      return;
    }
    if (pathname === "/api/local-media/remove-item") {
      service.removeItem(stringValue(body.itemId, ""));
      return;
    }
    if (pathname === "/api/local-media/locate") {
      if (!this.onLocalFilePicker) throw new LocalMediaError("LOCAL_MEDIA_PICKER_UNAVAILABLE", "本地文件选择器不可用。");
      const paths = await this.onLocalFilePicker();
      const path = paths[0];
      if (!path) return;
      await service.locateItem(stringValue(body.itemId, ""), path);
      return;
    }
    if (pathname === "/api/local-media/play") {
      const ui = this.activeUi();
      if (!ui) throw new LocalMediaError("LOCAL_MEDIA_UI_UNAVAILABLE", "请先完成媒体源导入后再播放本地媒体。");
      await ui.playLocalMedia(stringValue(body.itemId, ""), this.url, historyResumeMode(body.resume));
      return;
    }
    if (pathname === "/api/local-media/active") {
      service.setActiveItem(typeof body.itemId === "string" ? body.itemId : null);
      return;
    }
    throw new LocalMediaError("LOCAL_MEDIA_ROUTE_NOT_FOUND", "本地媒体请求不存在。");
  }

  private writeLocalMediaStream(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): void {
    const service = this.localMediaService;
    if (!service) {
      writeJson(response, { error: "Local media is unavailable" }, 404);
      return;
    }
    const parts = pathname.split("/").filter(Boolean);
    const kind = parts[2];
    try {
      const itemId = decodePathPart(parts[3] ?? "");
      let stream;
      if (kind === "stream") {
        const initial = service.resolveMediaStream(itemId);
        const range = initial.kind === "file" ? parseRange(request.headers.range, initial.size) : null;
        if (request.headers.range && initial.kind === "file" && !range) {
          response.writeHead(416, { "content-range": `bytes */${initial.size}` });
          response.end();
          return;
        }
        stream = range ? service.resolveMediaStream(itemId, range) : initial;
        this.writeLocalStreamResponse(response, stream, range);
        if (stream.kind === "file") {
          const start = range?.start ?? 0;
          const end = range?.end === null || range?.end === undefined ? stream.size - 1 : range.end;
          createReadStream(stream.path, { start, end }).pipe(response);
        } else response.end(stream.body);
        return;
      }
      if (kind === "resource") {
        stream = service.resolvePlaylistResource(itemId, decodePathPart(parts[4] ?? ""));
      } else if (kind === "subtitle") {
        stream = service.resolveSubtitle(itemId, decodePathPart(parts[4] ?? ""));
      } else {
        throw new LocalMediaError("LOCAL_MEDIA_ROUTE_NOT_FOUND", "本地媒体请求不存在。");
      }
      const range = parseRange(request.headers.range, stream.size);
      if (request.headers.range && !range) {
        response.writeHead(416, { "content-range": `bytes */${stream.size}` });
        response.end();
        return;
      }
      this.writeLocalStreamResponse(response, stream, range);
      const start = range?.start ?? 0;
      const end = range?.end === null || range?.end === undefined ? stream.size - 1 : range.end;
      createReadStream(stream.path, { start, end }).pipe(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地媒体资源不可用。";
      const code = error instanceof LocalMediaError ? error.code : errorCodeFromMessage(message);
      writeJson(response, { error: message, ...(code ? { errorCode: code } : {}) }, 404);
    }
  }

  private writeLocalStreamResponse(
    response: ServerResponse,
    stream: LocalMediaStream,
    range: { start: number; end: number | null } | null,
  ): void {
    if (stream.kind === "text") {
      response.writeHead(200, {
        "content-type": stream.contentType,
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(stream.body),
        "x-content-type-options": "nosniff",
      });
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end === null || range?.end === undefined ? stream.size - 1 : range.end;
    response.writeHead(range ? 206 : 200, {
      "content-type": stream.contentType,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end}/${stream.size}` } : {}),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  }

  private async handleDanmakuRequest(pathname: string, body: Record<string, unknown>): Promise<void> {
    const service = this.danmakuService;
    if (!service) throw new Error("DANMAKU_UNAVAILABLE");
    if (pathname === "/api/danmaku/load") {
      const format = body.format === "json" || body.format === "xml" || body.format === "items" || body.format === "auto"
        ? body.format
        : "auto";
      const data = Object.prototype.hasOwnProperty.call(body, "data")
        ? body.data
        : Object.prototype.hasOwnProperty.call(body, "content")
          ? body.content
          : body.items;
      await service.load({
        format,
        data,
        ...(typeof body.source === "string" ? { source: body.source } : {}),
        timeline: "vod",
      } satisfies DanmakuLoadInput);
      return;
    }
    if (pathname === "/api/danmaku/settings") {
      service.setSettings(danmakuSettingsPatchFromRequest(body));
      return;
    }
    if (pathname === "/api/danmaku/clear") {
      service.clear();
      return;
    }
    if (pathname === "/api/danmaku/sync") {
      const currentTime = optionalNumber(body.currentTime);
      if (currentTime === undefined) throw new Error("DANMAKU_CURRENT_TIME_INVALID");
      service.sync(currentTime * 1_000, optionalString(body.eventType) ?? undefined, optionalString(body.status) ?? undefined);
      return;
    }
    throw new Error("DANMAKU_ROUTE_NOT_FOUND");
  }

  private activeUi(): DesktopSpiderUiController | undefined {
    if (!this.importer) return this.directUi;
    const session = this.importer.session;
    if (!session) {
      this.boundSession = undefined;
      this.importedUi = undefined;
      return undefined;
    }
    this.boundSession = session;
    this.importedUi = this.importedUiBySession.get(session);
    if (!this.importedUi) {
      this.importedUi = new DesktopSpiderUiController({
        session,
        sourceHealth: this.importer.sourceHealthService,
        onPlaybackComplete: () => this.pushService?.drainQueue(),
        ...(this.playbackProxyOrigins ? { playbackProxyOrigins: this.playbackProxyOrigins } : {}),
        ...(this.parserCandidates ? { parserCandidates: this.parserCandidates } : {}),
        ...(this.parserAllowedOrigins ? { parserAllowedOrigins: this.parserAllowedOrigins } : {}),
        ...(this.parserFetch ? { parserFetch: this.parserFetch } : {}),
        ...(this.playbackFetch ? { playbackFetch: this.playbackFetch } : {}),
        ...(this.playbackRules ? { playbackRules: this.playbackRules } : {}),
        ...(this.sniffer ? { sniffer: this.sniffer } : {}),
        ...(this.playbackFallbackMode ? { playbackFallbackMode: this.playbackFallbackMode } : {}),
        ...(this.playbackFallbackMaxAttempts ? { playbackFallbackMaxAttempts: this.playbackFallbackMaxAttempts } : {}),
        ...(this.playbackFallbackTimeoutMs ? { playbackFallbackTimeoutMs: this.playbackFallbackTimeoutMs } : {}),
        ...(this.historyService ? { history: this.historyService } : {}),
        ...(this.favoritesService ? { favorites: this.favoritesService } : {}),
        ...(this.followService ? { follow: this.followService } : {}),
        ...(this.cacheService ? { cache: this.cacheService } : {}),
        ...(this.storageService ? { storage: this.storageService } : {}),
        ...(this.danmakuService ? { danmaku: this.danmakuService } : {}),
        ...(this.localMediaService ? { localMedia: this.localMediaService } : {}),
        ...(this.downloadService ? { downloads: this.downloadService } : {}),
        ...(this.onStorageOpen ? { onStorageOpen: this.onStorageOpen } : {}),
        ...(this.onStorageSwitch ? { onStorageSwitch: this.onStorageSwitch } : {}),
      });
      this.importedUiBySession.set(session, this.importedUi);
    }
    return this.importedUi;
  }

  private playbackUi(): DesktopSpiderUiController | undefined {
    for (const ui of this.importedUiBySession.values()) {
      if (ui.state.playbackSession) return ui;
    }
    return undefined;
  }

  private async releaseImportedUiResources(): Promise<void> {
    await Promise.all([...this.importedUiBySession.values()].map((ui) => ui.releaseResources()));
  }

  private writeCurrentState(response: ServerResponse): void {
    const ui = this.activeUi();
    const visibleState = this.visibleState(ui);
    const persistence = this.stateStore?.rendererState();
    const localMedia = this.localMediaService?.uiState(this.boundUrl);
    const downloads = this.downloadService?.uiState();
    const push = this.pushService?.uiState();
    const cast = this.castService?.uiState();
    const state = visibleState
      ? { ...visibleState, backup: this.backupState, ...(localMedia ? { localMedia } : {}), ...(downloads ? { downloads } : {}), ...(push ? { push } : {}), ...(cast ? { cast } : {}) }
      : null;
    if (this.importer) {
      writeJson(response, {
        import: this.importer.state,
        state,
        ...(localMedia ? { localMedia } : {}),
        ...(downloads ? { downloads } : {}),
        ...(push ? { push } : {}),
        ...(cast ? { cast } : {}),
        ...(persistence ? { persistence } : {}),
      });
    } else {
      writeJson(response, {
        state,
        ...(localMedia ? { localMedia } : {}),
        ...(downloads ? { downloads } : {}),
        ...(push ? { push } : {}),
        ...(cast ? { cast } : {}),
        ...(persistence ? { persistence } : {}),
      });
    }
  }

  private visibleState(ui: DesktopSpiderUiController | undefined): DesktopSpiderUiState | null {
    if (!ui) return null;
    const current = ui.state;
    const playback = this.playbackUi();
    const state = !playback || playback === ui || !playback.state.playbackSession
      ? { ...current, backup: this.backupState }
      : {
      ...current,
      backup: this.backupState,
      player: playback.state.player,
      playerHost: playback.state.playerHost,
      playbackSession: playback.state.playbackSession,
      };
    return this.posterProxy.decorateState(state);
  }

  private async handleBackupRequest(pathname: string, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    if (pathname === "/api/backup/create") {
      if (!this.onBackupCreate) throw new Error("BACKUP_UNAVAILABLE");
      this.backupState = await this.onBackupCreate(body.includeCache === true);
    } else if (pathname === "/api/backup/pick") {
      if (!this.onBackupPick) throw new Error("BACKUP_PICK_UNAVAILABLE");
      this.backupState = await this.onBackupPick();
    } else if (pathname === "/api/backup/apply") {
      if (!this.backupState.preview) throw new Error("BACKUP_PREVIEW_REQUIRED");
      this.backupState = { ...this.backupState, status: "restarting", error: null };
      this.writeCurrentState(response);
      void this.onBackupApply?.();
      return;
    } else if (pathname === "/api/backup/clear") {
      this.onBackupClear?.();
      this.backupState = { ...EMPTY_BACKUP_UI_STATE };
    } else if (pathname === "/api/backup/open") {
      if (!this.onBackupOpen) throw new Error("BACKUP_OPEN_UNAVAILABLE");
      await this.onBackupOpen();
    } else {
      writeJson(response, { error: "Not found" }, 404);
      return;
    }
    this.writeCurrentState(response);
  }

  private persistPage(patch: PageStatePatch): void {
    this.stateStore?.patch({ page: patch });
  }

  private persistImportedSite(siteKey: string | null): void {
    const previousSiteKey = this.stateStore?.state.page.siteKey;
    if (previousSiteKey && previousSiteKey !== siteKey) {
      this.stateStore?.patch({
        page: {
          siteKey,
          navigation: "home",
          category: null,
          search: null,
          scrollTop: 0,
          recentDetailId: null,
        },
      });
      return;
    }
    this.persistPage({ siteKey });
  }

  private writeHlsAsset(response: ServerResponse): void {
    try {
      const assetPath = require.resolve("hls.js/dist/hls.min.js");
      const asset = readFileSync(assetPath);
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": asset.byteLength,
        "cache-control": "no-store",
      });
      response.end(asset);
    } catch {
      writeJson(response, { error: "Bundled hls.js asset is unavailable" }, 500);
    }
  }

  private writeRendererAsset(response: ServerResponse, pathname: string): boolean {
    const directPath = this.rendererFilePath(pathname);
    const filePath = directPath ?? (pathname.startsWith("/assets/")
      ? null
      : this.rendererFilePath("/"));
    if (!filePath) return false;

    try {
      const asset = readFileSync(filePath);
      response.writeHead(200, {
        "content-type": rendererContentType(filePath),
        "content-security-policy": rendererContentSecurityPolicy(),
        "cache-control": "no-store",
        "content-length": asset.byteLength,
      });
      response.end(asset);
      return true;
    } catch {
      return false;
    }
  }

  private rendererFilePath(pathname: string): string | null {
    if (!this.rendererDirectory) return null;
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      return null;
    }
    const candidate = resolvePath(this.rendererDirectory, `.${relativePath}`);
    const root = this.rendererDirectory.endsWith("\\")
      ? this.rendererDirectory
      : `${this.rendererDirectory}\\`;
    if (candidate !== this.rendererDirectory && !candidate.startsWith(root)) return null;
    return existsSync(candidate) ? candidate : null;
  }
}

function webControlUnavailable(code: string): Error & { code: string } {
  const error = new Error("Web 控制能力当前不可用") as Error & { code: string };
  error.code = code;
  return error;
}

function toWebNowPlaying(
  player: PlaybackState | null,
  title: string | null,
  episode: string | null,
): WebControlNowPlaying {
  const status = player?.status ?? "idle";
  return {
    status,
    title: safeText(title, 240),
    episode: safeText(episode, 240),
    currentTime: safeFinite(player?.currentTime, 0),
    duration: safeFinite(player?.duration, 0),
    volume: Math.min(1, Math.max(0, safeFinite(player?.volume, 1))),
    muted: player?.muted ?? false,
    error: player?.error ? safeWebError(player.error.code) : null,
  };
}

function webPlaybackStatus(value: string): WebControlNowPlaying["status"] {
  if (value === "buffering" || value === "switching") return "playing";
  if (value === "idle" || value === "resolving" || value === "loading" || value === "playing"
    || value === "paused" || value === "ended" || value === "stopped" || value === "error") return value;
  return "idle";
}

function toWebSearchResult(query: string, items: readonly Record<string, unknown>[]): WebControlSearchResult {
  const result = items.flatMap((item, index) => {
    const id = firstText(item, ["vod_id", "id", "video_id"]);
    if (!id) return [];
    return [{
      id: safeText(id, 512) ?? `item-${index}`,
      title: safeText(firstText(item, ["vod_name", "name", "title"]), 240) ?? id,
      year: safeText(firstText(item, ["vod_year", "year"]), 32),
      remark: safeText(firstText(item, ["vod_remarks", "remark", "remarks"]), 240),
    }];
  });
  return { query: safeText(query, 120) ?? "", items: result };
}

function toWebDetail(id: string, detail: Record<string, unknown> | null, catalog: PlaybackCatalog | null): WebControlDetail {
  const safeDetailId = safeText(firstText(detail ?? {}, ["vod_id", "id", "video_id"]) ?? id, 512) ?? id;
  const title = safeText(firstText(detail ?? {}, ["vod_name", "name", "title"]), 240) ?? safeDetailId;
  const overview = safeText(firstText(detail ?? {}, ["vod_content", "content", "overview", "description"]), 2_000);
  const episodes = (catalog?.lines ?? []).flatMap((line) => line.episodes.map((episode) => ({
    lineIndex: line.index,
    episodeIndex: episode.index,
    lineName: safeText(line.name, 160) ?? "线路",
    name: safeText(episode.name, 240) ?? `第 ${episode.index + 1} 集`,
  })));
  return {
    id: safeDetailId,
    title,
    year: safeText(firstText(detail ?? {}, ["vod_year", "year"]), 32),
    overview,
    episodes,
  };
}

function toWebDownloads(state: DownloadUiState | undefined): WebControlDownloads {
  const source = state ?? EMPTY_DOWNLOAD_UI_STATE;
  return {
    tasks: source.tasks.map((task) => ({
      id: task.id,
      title: safeText(task.title, 240) ?? task.id,
      filename: safeText(task.suggestedFilename, 180) ?? "download",
      status: task.status,
      totalBytes: safeNullableNumber(task.totalBytes),
      completedBytes: safeNullableNumber(task.completedBytes),
      speed: safeNullableNumber(task.speed),
      error: task.error ? safeText(task.error, 240) : null,
    })),
    backend: source.backend,
    available: source.aria2Available,
    error: source.error ? safeWebError(source.error.code) : null,
  };
}

function toWebCastState(state: CastUiState | undefined): WebControlCastState {
  const source = state ?? { discoveryStatus: "idle", devices: [], session: null, error: null } satisfies CastUiState;
  return {
    discoveryStatus: source.discoveryStatus,
    devices: source.devices.map((device) => ({
      deviceId: device.deviceId,
      friendlyName: safeText(device.friendlyName, 240) ?? device.deviceId,
      model: safeText(device.model, 160) ?? "",
      manufacturer: safeText(device.manufacturer, 160) ?? "",
      capabilities: {
        play: device.capabilities.play,
        pause: device.capabilities.pause,
        stop: device.capabilities.stop,
        seek: device.capabilities.seek,
      },
    })),
    session: source.session ? {
      deviceId: source.session.device.deviceId,
      deviceName: safeText(source.session.device.friendlyName, 240) ?? source.session.device.deviceId,
      title: safeText(source.session.media.title, 240) ?? "QX 影视媒体",
      state: source.session.state,
      lastPosition: safeFinite(source.session.lastPosition, 0),
      error: source.session.error ? safeWebError(source.session.error.code) : null,
    } : null,
    error: source.error ? safeWebError(source.error.code) : null,
  };
}

function toWebPushResult(result: PushSubmissionResult): WebControlPushResult {
  if (result.kind === "confirmation-required") {
    return {
      kind: result.kind,
      id: result.preview.id,
      title: safeText(result.preview.title, 240),
      status: "pending-confirmation",
    };
  }
  return {
    kind: result.kind,
    id: result.recent.id,
    title: safeText(result.recent.title, 240),
    status: result.recent.status,
  };
}

function firstText(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim().length > 0) return value[key] as string;
  }
  return null;
}

function safeText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f]/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
}

function safeFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function safeNullableNumber(value: number | null): number | null {
  return value === null ? null : safeFinite(value, 0);
}

function safeWebError(code: string): { code: string; message: string } {
  const safeCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "WEB_BACKEND_ERROR";
  return { code: safeCode, message: "状态操作失败" };
}

function rendererContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function rendererContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "connect-src 'self' http: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function errorCodeFromMessage(message: string): string | null {
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message);
  return match?.[1] ?? null;
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new LocalMediaError("LOCAL_MEDIA_ROUTE_NOT_FOUND", "本地媒体请求不存在。");
  }
}

function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number | null } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match) return null;
  const startValue = match[1] ?? "";
  const endValue = match[2] ?? "";
  if (!startValue && !endValue) return null;
  if (!startValue) {
    const suffix = Number(endValue);
    if (!Number.isInteger(suffix) || suffix <= 0 || size <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startValue);
  if (!Number.isInteger(start) || start < 0 || start >= size) return null;
  if (!endValue) return { start, end: null };
  const end = Number(endValue);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function publicPlaybackState(playback: DesktopSpiderPlaybackState): DesktopSpiderPlaybackState {
  if (!playback.available) return { ...playback };
  return {
    available: true,
    label: playback.label,
    message: playback.message,
    parse: playback.parse,
    url: playback.url,
    headers: {},
    ...(playback.playUrl ? { playUrl: playback.playUrl } : {}),
    ...(playback.jx === undefined ? {} : { jx: playback.jx }),
    ...(playback.format ? { format: playback.format } : {}),
    ...(playback.flag ? { flag: playback.flag } : {}),
    ...(playback.jxFrom ? { jxFrom: playback.jxFrom } : {}),
    ...(playback.subtitles
      ? { subtitles: playback.subtitles.map(publicSubtitleTrack) }
      : {}),
  };
}

function playbackAttemptDiagnostics(
  request: PlaybackRequest,
  response: SpiderResponse | undefined,
  playback: DesktopSpiderPlaybackState,
  thrown?: unknown,
  siteKey = "unknown",
): PlaybackAttemptDiagnostics {
  const thrownRecord = isRecord(thrown) ? thrown : null;
  const errorCode = response?.error?.code
    ?? (typeof thrownRecord?.code === "string" ? thrownRecord.code : null);
  const errorMessage = response?.error?.message
    ?? (thrown instanceof Error ? thrown.message : null);
  return {
    siteKey,
    flag: request.flag,
    episodeId: request.id,
    playerContent: {
      ok: response?.ok === true,
      code: errorCode,
      message: errorMessage?.replace(/\b(cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>") ?? null,
    },
    parse: playback.available ? playback.parse : null,
    jx: playback.available ? playback.jx ?? null : null,
    format: playback.available ? playback.format ?? null : null,
    jxFrom: playback.available ? playback.jxFrom ?? null : null,
  };
}

function publicSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  const { headers: _headers, localPath: _localPath, ...safeTrack } = track;
  return safeTrack;
}

function cloneSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  return {
    ...track,
    ...(track.headers ? { headers: { ...track.headers } } : {}),
  };
}

export function renderDesktopSpiderUi(state: DesktopSpiderUiState): string {
  const spiderLabel = state.api ?? "Spider";
  const statusLabel = {
    confirmation_required: "等待导入确认",
    idle: "待启动",
    initializing: "正在启动",
    loading: "加载中",
    ready: "就绪",
    error: "错误",
    destroyed: "已关闭",
  } satisfies Record<DesktopSpiderSessionStatus, string>;
  const items = state.items.map((item) => {
    const vodId = stringValue(item.vod_id, "");
    return `<article class="vod-card" data-testid="vod-card">
      <h3>${escapeHtml(stringValue(item.vod_name, "未命名"))}</h3>
      <p>${escapeHtml(stringValue(item.vod_remarks, ""))}</p>
      <button data-action="detail" data-vod-id="${escapeHtml(vodId)}">查看详情</button>
    </article>`;
  }).join("\n");
  const warning = state.warning && state.status === "confirmation_required"
    ? `<section class="warning" data-testid="import-warning">
        <strong>首次导入需要确认</strong>
        <p>${escapeHtml(state.warning)}</p>
        <button data-action="confirm-import">确认并信任</button>
      </section>`
    : "";
  const error = state.error
    ? `<section class="error" data-testid="error">
        <strong>${escapeHtml(errorLabel(state.error.code))}</strong>
        <span data-testid="error-code">${escapeHtml(state.error.code)}</span>
        <p>${escapeHtml(state.error.message)}</p>
      </section>`
    : "";
  const aggregateSearch = state.aggregateSearch
    ? `<section data-testid="aggregate-search-progress">
        <strong>聚合搜索：${escapeHtml(state.aggregateSearch.query)}</strong>
        <p>进度 ${state.aggregateSearch.completed}/${state.aggregateSearch.total} · 结果 ${state.aggregateSearch.groups.length} 组 · 状态 ${escapeHtml(state.aggregateSearch.status)}</p>
        <p>${state.aggregateSearch.sources.map((source) => `${escapeHtml(source.label)}：${escapeHtml(source.status)}（${source.count}）`).join(" · ")}</p>
      </section>`
    : "";
  const start = state.status === "idle" || (state.status === "error" && !state.sidecarRunning)
    ? `<button data-action="open">启动 Spider</button>`
    : "";
  const navigation = state.status !== "confirmation_required" && state.status !== "destroyed"
    ? `<nav aria-label="Spider 导航">
        ${start}
        <button data-action="home">首页</button>
        <button data-action="category" data-type-id="hot_gaia" data-page="1">分类</button>
        <button data-action="switch">切换来源</button>
        <button data-action="close">关闭</button>
      </nav>`
    : "";
  const playButton = state.canPlay && state.playback.available
    ? `<button data-testid="play-button" data-action="play" data-play-parse="${state.playback.available ? state.playback.parse : 0}">播放</button>`
    : `<button data-testid="play-button" disabled>播放</button>`;
  const playbackCatalog = state.playbackCatalog
    ? renderPlaybackCatalog(
      state.playbackCatalog,
      state.playbackSelection,
      state.status === "error" && state.error?.code.startsWith("PLAYBACK_") === true,
    )
    : "";
  const playableSourceCandidates = state.playbackSources?.candidates.filter((candidate) => candidate.playable) ?? [];
  const canSearchPlayback = state.detail !== null
    && !state.canPlay
    && (!state.playbackCatalog || !state.playbackCatalog.lines.some((line) => line.episodes.length > 0));
  const playbackSourceSearch = canSearchPlayback
    ? state.playbackSources
      ? playableSourceCandidates.length > 0
        ? `<section data-testid="playback-source-candidates">
            <strong>找到可播放来源，请选择：</strong>
            ${playableSourceCandidates.map((candidate) => `<button data-action="playback-source-select" data-site-key="${escapeHtml(candidate.siteKey)}" data-vod-id="${escapeHtml(candidate.vod.id)}">${escapeHtml(candidate.siteName)} · ${escapeHtml(candidate.vod.name)}（匹配 ${candidate.score}）</button>`).join("")}
          </section>${renderPlaybackSourceDiagnostics(state.playbackSources.diagnostics)}`
        : `<p data-testid="playback-source-empty">当前配置中未找到可播放来源</p>${renderPlaybackSourceDiagnostics(state.playbackSources.diagnostics)}`
      : `<button data-action="find-playback-source"${state.loading ? " disabled" : ""}>查找播放源</button>`
    : "";
  const playerMarkup = state.playerHost === "detached"
    ? `<section data-testid="detached-player-panel" class="embedded-player-panel">
        <strong>独立播放窗口</strong>
        <p data-testid="detached-player-status">播放已转移到独立窗口，主窗口不会后台播放。</p>
        <button data-action="player-attach">返回主窗口</button>
        <button data-action="player-stop">停止播放</button>
      </section>`
    : renderEmbeddedPlayer(
      state.player,
      state.playbackSession?.id ? { sessionId: state.playbackSession.id } : {},
    );
  const healthMarkup = renderPlaybackHealth(state);
  const detail = state.detail
    ? `<section data-testid="detail-panel" class="detail-panel">
        <h2>${escapeHtml(stringValue(state.detail.vod_name, "详情"))}</h2>
        <p>${escapeHtml(stringValue(state.detail.vod_content, ""))}</p>
        ${playButton}
        ${playbackSourceSearch}
        <span data-testid="playback-label">${escapeHtml(state.playback.label)}</span>
      </section>`
    : `<section data-testid="playback-panel" class="playback-panel">
        ${playButton}
        <span data-testid="playback-label">${escapeHtml(state.playback.label)}</span>
      </section>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>QX 影视 Spider</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #f4f6f8; color: #17202a; }
      main { max-width: 960px; margin: 0 auto; padding: 24px; }
      header, section, nav, form { background: #fff; border: 1px solid #dce1e6; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
      nav { display: flex; flex-wrap: wrap; gap: 8px; }
      button { cursor: pointer; padding: 8px 12px; }
      button:disabled { cursor: not-allowed; opacity: .55; }
      .warning { border-color: #e3a008; background: #fff8e1; }
      .error { border-color: #d64545; background: #fff1f1; }
      .loading { color: #946200; }
      .vod-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
      .vod-card { border: 1px solid #dce1e6; border-radius: 8px; padding: 12px; background: #fff; }
      .meta { color: #5b6570; font-size: .9rem; }
      .embedded-player-panel video { display: block; width: 100%; max-height: 520px; background: #101418; }
      .player-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
      .player-controls label { display: inline-flex; gap: 4px; align-items: center; }
      .player-error { color: #b42318; }
    </style>
  </head>
  <body>
    <main data-testid="desktop-spider-ui" data-status="${escapeHtml(state.status)}">
      <header>
        <h1>QX 影视 · ${escapeHtml(spiderLabel)}</h1>
        <p class="meta">来源：${escapeHtml(displaySource(state.source))} · API：${escapeHtml(displaySource(state.api ?? "未选择"))}</p>
        <p data-testid="status" class="${state.loading ? "loading" : ""}">${escapeHtml(statusLabel[state.status])}${state.loading ? " · 加载中" : ""}</p>
      </header>
      ${warning}
      ${error}
      ${aggregateSearch}
      ${navigation}
      <form data-testid="search-form" data-action="search-form">
        <label>搜索 <input name="key" autocomplete="off"></label>
        <button type="submit">搜索</button>
      </form>
      ${detail}
      ${playbackCatalog}
      ${playerMarkup}
      ${healthMarkup}
      <section class="vod-list" data-testid="vod-list">${items}</section>
    </main>
    <script>
      (() => {
        const send = async (path, body = {}) => {
          const status = document.querySelector('[data-testid="status"]');
          if (status) { status.textContent = '加载中'; status.classList.add('loading'); }
          await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          window.location.reload();
        };
        document.querySelectorAll('[data-action="confirm-import"]').forEach((button) => button.addEventListener('click', () => send('/api/import/confirm')));
        document.querySelectorAll('[data-action="open"]').forEach((button) => button.addEventListener('click', () => send('/api/open')));
        document.querySelectorAll('[data-action="home"]').forEach((button) => button.addEventListener('click', () => send('/api/home')));
        document.querySelectorAll('[data-action="category"]').forEach((button) => button.addEventListener('click', () => send('/api/category', { typeId: button.dataset.typeId, page: Number(button.dataset.page || '1') })));
        document.querySelectorAll('[data-action="detail"]').forEach((button) => button.addEventListener('click', () => send('/api/detail', { vodId: button.dataset.vodId })));
        document.querySelectorAll('[data-action="find-playback-source"]').forEach((button) => button.addEventListener('click', () => send('/api/playback-sources/search')));
        document.querySelectorAll('[data-action="playback-source-select"]').forEach((button) => button.addEventListener('click', () => send('/api/playback-sources/select', { siteKey: button.dataset.siteKey, vodId: button.dataset.vodId })));
        document.querySelectorAll('[data-action="switch"]').forEach((button) => button.addEventListener('click', () => send('/api/switch')));
        document.querySelectorAll('[data-action="close"]').forEach((button) => button.addEventListener('click', () => send('/api/close')));
        document.querySelectorAll('[data-action="player-attach"]').forEach((button) => button.addEventListener('click', () => send('/api/player/attach')));
        document.querySelectorAll('[data-action="player-stop"]').forEach((button) => button.addEventListener('click', () => send('/api/player/stop')));
        document.querySelectorAll('[data-action="playback-fallback-cancel"]').forEach((button) => button.addEventListener('click', () => send('/api/player/fallback/cancel')));
        document.querySelectorAll('[data-action="playback-fallback-approve"]').forEach((button) => button.addEventListener('click', () => send('/api/player/fallback/approve')));
        document.querySelectorAll('[data-action="playback-fallback-mode"]').forEach((select) => select.addEventListener('change', () => send('/api/player/fallback/mode', { mode: select.value })));
        const lineButtons = [...document.querySelectorAll('[data-action="playback-line"]')];
        const linePanels = [...document.querySelectorAll('[data-playback-line]')];
        const activateLine = (lineIndex) => {
          lineButtons.forEach((button) => {
            const active = button.dataset.lineIndex === String(lineIndex);
            button.setAttribute('aria-pressed', String(active));
          });
          linePanels.forEach((panel) => {
            panel.hidden = panel.dataset.playbackLine !== String(lineIndex);
          });
          const activeButton = lineButtons.find((button) => button.dataset.lineIndex === String(lineIndex));
          const currentLine = document.querySelector('[data-testid="current-line"]');
          const currentEpisode = document.querySelector('[data-testid="current-episode"]');
          if (currentLine && activeButton) currentLine.textContent = activeButton.textContent || '';
          if (currentEpisode) currentEpisode.textContent = '未选择';
        };
        lineButtons.forEach((button) => button.addEventListener('click', () => activateLine(button.dataset.lineIndex || '0')));
        const orderButtons = [...document.querySelectorAll('[data-action="playback-order"]')];
        const setPlaybackOrder = (order) => {
          orderButtons.forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.order === order));
          });
          linePanels.forEach((panel) => {
            const episodes = [...panel.querySelectorAll('[data-action="player-episode"]')];
            episodes.sort((left, right) => {
              const difference = Number(left.dataset.episodeIndex) - Number(right.dataset.episodeIndex);
              return order === 'reverse' ? -difference : difference;
            }).forEach((episode) => panel.appendChild(episode));
          });
        };
        orderButtons.forEach((button) => button.addEventListener('click', () => setPlaybackOrder(button.dataset.order || 'forward')));
        document.querySelectorAll('[data-action="player-episode"]').forEach((button) => button.addEventListener('click', () => {
          void send('/api/player', {
            lineIndex: Number(button.dataset.lineIndex),
            episodeIndex: Number(button.dataset.episodeIndex),
            vipFlags: [],
          });
        }));
        document.querySelectorAll('[data-action="player-retry"]').forEach((button) => button.addEventListener('click', () => {
          void send('/api/player', {
            lineIndex: Number(button.dataset.lineIndex),
            episodeIndex: Number(button.dataset.episodeIndex),
            vipFlags: [],
          });
        }));
        document.querySelector('[data-action="search-form"]')?.addEventListener('submit', (event) => {
          event.preventDefault();
          const key = new FormData(event.currentTarget).get('key');
          void send('/api/search', { key: String(key || ''), page: 1, quick: false });
        });
      })();
    </script>
  </body>
</html>`;
}

function renderPlaybackCatalog(
  catalog: PlaybackCatalog,
  selection: PlaybackSelection | null,
  retryable: boolean,
): string {
  if (catalog.lines.length === 0) {
    return `<section data-testid="playback-selector" class="playback-selector">
      <strong>播放线路</strong><p data-testid="playback-empty">暂无可用选集</p>
    </section>`;
  }

  const selectedLineIndex = selection?.lineIndex ?? catalog.lines[0]?.index ?? 0;
  const currentLine = catalog.lines.find((line) => line.index === selectedLineIndex) ?? catalog.lines[0];
  const currentEpisode = currentLine && selection?.lineIndex === currentLine.index
    ? currentLine.episodes.find((episode) => episode.index === selection.episodeIndex)
    : undefined;
  const retry = retryable && selection
    ? `<button
        type="button"
        data-testid="playback-retry"
        data-action="player-retry"
        data-line-index="${selection.lineIndex}"
        data-episode-index="${selection.episodeIndex}">重试</button>`
    : "";
  const lineButtons = catalog.lines.map((line) => `<button
        type="button"
        data-action="playback-line"
        data-line-index="${line.index}"
        aria-pressed="${line.index === selectedLineIndex}">${escapeHtml(line.name)}</button>`).join("");
  const linePanels = catalog.lines.map((line) => `<div
      data-playback-line="${line.index}"
      ${line.index === selectedLineIndex ? "" : "hidden"}>
      ${line.episodes.length === 0
        ? `<p data-testid="playback-line-empty">暂无可用选集</p>`
        : line.episodes.map((episode) => `<button
          type="button"
          data-action="player-episode"
          data-line-index="${line.index}"
          data-episode-index="${episode.index}"
          data-play-flag="${escapeHtml(line.name)}"
          data-play-id="${escapeHtml(episode.id)}">${escapeHtml(episode.name)}</button>`).join("")}
    </div>`).join("");
  return `<section data-testid="playback-selector" class="playback-selector">
    <div data-testid="playback-lines" aria-label="播放线路">${lineButtons}</div>
    <p>当前线路：<span data-testid="current-line">${escapeHtml(currentLine?.name ?? "")}</span></p>
    <p>当前选集：<span data-testid="current-episode">${escapeHtml(currentEpisode?.name ?? "未选择")}</span></p>
    <div data-testid="playback-order" aria-label="剧集顺序">
      <button type="button" data-action="playback-order" data-order="forward" aria-pressed="true">正序</button>
      <button type="button" data-action="playback-order" data-order="reverse" aria-pressed="false">倒序</button>
      ${retry}
    </div>
    <div data-testid="playback-episodes">${linePanels}</div>
  </section>`;
}

function renderPlaybackHealth(state: DesktopSpiderUiState): string {
  const health = state.playbackHealth;
  const fallback = state.fallback;
  const metric = (value: { value: unknown; samples: number }, unit = ""): string => (
    value.samples === 0 || value.value === null ? "unknown" : `${String(value.value)}${unit}`
  );
  const fallbackStatus = fallback.status === "idle" || fallback.status === "disabled"
    ? ""
    : `<div data-testid="playback-fallback-status"><strong>当前失败：${escapeHtml(fallback.trigger ?? "播放异常")}</strong>
        <span>${escapeHtml(fallback.reason ?? "")}</span>
        <span>${fallback.next ? `即将尝试线路：${escapeHtml(fallback.next.label)}` : ""}</span>
      </div>`;
  const trace = state.player.trace
    ? `<p data-testid="playback-trace">Trace ${escapeHtml(state.player.trace.id)} · ${escapeHtml(state.player.trace.stages.map((stage) => stage.stage).join(" → "))}</p>`
    : "";
  return `<section data-testid="playback-health-panel" class="playback-health-panel">
    <strong>流健康与自动线路回退</strong>
    <label>回退模式 <select data-action="playback-fallback-mode"><option value="off" ${fallback.mode === "off" ? "selected" : ""}>关闭</option><option value="prompt" ${fallback.mode === "prompt" ? "selected" : ""}>仅提示</option><option value="auto" ${fallback.mode === "auto" ? "selected" : ""}>自动</option></select></label>
    <p data-testid="playback-health-metrics">解析 ${metric(health.resolveSuccess)} · 首帧 ${metric(health.firstFrameMs, "ms")} · 缓冲 ${metric(health.bufferingCount, "次")} · 分片失败 ${metric(health.segmentFailure, "次")} · 评分 ${health.score.value === null ? "unknown" : health.score.value}</p>
    ${trace}
    ${fallbackStatus}
    <div class="player-controls">
      ${fallback.status === "prompt" ? '<button data-action="playback-fallback-approve">尝试下一条</button>' : ""}
      ${fallback.status === "prompt" || fallback.status === "trying" ? '<button data-action="playback-fallback-cancel">取消</button>' : ""}
      <button data-action="playback-fallback-debug">查看调试</button>
    </div>
  </section>`;
}

function listFrom(response: SpiderResponse): Record<string, unknown>[] {
  if (!isRecord(response.result) || !Array.isArray(response.result.list)) return [];
  return response.result.list.filter(isRecord).map((item) => ({ ...item }));
}

function subtitleContentType(format: string): string {
  return format === "vtt" ? "text/vtt" : "text/plain";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function historyResumeMode(value: unknown): HistoryResumeMode | undefined {
  return value === "continue" || value === "beginning" ? value : undefined;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function displaySource(value: string): string {
  const text = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text.length <= 64 ? text : `${text.slice(0, 36)}…${text.slice(-12)}`;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return text.length <= 64 ? text : `${text.slice(0, 36)}…${text.slice(-12)}`;
  }
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function indexValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("PLAYBACK_FORMAT_INVALID: playback selection index is invalid");
  }
  return value;
}

function clonePlaybackCatalog(catalog: PlaybackCatalog | null): PlaybackCatalog | null {
  if (!catalog) return null;
  return {
    lines: catalog.lines.map((line) => ({
      ...line,
      episodes: line.episodes.map((episode) => ({ ...episode })),
    })),
  };
}

function clonePlaybackSourceResolution(
  resolution: PlaybackSourceResolution | null,
): PlaybackSourceResolution | null {
  if (!resolution) return null;
  return {
    query: resolution.query,
    searchedSites: [...resolution.searchedSites],
    successfulSites: [...resolution.successfulSites],
    failedSites: resolution.failedSites.map((failure) => ({ ...failure })),
    diagnostics: {
      ...resolution.diagnostics,
      searchedSites: [...resolution.diagnostics.searchedSites],
      searchSuccessSites: [...resolution.diagnostics.searchSuccessSites],
      searchFailedSites: [...resolution.diagnostics.searchFailedSites],
      sites: resolution.diagnostics.sites.map((site) => ({ ...site })),
    },
    candidates: resolution.candidates.map((candidate) => ({
      ...candidate,
      vod: {
        id: candidate.vod.id,
        name: candidate.vod.name,
        raw: {},
        ...publicCandidateVodFields(candidate.vod),
      },
      ...(candidate.lines ? { lines: clonePlaybackCatalog(candidate.lines)! } : {}),
    })),
  };
}

function renderPlaybackSourceDiagnostics(
  diagnostics: PlaybackSourceResolution["diagnostics"],
): string {
  const unsupportedHint = diagnostics.runtimeSupportedSites <= 1 && diagnostics.unsupportedSiteCount > 0
    ? "多数来源因当前 Spider Runtime 尚未支持而被跳过"
    : "";
  return `<details data-testid="playback-source-diagnostics">
    <summary>查看诊断</summary>
    <p>配置 ${diagnostics.configSiteCount} 个来源 → 允许搜索 ${diagnostics.searchableSites} → QX 当前支持 ${diagnostics.runtimeSupportedSites}</p>
    <p>成功搜索 ${diagnostics.searchSuccessSites.length} → 获得 ${diagnostics.searchResultCount} 个结果 → 匹配 ${diagnostics.matchedCandidateCount} → 有播放线路 ${diagnostics.playableCandidateCount}</p>
    ${unsupportedHint ? `<p>${escapeHtml(unsupportedHint)}</p>` : ""}
    <ul>${diagnostics.sites.map((site) => `<li>${escapeHtml(site.siteName)}：初始化 ${escapeHtml(site.initialization)}，搜索 ${escapeHtml(site.search)}，结果 ${site.resultCount}${site.skipReason ? `，${escapeHtml(site.skipReason)}` : ""}</li>`).join("")}</ul>
  </details>`;
}

function publicCandidateVodFields(vod: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    "vod_id",
    "vod_name",
    "vod_year",
    "vod_area",
    "vod_class",
    "type_name",
    "vod_director",
    "vod_pic",
  ];
  return Object.fromEntries(fields.flatMap((field) => (
    Object.prototype.hasOwnProperty.call(vod, field) ? [[field, vod[field]]] : []
  )));
}

function clonePlaybackSession(session: DesktopPlaybackSession | null): DesktopPlaybackSession | null {
  if (!session) return null;
  return {
    ...session,
    media: { ...session.media },
  };
}

function cloneParserCandidate(candidate: ParserCandidate): ParserCandidate {
  return {
    ...candidate,
    ...(candidate.headers ? { headers: { ...candidate.headers } } : {}),
  };
}

function initialParseState(): ParseUiState {
  return { status: "idle", parserId: null, attempts: [], error: null };
}

function cloneParseState(state: ParseUiState): ParseUiState {
  return {
    ...state,
    attempts: state.attempts.map((attempt) => ({ ...attempt })),
    error: state.error ? { ...state.error } : null,
  };
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function danmakuSettingsPatchFromRequest(body: Record<string, unknown>): DanmakuSettingsPatch {
  const patch: DanmakuSettingsPatch = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  for (const key of ["opacity", "fontSize", "speed", "density", "displayArea", "maxActive", "maxPerSecond", "trackCount"] as const) {
    if (typeof body[key] === "number" && Number.isFinite(body[key])) patch[key] = body[key];
  }
  if (typeof body.keyword === "string") patch.keyword = body.keyword;
  if (typeof body.regex === "string") patch.regex = body.regex;
  if (Array.isArray(body.types)) {
    patch.types = body.types.filter((item): item is "scroll" | "top" | "bottom" | "reverse" =>
      item === "scroll" || item === "top" || item === "bottom" || item === "reverse");
  }
  if (Array.isArray(body.sources)) patch.sources = stringList(body.sources);
  return patch;
}

function playerMediaSyncFromRequest(body: Record<string, unknown>): PlayerMediaSync {
  const patch: PlayerMediaSync = {};
  const sessionId = optionalString(body.sessionId);
  if (sessionId) patch.sessionId = sessionId;
  if (isPlaybackStatus(body.status)) patch.status = body.status;
  if (isPlaybackTraceStage(body.stage)) patch.stage = body.stage;
  if (typeof body.currentTime === "number") patch.currentTime = body.currentTime;
  if (typeof body.duration === "number") patch.duration = body.duration;
  if (typeof body.volume === "number") patch.volume = body.volume;
  if (typeof body.muted === "boolean") patch.muted = body.muted;
  if (isRecord(body.error)
    && typeof body.error.code === "string"
    && typeof body.error.message === "string") {
    patch.error = { code: body.error.code, message: body.error.message };
  }
  const event = playbackMediaEventFromRequest(body.event);
  if (event) patch.event = event;
  return patch;
}

function playbackMediaEventFromRequest(value: unknown): PlaybackMediaEvent | undefined {
  if (!isRecord(value) || !isPlaybackMediaEventType(value.type)) return undefined;
  return {
    type: value.type,
    ...(typeof value.at === "number" && Number.isFinite(value.at) ? { at: value.at } : {}),
    ...(typeof value.code === "string" ? { code: value.code.slice(0, 80) } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 120) } : {}),
    ...(typeof value.status === "number" && Number.isInteger(value.status) ? { status: value.status } : {}),
    ...(isPlaybackTraceStage(value.stage) ? { stage: value.stage } : {}),
  };
}

function isPlaybackTraceStage(value: unknown): value is PlaybackTraceStage {
  return value === "SOURCE"
    || value === "DETAIL"
    || value === "EPISODE"
    || value === "PLAYER_CONTENT"
    || value === "MEDIA_RESOLVE"
    || value === "PROXY_START"
    || value === "MANIFEST"
    || value === "VARIANT"
    || value === "SEGMENT"
    || value === "DECODER"
    || value === "PLAYING";
}

function isPlaybackMediaEventType(value: unknown): value is PlaybackMediaEvent["type"] {
  return value === "first-frame"
    || value === "startup-timeout"
    || value === "buffer-start"
    || value === "buffer-end"
    || value === "fatal-error"
    || value === "segment-failure"
    || value === "playlist-refresh-failure"
    || value === "disconnect"
    || value === "http-status"
    || value === "completion"
    || value === "user-pause"
    || value === "seek";
}

function isPlaybackStatus(value: unknown): value is PlaybackStatus {
  return value === "idle"
    || value === "resolving"
    || value === "loading"
    || value === "playing"
    || value === "paused"
    || value === "ended"
    || value === "stopped"
    || value === "error";
}

function healthKeyFor(request: PlaybackRequest): string {
  const line = request.metadata?.lineIndex ?? "current";
  const episode = request.metadata?.episodeIndex ?? "current";
  return `playback:${line}:${episode}`;
}

function playbackFallbackTrigger(error: unknown, codeHint?: string): PlaybackFallbackTrigger {
  const code = (playbackErrorCode(error) ?? codeHint ?? "").toUpperCase();
  if (code.startsWith("PARSE_")) return "parse-failure";
  if (code.startsWith("PLAYBACK_PROXY_") || code.includes("PROXY")) return "proxy-fatal";
  if (code.startsWith("HLS_") || code.startsWith("HTML_VIDEO_") || code.startsWith("MPV_") || code.includes("FATAL")) {
    return "player-fatal";
  }
  return "player-content-failure";
}

function mediaFailureCode(trigger: PlaybackFallbackTrigger): string {
  switch (trigger) {
    case "startup-timeout": return "SOURCE_TIMEOUT";
    case "segment-errors": return "HLS_SEGMENT_FAILED";
    case "proxy-fatal": return "HLS_MANIFEST_FAILED";
    case "player-fatal": return "PLAYER_FATAL_ERROR";
    default: return "PLAYBACK_FAILURE";
  }
}

function playbackErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function playbackErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return fallback;
}

function isPlaybackFallbackMode(value: unknown): value is PlaybackFallbackMode {
  return value === "off" || value === "prompt" || value === "auto";
}

function isDetailReturnPage(value: string): value is "home" | "category" | "search" {
  return value === "home" || value === "category" || value === "search";
}

function statePatchFromRequest(body: Record<string, unknown>): DesktopStatePatch {
  const page: PageStatePatch = {};
  if (isNavigation(body.navigation)) page.navigation = body.navigation;
  if (Object.prototype.hasOwnProperty.call(body, "siteKey")) {
    page.siteKey = typeof body.siteKey === "string" ? body.siteKey : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "category")) {
    page.category = parsePageContext(body.category);
  }
  if (Object.prototype.hasOwnProperty.call(body, "search")) {
    page.search = parseSearchContext(body.search);
  }
  if (typeof body.scrollTop === "number" && Number.isFinite(body.scrollTop)) {
    page.scrollTop = body.scrollTop;
  }
  if (Object.prototype.hasOwnProperty.call(body, "recentDetailId")) {
    page.recentDetailId = typeof body.recentDetailId === "string" ? body.recentDetailId : null;
  }
  return {
    ...(isThemeMode(body.theme) ? { theme: body.theme } : {}),
    page,
  };
}

function parsePageContext(value: unknown): { typeId: string; page: number } | null {
  if (!isRecord(value) || typeof value.typeId !== "string") return null;
  return {
    typeId: value.typeId,
    page: numberValue(value.page, 1),
  };
}

function parseSearchContext(value: unknown): { key: string; page: number } | null {
  if (!isRecord(value) || typeof value.key !== "string") return null;
  return {
    key: value.key,
    page: numberValue(value.page, 1),
  };
}

function isThemeMode(value: unknown): value is "system" | "light" | "dark" {
  return value === "system" || value === "light" || value === "dark";
}

function isNavigation(value: unknown): value is "home" | "category" | "search" | "detail" | "favorites" | "follow" | "settings" | "local" | "downloads" {
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

function isCacheClearScope(value: unknown): value is CacheClearScope {
  return value === "expired" || value === "images" || value === "search" || value === "all";
}

function isStorageMode(value: unknown): value is StorageMode {
  return value === "normal" || value === "portable";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Request body is too large");
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(value) ? value : {};
}

function writeHtml(response: ServerResponse, html: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function errorLabel(code: string): string {
  if (code === "SPIDER_TIMEOUT") return "请求超时";
  if (code === "JVM_SPIDER_ERROR") return "Spider 请求失败";
  return "Spider 调用错误";
}

function fallbackCapabilities(view: DesktopSpiderView): SourceCapabilities {
  return {
    home: true,
    category: true,
    search: true,
    detail: true,
    playback: view.playback.available,
    localProxy: false,
    filters: true,
    pagination: true,
    engine: "fixture",
  };
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
