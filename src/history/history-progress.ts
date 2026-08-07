import { createHash } from "node:crypto";

import {
  HistoryRepository,
  PlaybackProgressRepository,
  SettingsRepository,
  type HistoryRecord,
  type PlaybackProgressRecord,
} from "../data/repositories.js";
import {
  PlaybackProgressWriter,
  type PlaybackProgressWriterOptions,
  type ProgressFlushReason,
} from "../data/progress-writer.js";
import type { SqliteDataLayer } from "../data/sqlite.js";
import {
  EMPTY_HISTORY_UI_STATE,
  type ContentIdentity,
  type HistoryCatalogEpisode,
  type HistoryItem,
  type HistoryPlaybackContext,
  type HistoryResumeCandidate,
  type HistoryResumeMode,
  type HistoryUiState,
} from "./history-types.js";

export const HISTORY_RECORDING_PAUSED_KEY = "history-recording-paused";
export const HISTORY_COMPLETION_RATIO = 0.9;
export const HISTORY_COMPLETION_REMAINING_SECONDS = 90;
export const HISTORY_COMPLETION_MIN_DURATION_SECONDS = 60;
export const HISTORY_COMPLETION_REMAINING_MIN_DURATION_SECONDS = 300;

export interface HistoryMediaSnapshot {
  status?: string;
  currentTime?: number;
  duration?: number;
  event?: { type?: string };
}

export interface CreateHistoryContextInput {
  source: string;
  vodId: string;
  seasonId?: string | null;
  episodeId: string;
  title?: string | null;
  poster?: string | null;
  episode?: number | null;
  episodeName?: string | null;
  playbackLine?: string | null;
  sourceType?: "remote" | "local";
}

export interface HistoryProgressServiceOptions {
  db: SqliteDataLayer;
  history: HistoryRepository;
  progress: PlaybackProgressRepository;
  settings: SettingsRepository;
  now?: () => number;
  writerOptions?: Omit<PlaybackProgressWriterOptions, "onFlush">;
}

interface ActivePlayback {
  context: HistoryPlaybackContext;
  latest: PlaybackProgressRecord;
  started: boolean;
}

export function sourceIdForHistory(source: string): string {
  const normalized = normalizeSourceKey(source);
  return `source:${sha256(normalized).slice(0, 24)}`;
}

export function sourceDisplayNameForHistory(source: string): string {
  const text = cleanText(source);
  if (text.startsWith("local:")) return "本地媒体";
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host.slice(0, 96);
    if (url.protocol === "file:") return "本地来源";
  } catch {
    // Inline and legacy source descriptors are handled below.
  }
  if (text.startsWith("inline:")) return safeHistoryLabel(text.slice(7), "内置来源") ?? "内置来源";
  return "当前来源";
}

export function safeHistoryIdentifier(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text) return null;
  if (looksSensitive(text) || looksLikeUrl(text)) return `id:${sha256(text).slice(0, 32)}`;
  return text.slice(0, 256);
}

export function historyIdentity(identity: ContentIdentity): string {
  return [identity.sourceId, identity.vodId, identity.seasonId, identity.episodeId]
    .map((value) => Buffer.from(value ?? "", "utf8").toString("base64url"))
    .join(".");
}

export function createHistoryContext(input: CreateHistoryContextInput): HistoryPlaybackContext | null {
  const sourceId = sourceIdForHistory(input.source);
  const vodId = safeHistoryIdentifier(input.vodId);
  const episodeId = safeHistoryIdentifier(input.episodeId);
  if (!vodId || !episodeId) return null;
  const identity: ContentIdentity = {
    sourceId,
    vodId,
    seasonId: safeHistoryIdentifier(input.seasonId),
    episodeId,
  };
  return {
    identity,
    title: safeHistoryLabel(input.title, vodId) ?? vodId,
    poster: safePoster(input.poster),
    episode: safeEpisodeNumber(input.episode),
    episodeName: safeHistoryLabel(input.episodeName),
    playbackLine: safeHistoryLabel(input.playbackLine),
    sourceDisplayName: sourceDisplayNameForHistory(input.source),
    ...(input.sourceType === "local" ? { sourceType: "local" as const } : {}),
  };
}

export function isHistoryCompleted(
  position: number,
  duration: number,
  ended = false,
): boolean {
  if (ended) return true;
  if (!Number.isFinite(position) || !Number.isFinite(duration)) return false;
  const safePosition = Math.max(0, position);
  const safeDuration = Math.max(0, duration);
  if (safeDuration < HISTORY_COMPLETION_MIN_DURATION_SECONDS || safePosition <= 0) return false;
  return safePosition / safeDuration >= HISTORY_COMPLETION_RATIO
    || (safeDuration >= HISTORY_COMPLETION_REMAINING_MIN_DURATION_SECONDS
      && safeDuration - safePosition <= HISTORY_COMPLETION_REMAINING_SECONDS);
}

export class HistoryProgressService {
  private readonly now: () => number;
  private readonly writer: PlaybackProgressWriter;
  private active: ActivePlayback | null = null;

  public constructor(private readonly options: HistoryProgressServiceOptions) {
    this.now = options.now ?? Date.now;
    this.writer = new PlaybackProgressWriter(options.progress, {
      ...options.writerOptions,
      onFlush: (record, reason) => this.persistHistoryProgress(record, reason),
    });
  }

  public get paused(): boolean {
    return this.options.settings.get<boolean>(HISTORY_RECORDING_PAUSED_KEY) === true;
  }

  public uiState(): HistoryUiState {
    const items = this.options.history.list().map((record) => this.itemWithLatestProgress(record));
    return {
      items,
      paused: this.paused,
    };
  }

  public begin(context: HistoryPlaybackContext): void {
    if (this.active) this.flush("episode-change");
    this.active = {
      context,
      latest: {
        identity: historyIdentity(context.identity),
        position: 0,
        duration: 0,
        updatedAt: this.now(),
        completed: false,
      },
      started: false,
    };
  }

  public playbackStarted(): void {
    const active = this.active;
    if (!active || this.paused || active.started) return;
    active.started = true;
    this.persistHistoryProgress(active.latest, "debounce");
  }

  public sync(snapshot: HistoryMediaSnapshot): void {
    const active = this.active;
    if (!active || this.paused) return;
    const eventType = snapshot.event?.type;
    if (snapshot.status === "playing" || eventType === "first-frame") this.playbackStarted();
    if (!active.started) return;

    const position = finiteNonNegative(snapshot.currentTime, active.latest.position);
    const duration = finiteNonNegative(snapshot.duration, active.latest.duration);
    const completed = active.latest.completed
      || isHistoryCompleted(position, duration, eventType === "completion" || snapshot.status === "ended");
    active.latest = {
      identity: active.latest.identity,
      position,
      duration,
      updatedAt: this.now(),
      completed,
    };
    this.writer.update({ ...active.latest });

    if (eventType === "completion" || snapshot.status === "ended") this.flush("completion");
    else if (eventType === "user-pause" || snapshot.status === "paused") this.flush("pause");
  }

  public flush(reason: ProgressFlushReason): void {
    const active = this.active;
    if (!active || !active.started || this.paused) return;
    if (this.writer.hasPendingWrite) this.writer.flush(reason);
    else this.persistHistoryProgress(active.latest, reason);
  }

  public stop(): void {
    this.flush("stop");
    this.active = null;
  }

  public appClose(): void {
    this.flush("app-close");
    this.active = null;
  }

  public setPaused(paused: boolean): void {
    if (paused && !this.paused) this.flush("pause");
    this.options.settings.set(HISTORY_RECORDING_PAUSED_KEY, paused);
  }

  public get(identity: string): HistoryItem | null {
    const record = this.options.history.get(identity);
    return record ? this.itemWithLatestProgress(record) : null;
  }

  public delete(identity: string): void {
    this.deleteMany([identity]);
  }

  public deleteMany(identities: readonly string[]): void {
    const uniqueIdentities = [...new Set(identities.filter((identity) => identity.length > 0))];
    if (uniqueIdentities.includes(this.active?.latest.identity ?? "")) {
      this.writer.discard();
      this.active = null;
    }
    this.options.db.transaction(() => {
      uniqueIdentities.forEach((identity) => {
        this.options.history.delete(identity);
        this.options.progress.delete(identity);
      });
    });
  }

  public deleteProgress(identity: string): void {
    if (this.active?.latest.identity === identity) {
      this.writer.discard();
      this.active.latest = { ...this.active.latest, position: 0, completed: false, updatedAt: this.now() };
    }
    this.options.db.transaction(() => {
      this.options.progress.delete(identity);
      const record = this.options.history.get(identity);
      if (record) {
        this.options.history.upsert({
          ...record,
          position: 0,
          completed: false,
          updatedAt: this.now(),
        });
      }
    });
  }

  public clear(): void {
    this.writer.discard();
    this.active = null;
    this.options.db.transaction(() => {
      this.options.history.clear();
      this.options.progress.clear();
    });
  }

  public findResumeForEpisode(
    context: HistoryPlaybackContext,
    episode: HistoryCatalogEpisode,
  ): HistoryResumeCandidate | null {
    if (safeHistoryIdentifier(episode.episodeId) !== context.identity.episodeId) return null;
    const record = this.options.history.get(historyIdentity(context.identity));
    if (!record) return null;
    const item = this.itemWithLatestProgress(record);
    if (!item.completed && item.position <= 0) return null;
    return {
      ...item,
      lineIndex: episode.lineIndex,
      episodeIndex: episode.episodeIndex,
      lineName: episode.lineName,
      canResume: item.position > 0 || item.completed,
    };
  }

  public findResumeForDetail(
    source: string,
    vodId: string,
    episodes: readonly HistoryCatalogEpisode[],
  ): HistoryResumeCandidate | null {
    const sourceId = sourceIdForHistory(source);
    const safeVodId = safeHistoryIdentifier(vodId);
    if (!safeVodId) return null;
    const candidates = episodes.flatMap((episode) => {
      const episodeId = safeHistoryIdentifier(episode.episodeId);
      if (!episodeId) return [];
      const context: HistoryPlaybackContext = {
        identity: { sourceId, vodId: safeVodId, seasonId: null, episodeId },
        title: safeVodId,
        poster: null,
        episode: episode.episodeIndex + 1,
        episodeName: episode.episodeName,
        playbackLine: episode.lineName,
        sourceDisplayName: sourceDisplayNameForHistory(source),
      };
      const candidate = this.findResumeForEpisode(context, episode);
      return candidate ? [candidate] : [];
    });
    return candidates.sort((left, right) => {
      const leftOriginalLine = left.playbackLine !== null && left.lineName === left.playbackLine ? 1 : 0;
      const rightOriginalLine = right.playbackLine !== null && right.lineName === right.playbackLine ? 1 : 0;
      return rightOriginalLine - leftOriginalLine || right.updatedAt - left.updatedAt;
    })[0] ?? null;
  }

  private persistHistoryProgress(record: PlaybackProgressRecord, _reason: ProgressFlushReason): void {
    const active = this.active;
    if (!active || this.paused || active.latest.identity !== record.identity) return;
    active.latest = { ...record };
    this.options.history.upsert(historyRecordFrom(active.context, record));
  }

  private itemWithLatestProgress(record: HistoryRecord): HistoryItem {
    const progress = this.options.progress.get(record.identity);
    if (!progress || progress.updatedAt <= record.updatedAt) return { ...record };
    return {
      ...record,
      position: progress.position,
      duration: progress.duration,
      updatedAt: progress.updatedAt,
      completed: progress.completed,
    };
  }
}

function historyRecordFrom(context: HistoryPlaybackContext, progress: PlaybackProgressRecord): HistoryRecord {
  return {
    identity: progress.identity,
    sourceId: context.identity.sourceId,
    vodId: context.identity.vodId,
    seasonId: context.identity.seasonId,
    episodeId: context.identity.episodeId,
    title: context.title,
    poster: context.poster,
    episode: context.episode,
    episodeName: context.episodeName,
    playbackLine: context.playbackLine,
    position: progress.position,
    duration: progress.duration,
    updatedAt: progress.updatedAt,
    completed: progress.completed,
    sourceDisplayName: context.sourceDisplayName,
    ...(context.sourceType === "local" ? { sourceType: "local" as const } : {}),
  };
}

function normalizeSourceKey(value: string): string {
  const text = cleanText(value);
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
  } catch {
    // Non-URL descriptors are hashed as opaque source identities.
  }
  return text;
}

function safePoster(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || looksLikeUrl(text) || looksSensitive(text)) return null;
  return text.slice(0, 512);
}

function cleanText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
}

function safeHistoryLabel(value: string | null | undefined, fallback: string | null = null): string | null {
  const text = cleanText(value);
  if (!text) return fallback;
  if (looksLikeUrl(text) || looksSensitive(text)) return fallback;
  return text.slice(0, 512);
}

function safeEpisodeNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?|file|data|blob):/i.test(value) || /[?#]/.test(value);
}

function looksSensitive(value: string): boolean {
  return /(?:token|authorization|cookie|password|secret|bearer)\s*[:=]/i.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
