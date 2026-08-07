import type { PlaybackState } from "../desktop/playback.js";
import type { EpgMappingStatus, EpgProgrammeUiState, EpgUiState } from "../epg/epg-types.js";

export type SmartChannelEpgMode = "explicit" | "inherited" | "conflict" | "unavailable" | "unmapped";

export interface SmartChannelRecord {
  id: string;
  name: string;
  logo: string | null;
  group: string | null;
  sortOrder: number;
  preferredMemberId: string | null;
  epgSourceId: string | null;
  epgChannelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SmartChannelMemberRecord {
  id: string;
  smartChannelId: string;
  liveChannelId: string;
  priority: number;
  enabled: boolean;
}

export interface SmartChannelEpgUiState {
  mode: SmartChannelEpgMode;
  sourceId: string | null;
  channelId: string | null;
  sourceName: string | null;
  channelName: string | null;
  currentProgramme: EpgProgrammeUiState | null;
  nextProgramme: EpgProgrammeUiState | null;
}

export interface SmartChannelMemberUiState extends SmartChannelMemberRecord {
  channelName: string;
  sourceName: string;
  available: boolean;
  healthScore: number | null;
}

export interface SmartChannelSuggestionUiState {
  id: string;
  name: string;
  memberIds: readonly string[];
  reason: "exact-tvg-id" | "exact-name" | "shared-epg";
  confidence: "exact" | "high";
}

export interface SmartChannelUiState {
  id: string;
  name: string;
  logo: string | null;
  group: string | null;
  sortOrder: number;
  preferredMemberId: string | null;
  currentMemberId: string | null;
  currentSourceName: string | null;
  available: boolean;
  members: readonly SmartChannelMemberUiState[];
  epg: SmartChannelEpgUiState;
}

export interface SmartPlaybackUiState {
  smartChannelId: string;
  smartChannelName: string;
  memberId: string;
  liveChannelId: string;
  sourceName: string;
  channelName: string;
}

export type LiveFailoverMode = "off" | "ask" | "auto";
export type LiveFailoverStatus = "idle" | "prompt" | "trying" | "recovered" | "cancelled" | "stopped" | "disabled";
export type LiveFailoverTrigger =
  | "startup-failure"
  | "startup-timeout"
  | "playlist-failures"
  | "segment-errors"
  | "fatal-error"
  | "long-buffer"
  | "backend-crash";

export interface LiveHealthMetricUiState<T> {
  value: T | null;
  samples: number;
}

export interface LiveStreamHealthUiState {
  streamId: string;
  sourceId: string;
  startupSuccess: LiveHealthMetricUiState<boolean>;
  firstFrameMs: LiveHealthMetricUiState<number>;
  playlistRefreshFailure: LiveHealthMetricUiState<number>;
  segmentFailure: LiveHealthMetricUiState<number>;
  bufferCount: LiveHealthMetricUiState<number>;
  bufferDuration: LiveHealthMetricUiState<number>;
  fatalError: LiveHealthMetricUiState<number>;
  disconnectCount: LiveHealthMetricUiState<number>;
  uptimeMs: LiveHealthMetricUiState<number>;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  score: number | null;
  scoreReasons: readonly string[];
  cooldownUntil: number | null;
}

export interface LiveFailoverCandidateUiState {
  id: string;
  channelId: string;
  streamId: string;
  sourceId: string;
  sourceName: string;
  channelName: string;
  streamLabel: string;
  memberId: string | null;
  smartChannelId: string | null;
  healthScore: number | null;
}

export interface LiveFailoverUiState {
  mode: LiveFailoverMode;
  status: LiveFailoverStatus;
  trigger: LiveFailoverTrigger | null;
  reason: string | null;
  current: LiveFailoverCandidateUiState | null;
  next: LiveFailoverCandidateUiState | null;
  attempts: number;
  maxAttempts: number;
  tried: readonly string[];
  startedAt: number | null;
  deadlineAt: number | null;
  cooldownUntil: number | null;
  manualOverrideUntil: number | null;
}

export const EMPTY_LIVE_FAILOVER_UI_STATE: LiveFailoverUiState = {
  mode: "ask",
  status: "idle",
  trigger: null,
  reason: null,
  current: null,
  next: null,
  attempts: 0,
  maxAttempts: 3,
  tried: [],
  startedAt: null,
  deadlineAt: null,
  cooldownUntil: null,
  manualOverrideUntil: null,
};

export const LIVE_SOURCE_TYPES = [
  "m3u-url",
  "m3u-file",
  "txt-url",
  "txt-file",
  "fixture",
] as const;

export type LiveSourceType = typeof LIVE_SOURCE_TYPES[number];
export type LiveSourceFormat = "m3u" | "txt";
export type LiveRefreshMode = "manual" | "startup" | "interval";

export interface LiveSourceRecord {
  id: string;
  name: string;
  type: LiveSourceType;
  location: string;
  enabled: boolean;
  refreshMode: LiveRefreshMode;
  lastUpdatedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface LiveChannelRecord {
  id: string;
  sourceId: string;
  externalId: string | null;
  name: string;
  normalizedName: string;
  group: string | null;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
  tvgLogo: string | null;
  tvgChno: string | null;
  catchup: string | null;
  attributes: Record<string, string>;
  enabled: boolean;
  sortOrder: number;
}

export interface LiveChannelStreamRecord {
  id: string;
  channelId: string;
  url: string;
  headers: Record<string, string>;
  priority: number;
  label: string | null;
  protocol: string | null;
}

export interface LiveChannelWithStreams extends LiveChannelRecord {
  streams: readonly LiveChannelStreamRecord[];
}

export interface LiveRecentRecord {
  channelId: string;
  sourceId: string;
  lastPlayedAt: number;
  lastStreamId: string | null;
}

export type LivePlaybackSessionState =
  | "idle"
  | "resolving"
  | "loading"
  | "playing"
  | "buffering"
  | "switching"
  | "error"
  | "stopped";

export type LivePlaybackBackend = "html-video" | "hls-js" | "mpv";

export interface LivePlaybackSessionUiState {
  sessionId: string;
  sourceId: string;
  channelId: string;
  streamId: string;
  smartChannelId: string | null;
  smartMemberId: string | null;
  state: LivePlaybackSessionState;
  backend: LivePlaybackBackend;
  startedAt: number;
  firstFrameAt: number | null;
  error: LiveUiError | null;
  generation: number;
}

export interface LiveChannelStreamUiState {
  id: string;
  label: string;
  protocol: string;
  status: "ready" | "unsupported";
  health?: LiveStreamHealthUiState | null;
}

export interface LiveChannelUiState {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  group: string | null;
  logo: string | null;
  channelNumber: string | null;
  streamCount: number;
  streams: readonly LiveChannelStreamUiState[];
  epgStatus: EpgMappingStatus;
  currentProgramme: EpgProgrammeUiState | null;
  nextProgramme: EpgProgrammeUiState | null;
  health: LiveStreamHealthUiState | null;
}

export interface LiveChannelGroupUiState {
  id: string;
  name: string;
  channelCount: number;
}

export interface LiveRecentUiState extends LiveRecentRecord {
  channelName: string;
  sourceName: string;
}

export interface LiveCatalogUiState {
  groups: readonly LiveChannelGroupUiState[];
  channels: readonly LiveChannelUiState[];
  recent: readonly LiveRecentUiState[];
}

export interface LiveImportIssue {
  line: number;
  code: string;
  message: string;
  raw: string | null;
}

export interface LiveImportStats {
  channelCount: number;
  groupCount: number;
  streamCount: number;
  invalidCount: number;
  protocolCounts: Record<string, number>;
  addedCount: number;
  removedCount: number;
  changedCount: number;
}

export interface LiveImportPreview {
  id: string;
  source: LiveSourceRecord;
  channels: readonly LiveChannelWithStreams[];
  issues: readonly LiveImportIssue[];
  stats: LiveImportStats;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

export interface LivePreviewUiState {
  id: string;
  source: LiveSourceRecord;
  channelNames: readonly string[];
  issues: readonly LiveImportIssue[];
  stats: LiveImportStats;
}

export interface LiveSourceUiState extends LiveSourceRecord {
  channelCount: number;
  groupCount: number;
  streamCount: number;
}

export interface LiveUiError {
  code: string;
  message: string;
}

export interface LiveUiState {
  sources: readonly LiveSourceUiState[];
  preview: LivePreviewUiState | null;
  loading: boolean;
  error: LiveUiError | null;
  catalog: LiveCatalogUiState;
  session: LivePlaybackSessionUiState | null;
  player: PlaybackState | null;
  epg: EpgUiState;
  smartChannels: readonly SmartChannelUiState[];
  smartSuggestions: readonly SmartChannelSuggestionUiState[];
  activeSmartChannel: SmartPlaybackUiState | null;
  health: LiveStreamHealthUiState | null;
  failover: LiveFailoverUiState;
}

export type LiveSourceImportInput =
  | {
      name: string;
      type: "m3u-url" | "txt-url";
      location: string;
      sourceId?: string;
    }
  | {
      name: string;
      type: "m3u-file" | "txt-file";
      fileName: string;
      content?: string;
      filePath?: string;
      location?: string;
      sourceId?: string;
    }
  | {
      name: string;
      type: "fixture";
      format: LiveSourceFormat;
      content: string;
      location?: string;
      sourceId?: string;
    };

export function isLiveSourceType(value: unknown): value is LiveSourceType {
  return typeof value === "string" && (LIVE_SOURCE_TYPES as readonly string[]).includes(value);
}

export function liveFormatForType(type: LiveSourceType): LiveSourceFormat {
  return type === "txt-url" || type === "txt-file" ? "txt" : "m3u";
}

export const EMPTY_LIVE_UI_STATE: LiveUiState = {
  sources: [],
  preview: null,
  loading: false,
  error: null,
  catalog: { groups: [], channels: [], recent: [] },
  session: null,
  player: null,
  epg: {
    sources: [],
    preview: null,
    loading: false,
    error: null,
    retention: { pastRetentionMs: 6 * 60 * 60 * 1000, futureRetentionMs: 7 * 24 * 60 * 60 * 1000 },
    mappings: [],
    timeline: null,
  },
  smartChannels: [],
  smartSuggestions: [],
  activeSmartChannel: null,
  health: null,
  failover: EMPTY_LIVE_FAILOVER_UI_STATE,
};
