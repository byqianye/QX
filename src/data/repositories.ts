import { databaseError } from "./errors.js";
import { serializePersistedJson } from "./safe-persistence.js";
import { type SqliteDataLayer } from "./sqlite.js";
import type {
  LiveChannelStreamRecord,
  LiveChannelWithStreams,
  LiveSourceRecord,
} from "../live/live-types.js";

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
  year: string | null;
  category: string | null;
  sourceName: string | null;
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
  poster: string | null;
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

  public latestUpdatedAtForContent(sourceId: string, vodId: string): number | null {
    const row = this.db.prepare(
      "SELECT MAX(updated_at) AS updated_at FROM history WHERE source_id = ? AND vod_id = ?",
    ).get(sourceId, vodId) as { updated_at?: unknown } | undefined;
    return row?.updated_at === null || row?.updated_at === undefined ? null : numberValue(row.updated_at);
  }

  public listForContent(sourceId: string, vodId: string): readonly HistoryRecord[] {
    return this.db.prepare(
      "SELECT * FROM history WHERE source_id = ? AND vod_id = ? ORDER BY episode DESC, updated_at DESC",
    ).all(sourceId, vodId).map(historyFromRow);
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
          favorite_id, source_id, vod_id, title, poster, year, category, source_name,
          group_id, sort_order, metadata_json, added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, vod_id) DO UPDATE SET
          favorite_id = excluded.favorite_id,
          title = excluded.title,
          poster = excluded.poster,
          year = excluded.year,
          category = excluded.category,
          source_name = excluded.source_name,
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
        record.year,
        record.category,
        record.sourceName,
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

  public get(favoriteId: string): FavoriteRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM favorites WHERE favorite_id = ?",
    ).get(favoriteId);
    return row ? favoriteFromRow(row) : null;
  }

  public findByContent(sourceId: string, vodId: string): FavoriteRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM favorites WHERE source_id = ? AND vod_id = ?",
    ).get(sourceId, vodId);
    return row ? favoriteFromRow(row) : null;
  }

  public listGroups(): readonly FavoriteGroupRecord[] {
    return this.db.prepare(
      "SELECT * FROM favorite_groups ORDER BY sort_order, created_at",
    ).all().map(favoriteGroupFromRow);
  }

  public getGroup(groupId: string): FavoriteGroupRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM favorite_groups WHERE group_id = ?",
    ).get(groupId);
    return row ? favoriteGroupFromRow(row) : null;
  }

  public countByGroup(groupId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM favorites WHERE group_id = ?",
    ).get(groupId) as { count?: unknown } | undefined;
    return numberValue(row?.count);
  }

  public setGroup(
    favoriteId: string,
    groupId: string | null,
    updatedAt = Date.now(),
    sortOrder?: number,
  ): void {
    try {
      if (sortOrder === undefined) {
        this.db.prepare("UPDATE favorites SET group_id = ?, updated_at = ? WHERE favorite_id = ?")
          .run(groupId, updatedAt, favoriteId);
      } else {
        this.db.prepare("UPDATE favorites SET group_id = ?, sort_order = ?, updated_at = ? WHERE favorite_id = ?")
          .run(groupId, sortOrder, updatedAt, favoriteId);
      }
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public renameGroup(groupId: string, name: string, updatedAt = Date.now()): void {
    try {
      this.db.prepare("UPDATE favorite_groups SET name = ?, updated_at = ? WHERE group_id = ?")
        .run(name, updatedAt, groupId);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public deleteByGroup(groupId: string): void {
    try {
      this.db.prepare("DELETE FROM favorites WHERE group_id = ?").run(groupId);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public moveGroupContents(fromGroupId: string, toGroupId: string, updatedAt = Date.now()): void {
    if (fromGroupId === toGroupId) return;
    try {
      this.db.transaction(() => {
        const row = this.db.prepare(
          "SELECT COALESCE(MAX(sort_order), -1) AS sort_order FROM favorites WHERE group_id = ?",
        ).get(toGroupId) as { sort_order?: unknown } | undefined;
        const start = numberValue(row?.sort_order) + 1;
        const ids = this.db.prepare(
          "SELECT favorite_id FROM favorites WHERE group_id = ? ORDER BY sort_order, added_at DESC, favorite_id",
        ).all(fromGroupId).map((entry) => stringValue((entry as Record<string, unknown>).favorite_id));
        const update = this.db.prepare(
          "UPDATE favorites SET group_id = ?, sort_order = ?, updated_at = ? WHERE favorite_id = ?",
        );
        ids.forEach((favoriteId, index) => update.run(toGroupId, start + index, updatedAt, favoriteId));
      });
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public deleteGroup(groupId: string): void {
    try {
      this.db.prepare("DELETE FROM favorite_groups WHERE group_id = ?").run(groupId);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
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

  public reorderInGroup(groupId: string, favoriteIds: readonly string[]): void {
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE favorites SET sort_order = ? WHERE favorite_id = ? AND group_id = ?");
      favoriteIds.forEach((favoriteId, index) => update.run(index, favoriteId, groupId));
    });
  }

  public reorderGroups(groupIds: readonly string[]): void {
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE favorite_groups SET sort_order = ? WHERE group_id = ?");
      groupIds.forEach((groupId, index) => update.run(index, groupId));
    });
  }
}

export class FollowRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsert(record: FollowRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO follow_items(
          identity, source_id, vod_id, title, poster, latest_episode_id, latest_episode_name,
          watched_episode_id, watched_episode_name, known_episode_count,
          last_checked_at, last_updated_at, update_available, check_error, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          source_id = excluded.source_id,
          vod_id = excluded.vod_id,
          title = excluded.title,
          poster = excluded.poster,
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
        record.poster,
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

  public get(identity: string): FollowRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM follow_items WHERE identity = ?",
    ).get(identity);
    return row ? followFromRow(row) : null;
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

export class LiveRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsertSource(record: LiveSourceRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO live_sources(
          id, name, type, location, enabled, refresh_mode,
          last_updated_at, last_success_at, last_error, content_hash, etag, last_modified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          location = excluded.location,
          enabled = excluded.enabled,
          refresh_mode = excluded.refresh_mode,
          last_updated_at = excluded.last_updated_at,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          content_hash = excluded.content_hash,
          etag = excluded.etag,
          last_modified = excluded.last_modified
      `).run(
        record.id,
        record.name,
        record.type,
        record.location,
        record.enabled ? 1 : 0,
        record.refreshMode,
        record.lastUpdatedAt,
        record.lastSuccessAt,
        record.lastError,
        record.contentHash,
        record.etag,
        record.lastModified,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public saveSourceContent(record: LiveSourceRecord, channels: readonly LiveChannelWithStreams[]): void {
    try {
      this.db.transaction(() => {
        this.upsertSource(record);
        this.db.prepare(`
          DELETE FROM live_channel_streams
          WHERE channel_id IN (SELECT id FROM live_channels WHERE source_id = ?)
        `).run(record.id);
        this.db.prepare("DELETE FROM live_channels WHERE source_id = ?").run(record.id);

        const channelInsert = this.db.prepare(`
          INSERT INTO live_channels(
            id, source_id, external_id, name, normalized_name, group_name,
            logo, tvg_id, tvg_name, tvg_logo, tvg_chno, catchup,
            attributes_json, enabled, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const streamInsert = this.db.prepare(`
          INSERT INTO live_channel_streams(
            id, channel_id, url, headers_json, priority, label, protocol
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const channel of channels) {
          channelInsert.run(
            channel.id,
            channel.sourceId,
            channel.externalId,
            channel.name,
            channel.normalizedName,
            channel.group,
            channel.logo,
            channel.tvgId,
            channel.tvgName,
            channel.tvgLogo,
            channel.tvgChno,
            channel.catchup,
            serializeJson(channel.attributes),
            channel.enabled ? 1 : 0,
            channel.sortOrder,
          );
          for (const stream of channel.streams) {
            streamInsert.run(
              stream.id,
              stream.channelId,
              stream.url,
              serializeJson(stream.headers),
              stream.priority,
              stream.label,
              stream.protocol,
            );
          }
        }
      });
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public getSource(id: string): LiveSourceRecord | null {
    const row = this.db.prepare("SELECT * FROM live_sources WHERE id = ?").get(id);
    return row ? liveSourceFromRow(row) : null;
  }

  public listSources(): readonly LiveSourceRecord[] {
    return this.db.prepare(
      "SELECT * FROM live_sources ORDER BY name COLLATE NOCASE, id",
    ).all().map(liveSourceFromRow);
  }

  public getChannels(sourceId: string): readonly LiveChannelWithStreams[] {
    const channels = this.db.prepare(
      "SELECT * FROM live_channels WHERE source_id = ? ORDER BY sort_order, id",
    ).all(sourceId).map(liveChannelFromRow);
    const streams = this.db.prepare(
      "SELECT * FROM live_channel_streams WHERE channel_id IN (SELECT id FROM live_channels WHERE source_id = ?) ORDER BY priority, id",
    ).all(sourceId).map(liveStreamFromRow);
    const byChannel = new Map<string, LiveChannelStreamRecord[]>();
    for (const stream of streams) {
      const current = byChannel.get(stream.channelId) ?? [];
      current.push(stream);
      byChannel.set(stream.channelId, current);
    }
    return channels.map((channel) => ({
      ...channel,
      streams: byChannel.get(channel.id) ?? [],
    }));
  }

  public deleteSource(id: string): void {
    try {
      this.db.prepare("DELETE FROM live_sources WHERE id = ?").run(id);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

export class CacheRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public get(cacheKey: string): CacheEntryRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM cache_entries WHERE cache_key = ?",
    ).get(cacheKey);
    return row ? cacheFromRow(row) : null;
  }

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

  public touch(cacheKey: string, accessedAt: number): void {
    try {
      this.db.prepare(
        "UPDATE cache_entries SET accessed_at = ? WHERE cache_key = ?",
      ).run(accessedAt, cacheKey);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public delete(cacheKey: string): void {
    try {
      this.db.prepare("DELETE FROM cache_entries WHERE cache_key = ?").run(cacheKey);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
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

function favoriteGroupFromRow(row: Record<string, unknown>): FavoriteGroupRecord {
  return {
    groupId: stringValue(row.group_id),
    name: stringValue(row.name),
    sortOrder: numberValue(row.sort_order),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

function favoriteFromRow(row: Record<string, unknown>): FavoriteRecord {
  return {
    favoriteId: stringValue(row.favorite_id),
    sourceId: stringValue(row.source_id),
    vodId: stringValue(row.vod_id),
    title: stringValue(row.title),
    poster: nullableString(row.poster),
    year: nullableString(row.year),
    category: nullableString(row.category),
    sourceName: nullableString(row.source_name),
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
    poster: nullableString(row.poster),
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

function liveSourceFromRow(row: Record<string, unknown>): LiveSourceRecord {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    type: stringValue(row.type) as LiveSourceRecord["type"],
    location: stringValue(row.location),
    enabled: booleanValue(row.enabled),
    refreshMode: stringValue(row.refresh_mode) as LiveSourceRecord["refreshMode"],
    lastUpdatedAt: nullableNumber(row.last_updated_at),
    lastSuccessAt: nullableNumber(row.last_success_at),
    lastError: nullableString(row.last_error),
    contentHash: nullableString(row.content_hash),
    etag: nullableString(row.etag),
    lastModified: nullableString(row.last_modified),
  };
}

function liveChannelFromRow(row: Record<string, unknown>): Omit<LiveChannelWithStreams, "streams"> {
  return {
    id: stringValue(row.id),
    sourceId: stringValue(row.source_id),
    externalId: nullableString(row.external_id),
    name: stringValue(row.name),
    normalizedName: stringValue(row.normalized_name),
    group: nullableString(row.group_name),
    logo: nullableString(row.logo),
    tvgId: nullableString(row.tvg_id),
    tvgName: nullableString(row.tvg_name),
    tvgLogo: nullableString(row.tvg_logo),
    tvgChno: nullableString(row.tvg_chno),
    catchup: nullableString(row.catchup),
    attributes: stringRecordFromRow(row, "attributes_json"),
    enabled: booleanValue(row.enabled),
    sortOrder: numberValue(row.sort_order),
  };
}

function liveStreamFromRow(row: Record<string, unknown>): LiveChannelStreamRecord {
  return {
    id: stringValue(row.id),
    channelId: stringValue(row.channel_id),
    url: stringValue(row.url),
    headers: stringRecordFromRow(row, "headers_json"),
    priority: numberValue(row.priority),
    label: nullableString(row.label),
    protocol: nullableString(row.protocol),
  };
}

function stringRecordFromRow(row: Record<string, unknown>, column: string): Record<string, string> {
  const value = parseJsonRow(row, column);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw databaseError("DATABASE_CORRUPT");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    throw databaseError("DATABASE_CORRUPT");
  }
  return Object.fromEntries(entries) as Record<string, string>;
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
