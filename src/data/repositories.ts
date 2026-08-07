import { databaseError } from "./errors.js";
import { serializePersistedJson } from "./safe-persistence.js";
import { type SqliteDataLayer } from "./sqlite.js";

export interface HistoryRecord {
  identity: string;
  sourceId: string;
  vodId: string;
  seasonId: string | null;
  episodeId: string | null;
  title: string;
  poster: string | null;
  episode: number | null;
  episodeName: string | null;
  playbackLine: string | null;
  position: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
  sourceDisplayName: string | null;
}

export interface PlaybackProgressRecord {
  identity: string;
  position: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
}

export interface FavoriteGroupRecord {
  groupId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface FavoriteRecord {
  favoriteId: string;
  sourceId: string;
  vodId: string;
  title: string;
  poster: string | null;
  groupId: string | null;
  sortOrder: number;
  metadata: unknown | null;
  addedAt: number;
  updatedAt: number;
}

export interface FollowRecord {
  identity: string;
  sourceId: string;
  vodId: string;
  title: string;
  latestEpisodeId: string | null;
  latestEpisodeName: string | null;
  watchedEpisodeId: string | null;
  watchedEpisodeName: string | null;
  knownEpisodeCount: number | null;
  lastCheckedAt: number | null;
  lastUpdatedAt: number | null;
  updateAvailable: boolean;
  checkError: string | null;
  enabled: boolean;
}

export interface CacheEntryRecord {
  cacheKey: string;
  type: string;
  sourceId: string | null;
  path: string;
  size: number;
  createdAt: number;
  accessedAt: number;
  expiresAt: number | null;
  etag: string | null;
  contentHash: string | null;
}

export interface HealthSnapshotRecord {
  id: string;
  sourceId?: string;
  snapshot: unknown;
  updatedAt: number;
}

export class SettingsRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public get<T>(key: string): T | null {
    const row = this.db.prepare(
      "SELECT value_json FROM settings WHERE key = ?",
    ).get(key) as { value_json?: unknown } | undefined;
    if (!row || typeof row.value_json !== "string") return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch (error) {
      throw databaseError("DATABASE_CORRUPT", error);
    }
  }

  public set(key: string, value: unknown, updatedAt = Date.now()): void {
    const valueJson = serializeJson(value, key);
    try {
      this.db.prepare(`
        INSERT INTO settings(key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key, valueJson, updatedAt);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public delete(key: string): void {
    try {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

export class HistoryRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsert(record: HistoryRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO history(
          identity, source_id, vod_id, season_id, episode_id, title, poster,
          episode, episode_name, playback_line, position, duration, updated_at,
          completed, source_display_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          source_id = excluded.source_id,
          vod_id = excluded.vod_id,
          season_id = excluded.season_id,
          episode_id = excluded.episode_id,
          title = excluded.title,
          poster = excluded.poster,
          episode = excluded.episode,
          episode_name = excluded.episode_name,
          playback_line = excluded.playback_line,
          position = excluded.position,
          duration = excluded.duration,
          updated_at = excluded.updated_at,
          completed = excluded.completed,
          source_display_name = excluded.source_display_name
      `).run(
        record.identity,
        record.sourceId,
        record.vodId,
        record.seasonId,
        record.episodeId,
        record.title,
        record.poster,
        record.episode,
        record.episodeName,
        record.playbackLine,
        record.position,
        record.duration,
        record.updatedAt,
        record.completed ? 1 : 0,
        record.sourceDisplayName,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public get(identity: string): HistoryRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM history WHERE identity = ?",
    ).get(identity);
    return row ? historyFromRow(row) : null;
  }

  public list(limit = 100): readonly HistoryRecord[] {
    const safeLimit = clampLimit(limit);
    return this.db.prepare(
      "SELECT * FROM history ORDER BY updated_at DESC LIMIT ?",
    ).all(safeLimit).map(historyFromRow);
  }

  public delete(identity: string): void {
    try {
      this.db.prepare("DELETE FROM history WHERE identity = ?").run(identity);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public clear(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM history");
    });
  }
}

export class PlaybackProgressRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsert(record: PlaybackProgressRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO playback_progress(identity, position, duration, updated_at, completed)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          position = excluded.position,
          duration = excluded.duration,
          updated_at = excluded.updated_at,
          completed = excluded.completed
      `).run(
        record.identity,
        record.position,
        record.duration,
        record.updatedAt,
        record.completed ? 1 : 0,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public get(identity: string): PlaybackProgressRecord | null {
    const row = this.db.prepare(
      "SELECT identity, position, duration, updated_at, completed FROM playback_progress WHERE identity = ?",
    ).get(identity);
    return row ? progressFromRow(row) : null;
  }

  public delete(identity: string): void {
    try {
      this.db.prepare("DELETE FROM playback_progress WHERE identity = ?").run(identity);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public clear(): void {
    try {
      this.db.exec("DELETE FROM playback_progress");
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

export class FavoritesRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsertGroup(group: FavoriteGroupRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO favorite_groups(group_id, name, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
          name = excluded.name,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `).run(group.groupId, group.name, group.sortOrder, group.createdAt, group.updatedAt);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public upsert(record: FavoriteRecord): void {
    const metadataJson = record.metadata === null ? null : serializeJson(record.metadata);
    try {
      this.db.prepare(`
        INSERT INTO favorites(
          favorite_id, source_id, vod_id, title, poster, group_id, sort_order,
          metadata_json, added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, vod_id) DO UPDATE SET
          favorite_id = excluded.favorite_id,
          title = excluded.title,
          poster = excluded.poster,
          group_id = excluded.group_id,
          sort_order = excluded.sort_order,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run(
        record.favoriteId,
        record.sourceId,
        record.vodId,
        record.title,
        record.poster,
        record.groupId,
        record.sortOrder,
        metadataJson,
        record.addedAt,
        record.updatedAt,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public list(groupId: string | null = null): readonly FavoriteRecord[] {
    const rows = groupId === null
      ? this.db.prepare("SELECT * FROM favorites ORDER BY sort_order, added_at DESC").all()
      : this.db.prepare("SELECT * FROM favorites WHERE group_id = ? ORDER BY sort_order, added_at DESC").all(groupId);
    return rows.map(favoriteFromRow);
  }

  public delete(favoriteId: string): void {
    try {
      this.db.prepare("DELETE FROM favorites WHERE favorite_id = ?").run(favoriteId);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public reorder(favoriteIds: readonly string[]): void {
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE favorites SET sort_order = ? WHERE favorite_id = ?");
      favoriteIds.forEach((favoriteId, index) => update.run(index, favoriteId));
    });
  }
}

export class FollowRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsert(record: FollowRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO follow_items(
          identity, source_id, vod_id, title, latest_episode_id, latest_episode_name,
          watched_episode_id, watched_episode_name, known_episode_count,
          last_checked_at, last_updated_at, update_available, check_error, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          source_id = excluded.source_id,
          vod_id = excluded.vod_id,
          title = excluded.title,
          latest_episode_id = excluded.latest_episode_id,
          latest_episode_name = excluded.latest_episode_name,
          watched_episode_id = excluded.watched_episode_id,
          watched_episode_name = excluded.watched_episode_name,
          known_episode_count = excluded.known_episode_count,
          last_checked_at = excluded.last_checked_at,
          last_updated_at = excluded.last_updated_at,
          update_available = excluded.update_available,
          check_error = excluded.check_error,
          enabled = excluded.enabled
      `).run(
        record.identity,
        record.sourceId,
        record.vodId,
        record.title,
        record.latestEpisodeId,
        record.latestEpisodeName,
        record.watchedEpisodeId,
        record.watchedEpisodeName,
        record.knownEpisodeCount,
        record.lastCheckedAt,
        record.lastUpdatedAt,
        record.updateAvailable ? 1 : 0,
        record.checkError,
        record.enabled ? 1 : 0,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public list(): readonly FollowRecord[] {
    return this.db.prepare("SELECT * FROM follow_items ORDER BY last_updated_at DESC").all().map(followFromRow);
  }

  public delete(identity: string): void {
    try {
      this.db.prepare("DELETE FROM follow_items WHERE identity = ?").run(identity);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

export class HealthRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsertSource(record: HealthSnapshotRecord): void {
    const snapshotJson = serializeJson(record.snapshot);
    try {
      this.db.prepare(`
        INSERT INTO source_health(source_id, snapshot_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
      `).run(record.id, snapshotJson, record.updatedAt);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public upsertStream(record: HealthSnapshotRecord): void {
    if (!record.sourceId) throw databaseError("DATABASE_WRITE_FAILED");
    const snapshotJson = serializeJson(record.snapshot);
    try {
      this.db.prepare(`
        INSERT INTO stream_health(stream_id, source_id, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET source_id = excluded.source_id, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
      `).run(record.id, record.sourceId, snapshotJson, record.updatedAt);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public readSource(id: string): unknown | null {
    const row = this.db.prepare("SELECT snapshot_json FROM source_health WHERE source_id = ?").get(id);
    return row ? parseJsonRow(row, "snapshot_json") : null;
  }
}

export class CacheRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsert(record: CacheEntryRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO cache_entries(
          cache_key, type, source_id, path, size, created_at, accessed_at,
          expires_at, etag, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          type = excluded.type,
          source_id = excluded.source_id,
          path = excluded.path,
          size = excluded.size,
          created_at = excluded.created_at,
          accessed_at = excluded.accessed_at,
          expires_at = excluded.expires_at,
          etag = excluded.etag,
          content_hash = excluded.content_hash
      `).run(
        record.cacheKey,
        record.type,
        record.sourceId,
        record.path,
        record.size,
        record.createdAt,
        record.accessedAt,
        record.expiresAt,
        record.etag,
        record.contentHash,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public list(type?: string): readonly CacheEntryRecord[] {
    const rows = type === undefined
      ? this.db.prepare("SELECT * FROM cache_entries ORDER BY accessed_at DESC").all()
      : this.db.prepare("SELECT * FROM cache_entries WHERE type = ? ORDER BY accessed_at DESC").all(type);
    return rows.map(cacheFromRow);
  }

  public clearCategory(type: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM cache_entries WHERE type = ?").run(type);
    });
  }
}

function historyFromRow(row: Record<string, unknown>): HistoryRecord {
  return {
    identity: stringValue(row.identity),
    sourceId: stringValue(row.source_id),
    vodId: stringValue(row.vod_id),
    seasonId: nullableString(row.season_id),
    episodeId: nullableString(row.episode_id),
    title: stringValue(row.title),
    poster: nullableString(row.poster),
    episode: nullableNumber(row.episode),
    episodeName: nullableString(row.episode_name),
    playbackLine: nullableString(row.playback_line),
    position: numberValue(row.position),
    duration: numberValue(row.duration),
    updatedAt: numberValue(row.updated_at),
    completed: booleanValue(row.completed),
    sourceDisplayName: nullableString(row.source_display_name),
  };
}

function progressFromRow(row: Record<string, unknown>): PlaybackProgressRecord {
  return {
    identity: stringValue(row.identity),
    position: numberValue(row.position),
    duration: numberValue(row.duration),
    updatedAt: numberValue(row.updated_at),
    completed: booleanValue(row.completed),
  };
}

function favoriteFromRow(row: Record<string, unknown>): FavoriteRecord {
  return {
    favoriteId: stringValue(row.favorite_id),
    sourceId: stringValue(row.source_id),
    vodId: stringValue(row.vod_id),
    title: stringValue(row.title),
    poster: nullableString(row.poster),
    groupId: nullableString(row.group_id),
    sortOrder: numberValue(row.sort_order),
    metadata: row.metadata_json === null || row.metadata_json === undefined
      ? null
      : parseJsonRow(row, "metadata_json"),
    addedAt: numberValue(row.added_at),
    updatedAt: numberValue(row.updated_at),
  };
}

function followFromRow(row: Record<string, unknown>): FollowRecord {
  return {
    identity: stringValue(row.identity),
    sourceId: stringValue(row.source_id),
    vodId: stringValue(row.vod_id),
    title: stringValue(row.title),
    latestEpisodeId: nullableString(row.latest_episode_id),
    latestEpisodeName: nullableString(row.latest_episode_name),
    watchedEpisodeId: nullableString(row.watched_episode_id),
    watchedEpisodeName: nullableString(row.watched_episode_name),
    knownEpisodeCount: nullableNumber(row.known_episode_count),
    lastCheckedAt: nullableNumber(row.last_checked_at),
    lastUpdatedAt: nullableNumber(row.last_updated_at),
    updateAvailable: booleanValue(row.update_available),
    checkError: nullableString(row.check_error),
    enabled: booleanValue(row.enabled),
  };
}

function cacheFromRow(row: Record<string, unknown>): CacheEntryRecord {
  return {
    cacheKey: stringValue(row.cache_key),
    type: stringValue(row.type),
    sourceId: nullableString(row.source_id),
    path: stringValue(row.path),
    size: numberValue(row.size),
    createdAt: numberValue(row.created_at),
    accessedAt: numberValue(row.accessed_at),
    expiresAt: nullableNumber(row.expires_at),
    etag: nullableString(row.etag),
    contentHash: nullableString(row.content_hash),
  };
}

function serializeJson(value: unknown, key?: string): string {
  try {
    return serializePersistedJson(value, key);
  } catch (error) {
    throw databaseError("DATABASE_WRITE_FAILED", error);
  }
}

function parseJsonRow(row: Record<string, unknown>, column: string): unknown {
  const value = row[column];
  if (typeof value !== "string") throw databaseError("DATABASE_CORRUPT");
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw databaseError("DATABASE_CORRUPT", error);
  }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw databaseError("DATABASE_CORRUPT");
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw databaseError("DATABASE_CORRUPT");
  return value;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function booleanValue(value: unknown): boolean {
  return value === 1 || value === true;
}

function clampLimit(value: number): number {
  return Math.min(10_000, Math.max(1, Math.floor(Number.isFinite(value) ? value : 100)));
}
