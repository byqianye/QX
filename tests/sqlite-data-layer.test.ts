import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { DataDirectoryResolver } from "../src/data/data-directory.js";
import { SettingsRepository } from "../src/data/repositories.js";
import { openSqliteDataLayer, SqliteDataLayer } from "../src/data/sqlite.js";

describe("SQLite data layer", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the normal data layout and creates the complete initial schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-layout-"));
    directories.push(directory);
    const paths = new DataDirectoryResolver(directory).resolve();
    expect(paths).toMatchObject({
      mode: "normal",
      dataRoot: directory,
      database: join(directory, "qx-yingshi.db"),
      cache: join(directory, "cache"),
      logs: join(directory, "logs"),
      temp: join(directory, "temp"),
      backups: join(directory, "backups"),
    });

    const opened = openSqliteDataLayer(paths.database);
    layers.push(opened.layer);
    expect(opened.diagnostic).toBeNull();
    expect(opened.layer.schemaVersion).toBe(10);
    const tables = opened.layer.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "schema_migrations",
      "settings",
      "config_sources",
      "config_versions",
      "sites",
      "history",
      "playback_progress",
      "favorites",
      "favorite_groups",
      "follow_items",
      "source_health",
      "stream_health",
      "cache_entries",
      "live_sources",
      "live_channels",
      "live_channel_streams",
      "live_recent",
      "epg_sources",
      "epg_channels",
      "epg_programmes",
      "epg_channel_mappings",
      "epg_channel_aliases",
      "smart_channels",
      "smart_channel_members",
      "local_media_roots",
      "local_media_items",
      "download_target_directories",
      "download_tasks",
      "data_migrations",
    ]));
    expect(opened.layer.prepare("PRAGMA table_info(favorites)").all().map((row) => row.name)).toEqual(expect.arrayContaining([
      "year",
      "category",
      "source_name",
    ]));
    expect(opened.layer.prepare("PRAGMA table_info(follow_items)").all().map((row) => row.name))
      .toContain("poster");
  });

  it("runs migrations once, uses prepared values, and rolls back transactions", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-migration-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    const first = openSqliteDataLayer(path);
    layers.push(first.layer);
    first.layer.close();
    layers.splice(layers.indexOf(first.layer), 1);

    const second = openSqliteDataLayer(path);
    layers.push(second.layer);
    expect(second.layer.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 10 });
    const settings = new SettingsRepository(second.layer);
    const injectionLikeKey = "' OR 1=1; --";
    settings.set(injectionLikeKey, { value: "safe" });
    expect(settings.get(injectionLikeKey)).toEqual({ value: "safe" });

    expectErrorCode(() => second.layer.transaction(() => {
      settings.set("rolled-back", true);
      throw new Error("intentional rollback");
    }), "DATABASE_WRITE_FAILED");
    expect(settings.get("rolled-back")).toBeNull();
  });

  it("migrates legacy ungrouped favorites into the default group", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-favorites-migration-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'initial-data-layer', 1);
      CREATE TABLE favorite_groups(
        group_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE favorites(
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
      CREATE TABLE follow_items(
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
      CREATE TABLE history(
        identity TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        vod_id TEXT NOT NULL,
        title TEXT NOT NULL,
        position REAL NOT NULL,
        duration REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        completed INTEGER NOT NULL
      ) STRICT;
    `);
    legacy.prepare(`
      INSERT INTO favorites(favorite_id, source_id, vod_id, title, group_id, sort_order, added_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
    `).run("favorite-legacy", "source-a", "vod-a", "Legacy", 1, 1);
    legacy.close();

    const opened = openSqliteDataLayer(path);
    layers.push(opened.layer);
    expect(opened.layer.schemaVersion).toBe(10);
    expect(opened.layer.prepare("SELECT group_id FROM favorites WHERE favorite_id = ?").get("favorite-legacy"))
      .toMatchObject({ group_id: "default" });
    expect(opened.layer.prepare("SELECT group_id FROM favorite_groups WHERE group_id = ?").get("default"))
      .toMatchObject({ group_id: "default" });
  });

  it("reports a too-new database and keeps the original file untouched", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-version-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);");
    database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(999, "future", 1);
    database.close();

    const opened = openSqliteDataLayer(path);
    layers.push(opened.layer);
    expect(opened).toMatchObject({ recovered: true, diagnostic: { code: "DATABASE_VERSION_TOO_NEW" } });
    expect(existsSync(path)).toBe(true);
    expect(opened.layer.schemaVersion).toBe(10);
  });

  it("rolls back a failed schema migration instead of recording a false version", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-migration-rollback-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE settings(key TEXT PRIMARY KEY);
    `);
    database.close();

    expect(() => SqliteDataLayer.create(path)).toThrowError();
    const reopened = new DatabaseSync(path, { readOnly: true });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 0 });
    expect(reopened.prepare("PRAGMA table_info(settings)").all()).toHaveLength(1);
    reopened.close();
  });

  it("isolates a corrupt file, opens a recovery database, and does not delete the original", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-corrupt-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    writeFileSync(path, "not a sqlite database", "utf8");

    const opened = openSqliteDataLayer(path);
    layers.push(opened.layer);
    expect(opened).toMatchObject({ recovered: true, diagnostic: { code: "DATABASE_CORRUPT" } });
    expect(opened.activePath).toBe(join(directory, "qx-yingshi.db.recovery.db"));
    expect(readFileBytes(path)).toContain("not a sqlite database");
    expect(readdirSync(directory).some((name) => name.startsWith("qx-yingshi.db.corrupt-") && name.endsWith(".bak"))).toBe(true);

    new SettingsRepository(opened.layer).set("recovery-state", { kept: true });
    opened.layer.close();
    layers.splice(layers.indexOf(opened.layer), 1);
    const reopened = openSqliteDataLayer(path);
    layers.push(reopened.layer);
    expect(reopened.activePath).toBe(opened.activePath);
    expect(new SettingsRepository(reopened.layer).get("recovery-state")).toEqual({ kept: true });
  });

  it("maps a concurrent write to a stable database error and closes all handles", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-data-lock-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    const first = SqliteDataLayer.create(path);
    const second = SqliteDataLayer.create(path);
    layers.push(first, second);
    first.exec("BEGIN EXCLUSIVE");
    expectErrorCode(() => new SettingsRepository(second).set("locked", true), "DATABASE_WRITE_FAILED");
    expectErrorCode(() => second.transaction(() => new SettingsRepository(second).set("locked-in-transaction", true)), "DATABASE_WRITE_FAILED");
    first.exec("ROLLBACK");
    first.close();
    second.close();
    layers.splice(layers.indexOf(first), 1);
    layers.splice(layers.indexOf(second), 1);
    expect(first.isOpen).toBe(false);
    expect(second.isOpen).toBe(false);
  });

  it("keeps SQLite behind the main-process data boundary", () => {
    const rendererFiles = walkFiles(join(process.cwd(), "renderer", "src"));
    const forbidden = /node:sqlite|DatabaseSync|SqliteDataLayer|DataDirectoryResolver|qx-yingshi\.db|src[\\/]data/;
    for (const file of rendererFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
    }
  });
});

function readFileBytes(path: string): string {
  return readFileSync(path, "utf8");
}

function expectErrorCode(action: () => void, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}
