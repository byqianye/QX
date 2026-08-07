import { toAppError } from "./error.js";
import type { SubtitleTrack } from "../../src/subtitles.js";
import type { PlaybackFallbackState, PlaybackHealthSnapshot } from "../../src/health/playback-health.js";
import type { PlaybackMediaEvent } from "../../src/desktop/playback.js";
import type { HistoryResumeCandidate, HistoryUiState } from "../../src/history/history-types.js";
import type { FavoriteItem, FavoritesUiState } from "../../src/favorites/favorites-types.js";
import type { FollowItem, FollowUiState } from "../../src/follow/follow-types.js";
import type { CacheUiState } from "../../src/cache/cache-types.js";
import type { StorageUiState } from "../../src/storage/storage-types.js";
import { EMPTY_LIVE_UI_STATE } from "../../src/live/live-types.js";
import type { LiveUiState } from "../../src/live/live-types.js";
import { EMPTY_DANMAKU_UI_STATE } from "../../src/danmaku/danmaku-types.js";
import type { DanmakuUiState } from "../../src/danmaku/danmaku-types.js";
import { EMPTY_LOCAL_MEDIA_UI_STATE } from "../../src/local-media/local-media-types.js";
import type { LocalMediaUiState } from "../../src/local-media/local-media-types.js";
import { EMPTY_DOWNLOAD_UI_STATE } from "../../src/downloads/download-types.js";
import type { DownloadUiState } from "../../src/downloads/download-types.js";
import { EMPTY_PUSH_UI_STATE } from "../../src/push/push-types.js";
import type { PushUiState } from "../../src/push/push-types.js";
import { EMPTY_CAST_UI_STATE } from "../../src/cast/cast-types.js";
import type { CastUiState } from "../../src/cast/cast-types.js";

export type ImportStatus =
  | "empty"
  | "loading"
  | "confirmation_required"
  | "ready"
  | "cancelled"
  | "error";

export type SpiderStatus =
  | "confirmation_required"
  | "idle"
  | "initializing"
  | "loading"
  | "ready"
  | "error"
  | "destroyed";

export type RendererThemeMode = "system" | "light" | "dark";
export type RendererNavigation = "home" | "category" | "search" | "detail" | "history" | "favorites" | "follow" | "settings" | "live" | "local" | "downloads";
export type PlayerHostMode = "embedded" | "detached";
export const PLAYBACK_RESTORE_MAX_DRIFT_SECONDS = 2;

export type AppErrorSource =
  | "config"
  | "trust"
  | "spider"
  | "rpc"
  | "search"
  | "detail"
  | "player"
  | "proxy"
  | "video"
  | "hls"
  | "java"
  | "electron"
  | "persistence"
  | "cleanup"
  | "source"
  | "renderer";

export interface AppError {
  code: string;
  title: string;
  message: string;
  source: AppErrorSource;
  retryable: boolean;
  diagnosticId: string;
  timestamp: string;
  safeDetails: Record<string, string>;
  causeCode?: string;
}

export interface RendererPlaybackSession {
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

export interface RendererPersistenceState {
  theme: RendererThemeMode;
  navigation: RendererNavigation;
  siteKey: string | null;
  category: { typeId: string; page: number } | null;
  search: { key: string; page: number } | null;
  scrollTop: number;
  recentDetailId: string | null;
  diagnostic?: { code: string; message: string } | null;
}

export interface RendererViewStatePatch {
  theme?: RendererThemeMode;
  navigation?: RendererNavigation;
  siteKey?: string | null;
  category?: { typeId: string; page: number } | null;
  search?: { key: string; page: number } | null;
  scrollTop?: number;
  recentDetailId?: string | null;
}

export interface RendererError {
  code: string;
  message: string;
  title?: string;
  source?: AppErrorSource;
  retryable?: boolean;
  diagnosticId?: string;
  timestamp?: string;
  safeDetails?: Record<string, string>;
  causeCode?: string;
}

export interface ImportSummary {
  siteCount: number;
  liveCount: number;
  parseCount: number;
  ruleCount: number;
  hasSpider: boolean;
  topLevelKeys: string[];
  engineCounts: Record<string, number>;
}

export interface ImportSite {
  key: string;
  name: string;
  api: string;
}

export interface ImportState {
  status: ImportStatus;
  loading: boolean;
  inputKind: "url" | "file" | "json" | null;
  source: string | null;
  sourceKind: "remote" | "local" | "inline" | null;
  warning: string | null;
  error: RendererError | null;
  trusted: boolean;
  summary: ImportSummary | null;
  sites: ImportSite[];
  selectedSiteKey: string | null;
  selectedApi: string | null;
  sessionReady: boolean;
}

export type SpiderPlayback =
  | {
      available: false;
      label: string;
      message: string;
    }
  | {
      available: true;
      label: string;
      message: string;
      parse: number;
      url: string;
      headers: Record<string, string>;
      subtitles?: readonly SubtitleTrack[];
    };

export interface SpiderState {
  source: string;
  api: string | null;
  status: SpiderStatus;
  warning: string | null;
  sidecarRunning: boolean;
}

export interface BrowseState {
  page: "import" | "home" | "category" | "search" | "detail" | "closed";
  loading: boolean;
  items: Record<string, unknown>[];
}

export interface PlaybackEpisode {
  index: number;
  name: string;
  id: string;
}

export interface PlaybackLine {
  index: number;
  name: string;
  protocol?: "MP4" | "HLS";
  status?: "ready" | "proxy-required" | "unavailable";
  episodes: PlaybackEpisode[];
}

export interface PlaybackCatalog {
  lines: PlaybackLine[];
}

export interface PlaybackSelection {
  lineIndex: number;
  episodeIndex: number;
}

export interface PlayerSource {
  parse: number;
  url: string;
  headers: Record<string, string>;
  subtitles?: readonly SubtitleTrack[];
}

export interface PlayerParseState {
  status: "idle" | "resolving" | "attempting" | "failed" | "succeeded" | "cancelled";
  parserId: string | null;
  attempts: readonly {
    parserId: string;
    parserType: string;
    status: "timeout" | "error" | "succeeded";
    elapsedMs: number;
    code?: string;
    message?: string;
  }[];
  error: RendererError | null;
}

export interface PlayerState {
  status: "idle" | "resolving" | "loading" | "playing" | "paused" | "ended" | "stopped" | "error";
  source: PlayerSource | null;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  error: RendererError | null;
  parse?: PlayerParseState;
}

export interface PlayerMediaSync {
  status?: PlayerState["status"];
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  error?: RendererError;
  event?: PlaybackMediaEvent;
}

export interface DetailState {
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: PlaybackSelection | null;
  canPlay: boolean;
}

export interface PlaybackState {
  playback: SpiderPlayback;
  player: PlayerState;
  session: RendererPlaybackSession | null;
  health: PlaybackHealthSnapshot;
  fallback: PlaybackFallbackState;
}

export interface ErrorState {
  error: AppError | null;
}

export interface RendererState {
  ready: boolean;
  import: ImportState;
  spider: SpiderState;
  browse: BrowseState;
  detail: DetailState;
  playback: PlaybackState;
  history: HistoryUiState;
  historyResume: HistoryResumeCandidate | null;
  favorites: FavoritesUiState;
  favoriteDetail: FavoriteItem | null;
  follow: FollowUiState;
  followDetail: FollowItem | null;
  cache: CacheUiState;
  storage: StorageUiState;
  danmaku: DanmakuUiState;
  localMedia: LocalMediaUiState;
  downloads: DownloadUiState;
  push: PushUiState;
  cast: CastUiState;
  live: LiveUiState;
  error: ErrorState;
}

export interface ApiSpiderState {
  page: BrowseState["page"];
  source: string;
  api: string | null;
  status: SpiderStatus;
  loading: boolean;
  warning: string | null;
  error: RendererError | null;
  sidecarRunning: boolean;
  playback: SpiderPlayback;
  player: PlayerState;
  canPlay: boolean;
  items: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: PlaybackSelection | null;
  playerHost?: PlayerHostMode;
  playbackSession?: RendererPlaybackSession | null;
  playbackHealth?: PlaybackHealthSnapshot;
  fallback?: PlaybackFallbackState;
  history?: HistoryUiState;
  historyResume?: HistoryResumeCandidate | null;
  favorites?: FavoritesUiState;
  favoriteDetail?: FavoriteItem | null;
  follow?: FollowUiState;
  followDetail?: FollowItem | null;
  cache?: CacheUiState;
  storage?: StorageUiState;
  danmaku?: DanmakuUiState;
  live?: LiveUiState;
  localMedia?: LocalMediaUiState;
  downloads?: DownloadUiState;
  push?: PushUiState;
  cast?: CastUiState;
}

export interface RendererEnvelope {
  import?: ImportState | null;
  state?: ApiSpiderState | null;
  persistence?: RendererPersistenceState | null;
  live?: LiveUiState | null;
  localMedia?: LocalMediaUiState | null;
  downloads?: DownloadUiState | null;
  push?: PushUiState | null;
  cast?: CastUiState | null;
  error?: string;
  errorCode?: string;
}

export function createRendererState(): RendererState {
  return {
    ready: false,
    import: {
      status: "empty",
      loading: false,
      inputKind: null,
      source: null,
      sourceKind: null,
      warning: null,
      error: null,
      trusted: false,
      summary: null,
      sites: [],
      selectedSiteKey: null,
      selectedApi: null,
      sessionReady: false,
    },
    spider: {
      source: "",
      api: null,
      status: "confirmation_required",
      warning: null,
      sidecarRunning: false,
    },
    browse: { page: "import", loading: false, items: [] },
    detail: {
      detail: null,
      playbackCatalog: null,
      playbackSelection: null,
      canPlay: false,
    },
    playback: {
      playback: {
        available: false,
        label: "等待播放",
        message: "选择条目后解析播放地址。",
      },
      player: emptyPlayerState(),
      session: null,
      health: emptyPlaybackHealth(),
      fallback: emptyPlaybackFallback(),
    },
    history: { items: [], paused: false },
    historyResume: null,
    favorites: { items: [], groups: [], defaultGroupId: "default" },
    favoriteDetail: null,
    follow: { items: [], checking: false, updateCount: 0 },
    followDetail: null,
    cache: { totalBytes: 0, maxBytes: 0, entries: 0, byType: [] },
    storage: { mode: "normal", dataRoot: "—", normalRoot: "—", portableRoot: "—", databaseBytes: 0, cacheBytes: 0, totalBytes: 0, historyCount: 0, favoritesCount: 0, followCount: 0, writable: false, switching: false, error: null },
    danmaku: cloneDanmakuState(EMPTY_DANMAKU_UI_STATE),
    localMedia: cloneLocalMediaState(EMPTY_LOCAL_MEDIA_UI_STATE),
    downloads: cloneDownloadState(EMPTY_DOWNLOAD_UI_STATE),
    push: clonePushState(EMPTY_PUSH_UI_STATE),
    cast: cloneCastState(EMPTY_CAST_UI_STATE),
    live: cloneLiveUiState(EMPTY_LIVE_UI_STATE),
    error: { error: null },
  };
}

export function applyRendererEnvelope(
  current: RendererState,
  envelope: RendererEnvelope,
): RendererState {
  const importState = envelope.import ? cloneImportState(envelope.import) : current.import;
  const state = envelope.state;
  const live = envelope.live
    ? cloneLiveUiState(envelope.live)
    : state?.live
      ? cloneLiveUiState(state.live)
      : current.live;
  const localMedia = envelope.localMedia
    ? cloneLocalMediaState(envelope.localMedia)
    : state?.localMedia
      ? cloneLocalMediaState(state.localMedia)
      : current.localMedia;
  const downloads = envelope.downloads
    ? cloneDownloadState(envelope.downloads)
    : state?.downloads
      ? cloneDownloadState(state.downloads)
      : current.downloads;
  const push = envelope.push
    ? clonePushState(envelope.push)
    : state?.push
      ? clonePushState(state.push)
      : current.push;
  const cast = envelope.cast
    ? cloneCastState(envelope.cast)
    : state?.cast
      ? cloneCastState(state.cast)
      : current.cast;
  const envelopeError = envelope.error
    ? { code: envelope.errorCode ?? "RENDERER_REQUEST_ERROR", message: envelope.error }
    : null;
  if (!state) {
    const nextError = importState.error ?? envelopeError;
    return {
      ...current,
      ready: true,
      import: importState,
      live,
      localMedia,
      downloads,
      push,
      cast,
      error: {
        error: toAppError(nextError) ?? current.error.error,
      },
    };
  }

  const stateError = state.error ?? importState.error ?? envelopeError;
  return {
    ready: true,
    import: importState,
    spider: {
      source: state.source,
      api: state.api,
      status: state.status,
      warning: state.warning,
      sidecarRunning: state.sidecarRunning,
    },
    browse: {
      page: state.page,
      loading: state.loading,
      items: state.items.map((item) => ({ ...item })),
    },
    detail: {
      detail: state.detail ? { ...state.detail } : null,
      playbackCatalog: clonePlaybackCatalog(state.playbackCatalog),
      playbackSelection: state.playbackSelection ? { ...state.playbackSelection } : null,
      canPlay: state.canPlay,
    },
    playback: {
      playback: cloneSpiderPlayback(state.playback),
      player: clonePlayerState(state.player),
      session: clonePlaybackSession(state.playbackSession ?? null),
      health: clonePlaybackHealth(state.playbackHealth ?? current.playback.health),
      fallback: clonePlaybackFallback(state.fallback ?? current.playback.fallback),
    },
    history: cloneHistoryState(state.history ?? current.history),
    historyResume: state.historyResume ? { ...state.historyResume } : null,
    favorites: cloneFavoritesState(state.favorites ?? current.favorites),
    favoriteDetail: state.favoriteDetail ? { ...state.favoriteDetail } : null,
    follow: cloneFollowState(state.follow ?? current.follow),
    followDetail: state.followDetail ? { ...state.followDetail } : null,
    cache: cloneCacheState(state.cache ?? current.cache),
    storage: cloneStorageState(state.storage ?? current.storage),
    danmaku: cloneDanmakuState(state.danmaku ?? current.danmaku),
    localMedia,
    downloads,
    push,
    cast,
    live,
    error: { error: toAppError(stateError) },
  };
}

function cloneLiveUiState(value: LiveUiState): LiveUiState {
  return {
    sources: value.sources.map((source) => ({ ...source })),
    preview: value.preview
      ? {
          ...value.preview,
          source: { ...value.preview.source },
          channelNames: [...value.preview.channelNames],
          issues: value.preview.issues.map((issue) => ({ ...issue })),
          stats: {
            ...value.preview.stats,
            protocolCounts: { ...value.preview.stats.protocolCounts },
          },
        }
      : null,
    loading: value.loading,
    error: value.error ? { ...value.error } : null,
    catalog: {
      groups: value.catalog.groups.map((group) => ({ ...group })),
      channels: value.catalog.channels.map((channel) => ({
        ...channel,
        streams: channel.streams.map((stream) => ({
          ...stream,
          health: stream.health
            ? {
                ...stream.health,
                startupSuccess: { ...stream.health.startupSuccess },
                firstFrameMs: { ...stream.health.firstFrameMs },
                playlistRefreshFailure: { ...stream.health.playlistRefreshFailure },
                segmentFailure: { ...stream.health.segmentFailure },
                bufferCount: { ...stream.health.bufferCount },
                bufferDuration: { ...stream.health.bufferDuration },
                fatalError: { ...stream.health.fatalError },
                disconnectCount: { ...stream.health.disconnectCount },
                uptimeMs: { ...stream.health.uptimeMs },
                scoreReasons: [...stream.health.scoreReasons],
              }
            : null,
        })),
        currentProgramme: channel.currentProgramme ? { ...channel.currentProgramme } : null,
        nextProgramme: channel.nextProgramme ? { ...channel.nextProgramme } : null,
      })),
      recent: value.catalog.recent.map((recent) => ({ ...recent })),
    },
    session: value.session
      ? { ...value.session, error: value.session.error ? { ...value.session.error } : null }
      : null,
    player: value.player
      ? {
          ...value.player,
          source: value.player.source
            ? { ...value.player.source, headers: { ...value.player.source.headers } }
            : null,
          error: value.player.error ? { ...value.player.error } : null,
        }
      : null,
    health: value.health
      ? {
          ...value.health,
          startupSuccess: { ...value.health.startupSuccess },
          firstFrameMs: { ...value.health.firstFrameMs },
          playlistRefreshFailure: { ...value.health.playlistRefreshFailure },
          segmentFailure: { ...value.health.segmentFailure },
          bufferCount: { ...value.health.bufferCount },
          bufferDuration: { ...value.health.bufferDuration },
          fatalError: { ...value.health.fatalError },
          disconnectCount: { ...value.health.disconnectCount },
          uptimeMs: { ...value.health.uptimeMs },
          scoreReasons: [...value.health.scoreReasons],
        }
      : null,
    failover: {
      ...value.failover,
      tried: [...value.failover.tried],
      current: value.failover.current ? { ...value.failover.current } : null,
      next: value.failover.next ? { ...value.failover.next } : null,
    },
    epg: {
      sources: value.epg.sources.map((source) => ({ ...source })),
      preview: value.epg.preview
        ? {
            ...value.epg.preview,
            source: { ...value.epg.preview.source },
            channelNames: [...value.epg.preview.channelNames],
            issues: value.epg.preview.issues.map((issue) => ({ ...issue })),
            stats: { ...value.epg.preview.stats },
          }
        : null,
      loading: value.epg.loading,
      error: value.epg.error ? { ...value.epg.error } : null,
      retention: { ...value.epg.retention },
      mappings: value.epg.mappings.map((mapping) => ({
        ...mapping,
        aliases: [...mapping.aliases],
        candidates: mapping.candidates.map((candidate) => ({ ...candidate })),
        mapping: mapping.mapping ? { ...mapping.mapping } : null,
      })),
      timeline: value.epg.timeline
        ? {
            ...value.epg.timeline,
            items: value.epg.timeline.items.map((item) => ({ ...item })),
          }
        : null,
    },
    smartChannels: value.smartChannels.map((channel) => ({
      ...channel,
      members: channel.members.map((member) => ({ ...member })),
      epg: {
        ...channel.epg,
        currentProgramme: channel.epg.currentProgramme ? { ...channel.epg.currentProgramme } : null,
        nextProgramme: channel.epg.nextProgramme ? { ...channel.epg.nextProgramme } : null,
      },
    })),
    smartSuggestions: value.smartSuggestions.map((suggestion) => ({
      ...suggestion,
      memberIds: [...suggestion.memberIds],
    })),
    activeSmartChannel: value.activeSmartChannel ? { ...value.activeSmartChannel } : null,
  };
}

function clonePushState(value: PushUiState): PushUiState {
  return {
    ...value,
    pending: value.pending.map((item) => ({ ...item })),
    recent: value.recent.map((item) => ({ ...item, error: item.error ? { ...item.error } : null })),
    activeSession: value.activeSession ? { ...value.activeSession } : null,
    error: value.error ? { ...value.error } : null,
  };
}

function cloneImportState(state: ImportState): ImportState {
  return {
    ...state,
    error: cloneRendererError(state.error),
    summary: state.summary
      ? { ...state.summary, topLevelKeys: [...state.summary.topLevelKeys], engineCounts: { ...state.summary.engineCounts } }
      : null,
    sites: state.sites.map((site) => ({ ...site })),
  };
}

function cloneSpiderPlayback(playback: SpiderPlayback): SpiderPlayback {
  return playback.available
    ? {
        ...playback,
        headers: {},
        ...(playback.subtitles ? { subtitles: playback.subtitles.map(cloneSubtitleTrack) } : {}),
      }
    : { ...playback };
}

function clonePlaybackCatalog(catalog: PlaybackCatalog | null): PlaybackCatalog | null {
  return catalog
    ? {
        lines: catalog.lines.map((line) => ({
          ...line,
          episodes: line.episodes.map((episode) => ({ ...episode })),
        })),
      }
    : null;
}

function clonePlayerState(player: PlayerState): PlayerState {
  return {
    ...player,
    source: player.source
      ? {
          ...player.source,
          headers: { ...player.source.headers },
          ...(player.source.subtitles ? { subtitles: player.source.subtitles.map(cloneSubtitleTrack) } : {}),
        }
      : null,
    error: toAppError(player.error),
    ...(player.parse
      ? {
          parse: {
            ...player.parse,
            attempts: player.parse.attempts.map((attempt) => ({ ...attempt })),
            error: cloneRendererError(player.parse.error),
          },
        }
      : {}),
  };
}

function cloneSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  return {
    ...track,
    ...(track.headers ? { headers: { ...track.headers } } : {}),
  };
}

function cloneRendererError(error: RendererError | null): RendererError | null {
  return error
    ? { ...error, ...(error.safeDetails ? { safeDetails: { ...error.safeDetails } } : {}) }
    : null;
}

function clonePlaybackSession(session: RendererPlaybackSession | null): RendererPlaybackSession | null {
  if (!session) return null;
  return { ...session, media: { ...session.media } };
}

function clonePlaybackHealth(snapshot: PlaybackHealthSnapshot): PlaybackHealthSnapshot {
  return {
    ...snapshot,
    resolveSuccess: { ...snapshot.resolveSuccess },
    firstFrameMs: { ...snapshot.firstFrameMs },
    startupFailure: { ...snapshot.startupFailure },
    bufferingCount: { ...snapshot.bufferingCount },
    bufferingDuration: { ...snapshot.bufferingDuration },
    fatalError: { ...snapshot.fatalError },
    httpStatus: { ...snapshot.httpStatus },
    segmentFailure: { ...snapshot.segmentFailure },
    playbackDuration: { ...snapshot.playbackDuration },
    completion: { ...snapshot.completion },
    lastSuccess: { ...snapshot.lastSuccess },
    consecutiveFailures: { ...snapshot.consecutiveFailures },
    score: { ...snapshot.score, reasons: [...snapshot.score.reasons] },
    events: snapshot.events.map((event) => ({ ...event, safeDetails: { ...event.safeDetails } })),
  };
}

function clonePlaybackFallback(state: PlaybackFallbackState): PlaybackFallbackState {
  return {
    ...state,
    current: state.current ? { ...state.current } : null,
    next: state.next ? { ...state.next } : null,
    tried: [...state.tried],
  };
}

function cloneHistoryState(state: HistoryUiState): HistoryUiState {
  return {
    paused: state.paused,
    items: state.items.map((item) => ({ ...item })),
  };
}

function cloneFavoritesState(state: FavoritesUiState): FavoritesUiState {
  return {
    defaultGroupId: state.defaultGroupId,
    groups: state.groups.map((group) => ({ ...group })),
    items: state.items.map((item) => ({ ...item })),
  };
}

function cloneFollowState(state: FollowUiState): FollowUiState {
  return {
    checking: state.checking,
    updateCount: state.updateCount,
    items: state.items.map((item) => ({ ...item })),
  };
}

function cloneCacheState(state: CacheUiState): CacheUiState {
  return {
    totalBytes: state.totalBytes,
    maxBytes: state.maxBytes,
    entries: state.entries,
    byType: state.byType.map((item) => ({ ...item })),
  };
}

function cloneStorageState(state: StorageUiState): StorageUiState {
  return { ...state };
}

function cloneLocalMediaState(state: LocalMediaUiState): LocalMediaUiState {
  return {
    ready: state.ready,
    folders: state.folders.map((folder) => ({ ...folder })),
    items: state.items.map((item) => ({
      ...item,
      subtitleTracks: item.subtitleTracks.map((track) => ({ ...track })),
    })),
    activeItemId: state.activeItemId,
    scan: { ...state.scan },
    error: state.error ? { ...state.error } : null,
    limits: { ...state.limits },
  };
}

function cloneDownloadState(state: DownloadUiState): DownloadUiState {
  return {
    tasks: state.tasks.map((task) => ({ ...task })),
    targetDirectories: state.targetDirectories.map((directory) => ({ ...directory })),
    backend: state.backend,
    aria2Available: state.aria2Available,
    error: state.error ? { ...state.error } : null,
  };
}

function cloneCastState(state: CastUiState): CastUiState {
  return {
    discoveryStatus: state.discoveryStatus,
    devices: state.devices.map((device) => ({
      ...device,
      capabilities: { ...device.capabilities },
    })),
    session: state.session
      ? {
          ...state.session,
          device: {
            ...state.session.device,
            capabilities: { ...state.session.device.capabilities },
          },
          media: { ...state.session.media },
          error: state.session.error ? { ...state.session.error } : null,
        }
      : null,
    error: state.error ? { ...state.error } : null,
  };
}

function cloneDanmakuState(state: DanmakuUiState): DanmakuUiState {
  return {
    ...state,
    settings: {
      ...state.settings,
      types: [...state.settings.types],
      sources: [...state.settings.sources],
    },
    sources: [...state.sources],
    items: state.items.map((item) => ({ ...item })),
    error: state.error ? { ...state.error } : null,
  };
}

function emptyPlaybackHealth(): PlaybackHealthSnapshot {
  const metric = <T>(): { value: T | null; samples: number } => ({ value: null, samples: 0 });
  return {
    sourceId: "当前播放线路",
    resolveSuccess: metric<boolean>(),
    firstFrameMs: metric<number>(),
    startupFailure: metric<number>(),
    bufferingCount: metric<number>(),
    bufferingDuration: metric<number>(),
    fatalError: metric<number>(),
    httpStatus: metric<number>(),
    segmentFailure: metric<number>(),
    playbackDuration: metric<number>(),
    completion: metric<boolean>(),
    lastSuccess: metric<number>(),
    consecutiveFailures: metric<number>(),
    score: { value: null, reasons: ["样本不足"] },
    events: [],
  };
}

function emptyPlaybackFallback(): PlaybackFallbackState {
  return {
    mode: "prompt",
    status: "idle",
    trigger: null,
    reason: null,
    current: null,
    next: null,
    attempts: 0,
    maxAttempts: 4,
    tried: [],
    startedAt: null,
    deadlineAt: null,
  };
}

function emptyPlayerState(): PlayerState {
  return {
    status: "idle",
    source: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    fullscreen: false,
    error: null,
  };
}
