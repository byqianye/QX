import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  databaseError,
  isDataLayerError,
  type DataLayerError,
  type DatabaseErrorCode,
} from "./errors.js";

export const SUPPORTED_SCHEMA_VERSION = 7;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-data-layer",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE config_sources (
        source TEXT PRIMARY KEY NOT NULL,
        source_kind TEXT NOT NULL,
        active_version_id TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE config_versions (
        id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        etag TEXT,
        last_modified TEXT,
        spider_hashes_json TEXT NOT NULL,
        change_json TEXT NOT NULL,
        FOREIGN KEY (source) REFERENCES config_sources(source) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX config_versions_source_created_at
        ON config_versions(source, created_at);

      CREATE TABLE sites (
        source_id TEXT NOT NULL,
        site_key TEXT NOT NULL,
        display_name TEXT,
        api TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        search_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, site_key)
      ) STRICT;

      CREATE TABLE history (
        identity TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        vod_id TEXT NOT NULL,
        season_id TEXT,
        episode_id TEXT,
        title TEXT NOT NULL,
        poster TEXT,
        episode INTEGER,
        episode_name TEXT,
        playback_line TEXT,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        source_display_name TEXT
      ) STRICT;

      CREATE TABLE playback_progress (
        identity TEXT PRIMARY KEY NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE favorite_groups (
        group_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE favorites (
        favorite_id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        vod_id TEXT NOT NULL,
        title TEXT NOT NULL,
        poster TEXT,
        group_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_id, vod_id),
        FOREIGN KEY (group_id) REFERENCES favorite_groups(group_id) ON DELETE SET NULL
      ) STRICT;

      CREATE TABLE follow_items (
        identity TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        vod_id TEXT NOT NULL,
        title TEXT NOT NULL,
        latest_episode_id TEXT,
        latest_episode_name TEXT,
        watched_episode_id TEXT,
        watched_episode_name TEXT,
        known_episode_count INTEGER,
        last_checked_at INTEGER,
        last_updated_at INTEGER,
        update_available INTEGER NOT NULL DEFAULT 0,
        check_error TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      ) STRICT;

      CREATE TABLE source_health (
        source_id TEXT PRIMARY KEY NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE stream_health (
        stream_id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE cache_entries (
        cache_key TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        source_id TEXT,
        path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        expires_at INTEGER,
        etag TEXT,
        content_hash TEXT
      ) STRICT;

      CREATE TABLE data_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        completed_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "favorite-display-fields",
    sql: `
      ALTER TABLE favorites ADD COLUMN year TEXT;
      ALTER TABLE favorites ADD COLUMN category TEXT;
      ALTER TABLE favorites ADD COLUMN source_name TEXT;
      INSERT OR IGNORE INTO favorite_groups(group_id, name, sort_order, created_at, updated_at)
        VALUES ('default', '默认收藏', 0, 0, 0);
      UPDATE favorites SET group_id = 'default' WHERE group_id IS NULL;
    `,
  },
  {
    version: 3,
    name: "follow-poster",
    sql: `
      ALTER TABLE follow_items ADD COLUMN poster TEXT;
    `,
  },
  {
    version: 4,
    name: "live-source-import",
    sql: `
      CREATE TABLE live_sources (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        location TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        refresh_mode TEXT NOT NULL DEFAULT 'manual',
        last_updated_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT,
        content_hash TEXT,
        etag TEXT,
        last_modified TEXT
      ) STRICT;

      CREATE INDEX live_sources_enabled_updated
        ON live_sources(enabled, last_updated_at);

      CREATE TABLE live_channels (
        id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        external_id TEXT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        group_name TEXT,
        logo TEXT,
        tvg_id TEXT,
        tvg_name TEXT,
        tvg_logo TEXT,
        tvg_chno TEXT,
        catchup TEXT,
        attributes_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX live_channels_source_order
        ON live_channels(source_id, sort_order, id);
      CREATE INDEX live_channels_source_name
        ON live_channels(source_id, normalized_name);

      CREATE TABLE live_channel_streams (
        id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL,
        url TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        protocol TEXT,
        FOREIGN KEY (channel_id) REFERENCES live_channels(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX live_channel_streams_channel_priority
        ON live_channel_streams(channel_id, priority, id);
    `,
  },
  {
    version: 5,
    name: "live-recent-channels",
    sql: `
      CREATE TABLE live_recent (
        channel_id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        last_played_at INTEGER NOT NULL,
        last_stream_id TEXT,
        FOREIGN KEY (channel_id) REFERENCES live_channels(id) ON DELETE CASCADE,
        FOREIGN KEY (source_id) REFERENCES live_sources(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX live_recent_last_played
        ON live_recent(last_played_at DESC, channel_id);
      CREATE INDEX live_recent_source
        ON live_recent(source_id, last_played_at DESC);
    `,
  },
  {
    version: 6,
    name: "xmltv-epg",
    sql: `
      CREATE TABLE epg_sources (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        location TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_updated_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT
      ) STRICT;

      CREATE INDEX epg_sources_enabled_updated
        ON epg_sources(enabled, last_updated_at);

      CREATE TABLE epg_channels (
        id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_names_json TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        icon TEXT,
        FOREIGN KEY (source_id) REFERENCES epg_sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, external_id)
      ) STRICT;

      CREATE INDEX epg_channels_source_external
        ON epg_channels(source_id, external_id);
      CREATE INDEX epg_channels_source_name
        ON epg_channels(source_id, normalized_name);

      CREATE TABLE epg_programmes (
        id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        sub_title TEXT,
        description TEXT,
        categories_json TEXT NOT NULL,
        icon TEXT,
        FOREIGN KEY (source_id) REFERENCES epg_sources(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_id) REFERENCES epg_channels(id) ON DELETE CASCADE,
        CHECK (end_at > start_at)
      ) STRICT;

      CREATE INDEX epg_programmes_channel_start
        ON epg_programmes(channel_id, start_at);
      CREATE INDEX epg_programmes_channel_end
        ON epg_programmes(channel_id, end_at);
      CREATE INDEX epg_programmes_channel_window
        ON epg_programmes(channel_id, start_at, end_at);
    `,
  },
  {
    version: 7,
    name: "epg-channel-matching",
    sql: `
      CREATE TABLE epg_channel_mappings (
        id TEXT PRIMARY KEY NOT NULL,
        live_channel_id TEXT NOT NULL,
        epg_source_id TEXT NOT NULL,
        epg_channel_id TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('explicit', 'tvg-id', 'normalized-name', 'alias')),
        confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'high', 'medium', 'low', 'none')),
        user_confirmed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (live_channel_id) REFERENCES live_channels(id) ON DELETE CASCADE,
        FOREIGN KEY (epg_source_id) REFERENCES epg_sources(id) ON DELETE CASCADE,
        FOREIGN KEY (epg_channel_id) REFERENCES epg_channels(id) ON DELETE CASCADE,
        UNIQUE(live_channel_id, epg_source_id)
      ) STRICT;

      CREATE INDEX epg_channel_mappings_live
        ON epg_channel_mappings(live_channel_id, user_confirmed, updated_at);
      CREATE INDEX epg_channel_mappings_epg
        ON epg_channel_mappings(epg_source_id, epg_channel_id);

      CREATE TABLE epg_channel_aliases (
        id TEXT PRIMARY KEY NOT NULL,
        live_channel_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (live_channel_id) REFERENCES live_channels(id) ON DELETE CASCADE,
        UNIQUE(live_channel_id, normalized_alias)
      ) STRICT;

      CREATE INDEX epg_channel_aliases_live
        ON epg_channel_aliases(live_channel_id, normalized_alias);
    `,
  },
];

export interface SqliteDataLayerOptions {
  now?: () => number;
  timeoutMs?: number;
}

export interface SqliteDataLayerOpenResult {
  layer: SqliteDataLayer;
  diagnostic: DataLayerError | null;
  primaryPath: string;
  activePath: string;
  recovered: boolean;
}

export class SqliteDataLayer {
  private closed = false;
  private readonly now: () => number;

  private constructor(
    private readonly database: DatabaseSync,
    public readonly path: string,
    options: SqliteDataLayerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  public static create(path: string, options: SqliteDataLayerOptions = {}): SqliteDataLayer {
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: options.timeoutMs ?? 1_000,
    });
    try {
      database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
      const layer = new SqliteDataLayer(database, path, options);
      layer.migrate();
      return layer;
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the mapped database error.
      }
      throw mapDatabaseError(error, "DATABASE_MIGRATION_FAILED");
    }
  }

  public get isOpen(): boolean {
    return !this.closed && this.database.isOpen;
  }

  public get schemaVersion(): number {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get() as { version?: number } | undefined;
    return typeof row?.version === "number" ? row.version : 0;
  }

  public prepare(sql: string): StatementSync {
    this.assertOpen();
    return this.database.prepare(sql);
  }

  public exec(sql: string): void {
    this.assertOpen();
    this.database.exec(sql);
  }

  public transaction<T>(action: () => T): T {
    this.assertOpen();
    if (this.database.isTransaction) return action();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original operation failure.
      }
      throw mapDatabaseError(error, "DATABASE_WRITE_FAILED");
    }
  }

  public integrityCheck(): boolean {
    this.assertOpen();
    const row = this.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    return row?.integrity_check === "ok";
  }

  public hasMigration(name: string): boolean {
    this.assertOpen();
    const row = this.database.prepare("SELECT 1 AS found FROM data_migrations WHERE name = ?").get(name);
    return row !== undefined;
  }

  public markMigration(name: string): void {
    this.assertOpen();
    try {
      this.database.prepare(
        "INSERT INTO data_migrations(name, completed_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
      ).run(name, this.now());
    } catch (error) {
      throw mapDatabaseError(error, "DATABASE_WRITE_FAILED");
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch (error) {
      throw mapDatabaseError(error, "DATABASE_WRITE_FAILED");
    }
  }

  private migrate(): void {
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        ) STRICT;
      `);
      const current = this.schemaVersion;
      if (current > SUPPORTED_SCHEMA_VERSION) {
        throw databaseError("DATABASE_VERSION_TOO_NEW");
      }
      for (const migration of migrations.filter((item) => item.version > current)) {
        this.transaction(() => {
          this.database.exec(migration.sql);
          this.database.prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          ).run(migration.version, migration.name, this.now());
        });
      }
    } catch (error) {
      if (isDataLayerError(error)) throw error;
      throw databaseError("DATABASE_MIGRATION_FAILED", error);
    }
  }

  private assertOpen(): void {
    if (!this.isOpen) throw databaseError("DATABASE_OPEN_FAILED");
  }
}

export function openSqliteDataLayer(
  primaryPath: string,
  options: SqliteDataLayerOptions = {},
): SqliteDataLayerOpenResult {
  try {
    const layer = SqliteDataLayer.create(primaryPath, options);
    return {
      layer,
      diagnostic: null,
      primaryPath,
      activePath: primaryPath,
      recovered: false,
    };
  } catch (error) {
    const mapped = classifyOpenFailure(
      primaryPath,
      isDataLayerError(error) ? error : databaseError("DATABASE_OPEN_FAILED", error),
    );
    const recoveryPath = recoveryDatabasePath(primaryPath);
    backupDatabase(
      primaryPath,
      isDatabaseErrorCode(mapped.code) ? mapped.code : "DATABASE_OPEN_FAILED",
    );
    try {
      const layer = SqliteDataLayer.create(recoveryPath, options);
      return {
        layer,
        diagnostic: mapped,
        primaryPath,
        activePath: recoveryPath,
        recovered: true,
      };
    } catch (recoveryError) {
      throw isDataLayerError(recoveryError)
        ? recoveryError
        : databaseError("DATABASE_OPEN_FAILED", recoveryError);
    }
  }
}

function recoveryDatabasePath(primaryPath: string): string {
  return join(dirname(primaryPath), `${basename(primaryPath)}.recovery.db`);
}

function backupDatabase(path: string, code: DatabaseErrorCode): void {
  if (!existsSync(path) || code === "DATABASE_VERSION_TOO_NEW") return;
  try {
    copyFileSync(path, `${path}.corrupt-${Date.now()}.bak`);
  } catch {
    // The original file must remain untouched even when a backup cannot be made.
  }
}

function mapDatabaseError(error: unknown, fallback: DatabaseErrorCode): DataLayerError {
  if (isDataLayerError(error)) return error;
  return databaseError(fallback, error);
}

function isDatabaseErrorCode(value: string): value is DatabaseErrorCode {
  return value === "DATABASE_OPEN_FAILED"
    || value === "DATABASE_MIGRATION_FAILED"
    || value === "DATABASE_CORRUPT"
    || value === "DATABASE_VERSION_TOO_NEW"
    || value === "DATABASE_WRITE_FAILED";
}

function classifyOpenFailure(path: string, error: DataLayerError): DataLayerError {
  if (error.code === "DATABASE_VERSION_TOO_NEW" || !existsSync(path)) return error;
  try {
    const readOnly = new DatabaseSync(path, { readOnly: true, timeout: 250 });
    let healthy = false;
    try {
      const result = readOnly.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
      healthy = result?.integrity_check === "ok";
    } finally {
      readOnly.close();
    }
    return healthy ? error : databaseError("DATABASE_CORRUPT", error);
  } catch {
    return databaseError("DATABASE_CORRUPT", error);
  }
}
