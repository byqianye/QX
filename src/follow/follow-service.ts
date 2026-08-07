import {
  FollowRepository,
  HistoryRepository,
  type FollowRecord,
  type HistoryRecord,
} from "../data/repositories.js";
import type { SqliteDataLayer } from "../data/sqlite.js";
import { parseVodPlayback } from "../desktop/vod-playback.js";
import { historyIdentity, safeHistoryIdentifier } from "../history/history-progress.js";
import {
  EMPTY_FOLLOW_UI_STATE,
  type FollowContentInput,
  type FollowEpisodeInput,
  type FollowItem,
  type FollowUiState,
} from "./follow-types.js";

export type FollowDetailLoader = (record: FollowRecord) => Promise<FollowContentInput>;

export interface FollowServiceOptions {
  db: SqliteDataLayer;
  follow: FollowRepository;
  history: HistoryRepository;
  now?: () => number;
  maxConcurrentChecks?: number;
}

export function followIdentity(sourceId: string, vodId: string): string {
  return historyIdentity({
    sourceId,
    vodId,
    seasonId: null,
    episodeId: "follow",
  });
}

export function followContentFromDetail(
  detail: Record<string, unknown>,
  sourceId: string,
  fallbackVodId?: string,
): FollowContentInput {
  const vodId = stringValue(detail.vod_id ?? detail.id ?? fallbackVodId);
  return {
    sourceId,
    vodId,
    title: stringValue(detail.vod_name ?? detail.name ?? detail.title) || vodId,
    poster: stringValueOrNull(detail.vod_pic ?? detail.poster),
    episodes: followEpisodesFromDetail(detail),
  };
}

export function followEpisodesFromDetail(detail: Record<string, unknown>): FollowEpisodeInput[] {
  const direct = firstEpisodeArray(detail);
  if (direct.length > 0) return direct;
  try {
    const catalog = parseVodPlayback(detail);
    const line = catalog?.lines
      .filter((candidate) => candidate.episodes.length > 0)
      .sort((left, right) => right.episodes.length - left.episodes.length)[0];
    return line?.episodes.map((episode) => ({ id: episode.id, name: episode.name })) ?? [];
  } catch {
    return [];
  }
}

export class FollowService {
  private readonly now: () => number;
  private readonly maxConcurrentChecks: number;
  private readonly checking = new Set<string>();
  private checkPromise: Promise<void> | null = null;

  public constructor(private readonly options: FollowServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxConcurrentChecks = Math.max(1, Math.floor(options.maxConcurrentChecks ?? 2));
  }

  public uiState(currentSourceId: string | null = null): FollowUiState {
    this.syncWatchedFromHistory();
    const items = this.options.follow.list().map((record) => this.itemState(record, currentSourceId));
    return {
      items,
      checking: this.checking.size > 0,
      updateCount: items.filter((item) => item.updateAvailable).length,
    };
  }

  public get(identity: string): FollowRecord | null {
    return this.options.follow.get(identity);
  }

  public findByContent(sourceId: string, vodId: string): FollowRecord | null {
    const safeSourceId = safeHistoryIdentifier(sourceId);
    const safeVodId = safeHistoryIdentifier(vodId);
    return safeSourceId && safeVodId
      ? this.options.follow.get(followIdentity(safeSourceId, safeVodId))
      : null;
  }

  public follow(input: FollowContentInput): FollowRecord {
    const normalized = normalizeContent(input);
    if (!normalized) throw new Error("FOLLOW_CONTENT_INVALID");
    const identity = followIdentity(normalized.sourceId, normalized.vodId);
    const existing = this.options.follow.get(identity);
    if (existing) return existing;
    const now = this.now();
    const latest = latestEpisode(normalized.episodes);
    const record: FollowRecord = {
      identity,
      sourceId: normalized.sourceId,
      vodId: normalized.vodId,
      title: normalized.title,
      poster: normalized.poster,
      latestEpisodeId: latest?.id ?? null,
      latestEpisodeName: latest?.name ?? null,
      watchedEpisodeId: null,
      watchedEpisodeName: null,
      knownEpisodeCount: normalized.episodes.length > 0 ? normalized.episodes.length : null,
      lastCheckedAt: null,
      lastUpdatedAt: now,
      updateAvailable: false,
      checkError: null,
      enabled: true,
    };
    this.options.follow.upsert(record);
    return record;
  }

  public unfollow(identity: string): void {
    if (!this.options.follow.get(identity)) throw new Error("FOLLOW_NOT_FOUND");
    this.options.follow.delete(identity);
  }

  public toggle(input: FollowContentInput): FollowRecord | null {
    const normalized = normalizeContent(input);
    if (!normalized) throw new Error("FOLLOW_CONTENT_INVALID");
    const identity = followIdentity(normalized.sourceId, normalized.vodId);
    const existing = this.options.follow.get(identity);
    if (existing) {
      this.options.follow.delete(identity);
      return null;
    }
    return this.follow(normalized);
  }

  public markWatched(identity: string): void {
    const record = this.require(identity);
    if (!record.latestEpisodeId && !record.latestEpisodeName) throw new Error("FOLLOW_EPISODE_NOT_FOUND");
    this.options.follow.upsert({
      ...record,
      watchedEpisodeId: record.latestEpisodeId,
      watchedEpisodeName: record.latestEpisodeName,
      updateAvailable: false,
      checkError: null,
    });
  }

  public markUnwatched(identity: string): void {
    this.syncWatchedFromHistory();
    const record = this.require(identity);
    this.options.follow.upsert({
      ...record,
      updateAvailable: record.latestEpisodeId !== null || record.latestEpisodeName !== null,
    });
  }

  public async check(loader: FollowDetailLoader): Promise<void> {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.runChecks(loader).finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  private async runChecks(loader: FollowDetailLoader): Promise<void> {
    const records = this.options.follow.list().filter((record) => record.enabled);
    const limiter = new AsyncLimiter(this.maxConcurrentChecks);
    const sourceQueues = new Map<string, Promise<void>>();
    await Promise.all(records.map(async (record) => {
      this.checking.add(record.identity);
      const previous = sourceQueues.get(record.sourceId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => limiter.run(() => this.checkOne(record, loader)));
      sourceQueues.set(record.sourceId, current);
      try {
        await current;
      } finally {
        this.checking.delete(record.identity);
      }
    }));
  }

  private async checkOne(record: FollowRecord, loader: FollowDetailLoader): Promise<void> {
    try {
      const detail = await loader(record);
      this.applyDetail(record, detail);
    } catch (error) {
      this.options.follow.upsert({
        ...record,
        lastCheckedAt: this.now(),
        checkError: safeFollowError(error),
      });
    }
  }

  private applyDetail(record: FollowRecord, input: FollowContentInput): void {
    const normalized = normalizeContent({ ...input, sourceId: record.sourceId, vodId: record.vodId });
    if (!normalized) throw new Error("FOLLOW_DETAIL_INVALID");
    const latest = latestEpisode(normalized.episodes);
    const hadKnownEpisode = record.latestEpisodeId !== null || record.latestEpisodeName !== null;
    const latestChanged = hadKnownEpisode && !sameEpisode(
      record.latestEpisodeId,
      record.latestEpisodeName,
      latest?.id ?? null,
      latest?.name ?? null,
    );
    const updateAvailable = latestChanged
      || (record.watchedEpisodeId !== null || record.watchedEpisodeName !== null)
        && !sameEpisode(
          record.watchedEpisodeId,
          record.watchedEpisodeName,
          latest?.id ?? null,
          latest?.name ?? null,
        )
      || (!latest && record.updateAvailable);
    const updatedAt = latestChanged ? this.now() : record.lastUpdatedAt ?? this.now();
    this.options.follow.upsert({
      ...record,
      title: normalized.title || record.title,
      poster: normalized.poster ?? record.poster,
      latestEpisodeId: latest?.id ?? null,
      latestEpisodeName: latest?.name ?? null,
      knownEpisodeCount: normalized.episodes.length > 0 ? normalized.episodes.length : null,
      lastCheckedAt: this.now(),
      lastUpdatedAt: updatedAt,
      updateAvailable,
      checkError: null,
    });
  }

  private syncWatchedFromHistory(): void {
    for (const record of this.options.follow.list()) {
      const history = this.options.history.listForContent(record.sourceId, record.vodId);
      const watched = history
        .filter((item) => item.position > 0 || item.completed)
        .sort(compareHistoryEpisodes)[0];
      if (!watched) continue;
      const watchedId = watched.episodeId;
      const watchedName = watched.episodeName;
      if (sameEpisode(record.watchedEpisodeId, record.watchedEpisodeName, watchedId, watchedName)) continue;
      if (record.watchedEpisodeId !== null || record.watchedEpisodeName !== null) {
        const currentHistory = history.find((item) => sameEpisode(
          item.episodeId,
          item.episodeName,
          record.watchedEpisodeId,
          record.watchedEpisodeName,
        ));
        if (!currentHistory || (
          currentHistory.episode !== null
          && watched.episode !== null
          && watched.episode <= currentHistory.episode
        )) continue;
      }
      this.options.follow.upsert({
        ...record,
        watchedEpisodeId: watchedId,
        watchedEpisodeName: watchedName,
        updateAvailable: (record.latestEpisodeId !== null || record.latestEpisodeName !== null)
          && !sameEpisode(record.latestEpisodeId, record.latestEpisodeName, watchedId, watchedName),
      });
    }
  }

  private itemState(record: FollowRecord, currentSourceId: string | null): FollowItem {
    return {
      ...record,
      sourceAvailable: currentSourceId === null || record.sourceId === currentSourceId,
      status: this.checking.has(record.identity)
        ? "checking"
        : record.checkError
          ? "error"
          : record.updateAvailable ? "updated" : "caught-up",
    };
  }

  private require(identity: string): FollowRecord {
    const record = this.options.follow.get(identity);
    if (!record) throw new Error("FOLLOW_NOT_FOUND");
    return record;
  }
}

function normalizeContent(input: FollowContentInput): {
  sourceId: string;
  vodId: string;
  title: string;
  poster: string | null;
  episodes: Array<{ id: string | null; name: string | null }>;
} | null {
  const sourceId = safeHistoryIdentifier(input.sourceId)?.slice(0, 256) ?? null;
  const vodId = safeHistoryIdentifier(input.vodId);
  if (!sourceId || !vodId) return null;
  const episodes = normalizeEpisodes(input.episodes);
  return {
    sourceId,
    vodId,
    title: safeLabel(input.title) || vodId,
    poster: safePoster(input.poster),
    episodes,
  };
}

function normalizeEpisodes(value: readonly FollowEpisodeInput[]): Array<{ id: string | null; name: string | null }> {
  const result: Array<{ id: string | null; name: string | null }> = [];
  for (const episode of value) {
    const id = safeHistoryIdentifier(episode.id);
    const name = safeLabel(episode.name);
    if (!id && !name) continue;
    if (result.some((item) => sameEpisode(item.id, item.name, id, name))) continue;
    result.push({ id, name });
  }
  return result;
}

function latestEpisode(episodes: readonly { id: string | null; name: string | null }[]): { id: string | null; name: string | null } | null {
  return episodes.length > 0 ? episodes[episodes.length - 1]! : null;
}

function sameEpisode(
  leftId: string | null,
  leftName: string | null,
  rightId: string | null,
  rightName: string | null,
): boolean {
  if (leftId !== null && rightId !== null) return leftId === rightId;
  if (leftName !== null && rightName !== null) return leftName === rightName;
  return leftId === rightId && leftName === rightName;
}

function compareHistoryEpisodes(left: HistoryRecord, right: HistoryRecord): number {
  const leftEpisode = left.episode ?? -1;
  const rightEpisode = right.episode ?? -1;
  return rightEpisode - leftEpisode || right.updatedAt - left.updatedAt;
}

function firstEpisodeArray(detail: Record<string, unknown>): FollowEpisodeInput[] {
  for (const key of ["episodes", "episode_list", "episodeList", "vod_episodes"]) {
    const value = detail[key];
    if (!Array.isArray(value)) continue;
    return value.flatMap((item): FollowEpisodeInput[] => {
      if (typeof item === "string") return [{ name: item }];
      if (!isRecord(item)) return [];
      return [{
        id: stringValueOrNull(item.episode_id ?? item.id ?? item.vod_id),
        name: stringValueOrNull(item.episode_name ?? item.name ?? item.title),
      }];
    });
  }
  return [];
}

function safeFollowError(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "FOLLOW_CHECK_FAILED";
  return code.replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 96);
}

function safeLabel(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || looksLikeUrl(text) || looksSensitive(text)) return null;
  return text.slice(0, 512);
}

function safePoster(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || looksSensitive(text) || /__qx_playback/i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (/\.(?:m3u8|mpd|mp4|mkv|webm)(?:$|\/)/i.test(url.pathname)
      || /(?:^|\/)(?:live|stream|playback|playlist|session|proxy)(?:\/|$)/i.test(url.pathname)
      || /(?:stream|playback|video|play)\/$/i.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 1024);
  } catch {
    return null;
  }
}

function cleanText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?|file|data|blob):/i.test(value) || /[?#]/.test(value);
}

function looksSensitive(value: string): boolean {
  return /(?:token|authorization|cookie|password|secret|bearer)\s*[:=]/i.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringValueOrNull(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AsyncLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  public run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running += 1;
        void task().then(resolve, reject).finally(() => {
          this.running -= 1;
          this.queue.shift()?.();
        });
      };
      if (this.running < this.limit) start();
      else this.queue.push(start);
    });
  }
}
