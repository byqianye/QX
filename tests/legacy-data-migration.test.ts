import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigHistoryStore, JsonFileConfigHistoryPersistence } from "../src/config/history.js";
import { JsonFileDesktopStateStore } from "../src/desktop/state-persistence.js";
import { SqliteConfigHistoryPersistence } from "../src/data/config-history-persistence.js";
import { SqliteDesktopStateStore } from "../src/data/desktop-state-store.js";
import { LegacyDataMigrator, type LegacyDataPaths } from "../src/data/legacy-migration.js";
import { HealthRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";

describe("legacy JSON data migration", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("imports desktop state, config history, and health once without deleting source files", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-legacy-migration-"));
    directories.push(directory);
    const paths = legacyPaths(directory);
    const desktop = new JsonFileDesktopStateStore(paths.desktopState);
    desktop.patch({
      theme: "dark",
      page: { navigation: "search", siteKey: "fixture", search: { key: "电影", page: 2 } },
    });
    const history = new ConfigHistoryStore(new JsonFileConfigHistoryPersistence(paths.configHistory));
    history.recordSuccessful("inline:fixture", "json", JSON.stringify({ sites: [{ key: "fixture", api: "csp_Douban" }] }));
    writeFileSync(paths.sourceHealth, JSON.stringify([{ sourceId: "fixture", circuit: "closed" }]), "utf8");
    writeFileSync(paths.streamHealth, JSON.stringify({ "stream-1": { sourceId: "fixture", score: 90 } }), "utf8");

    const first = openLayer(directory, layers);
    const report = new LegacyDataMigrator(first).migrate(paths);
    expect(report.imported).toEqual([
      "legacy:desktop-state",
      "legacy:config-history",
      "legacy:source-health",
      "legacy:stream-health",
    ]);
    expect(report.failed).toEqual([]);
    expect(new SqliteDesktopStateStore(first).state).toMatchObject({
      theme: "dark",
      page: { navigation: "search", siteKey: "fixture" },
    });
    expect(new SqliteConfigHistoryPersistence(first).read().versions).toHaveLength(1);
    expect(new HealthRepository(first).readSource("fixture")).toMatchObject({ circuit: "closed" });
    expect(existsSync(paths.desktopState)).toBe(true);
    expect(existsSync(paths.configHistory)).toBe(true);

    first.close();
    layers.splice(layers.indexOf(first), 1);
    const second = openLayer(directory, layers);
    const repeated = new LegacyDataMigrator(second).migrate(paths);
    expect(repeated.imported).toEqual([]);
    expect(repeated.skipped).toEqual([
      "legacy:desktop-state",
      "legacy:config-history",
      "legacy:source-health",
      "legacy:stream-health",
    ]);
    expect(new SqliteConfigHistoryPersistence(second).read().versions).toHaveLength(1);
  });

  it("keeps a malformed legacy file and does not mark its migration complete", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-legacy-failed-"));
    directories.push(directory);
    const paths = legacyPaths(directory);
    writeFileSync(paths.desktopState, "{not-json", "utf8");
    const layer = openLayer(directory, layers);

    const report = new LegacyDataMigrator(layer).migrate(paths);
    expect(report.failed).toContain("legacy:desktop-state");
    expect(report.diagnostic).toMatchObject({ code: "LEGACY_MIGRATION_FAILED" });
    expect(layer.hasMigration("legacy:desktop-state")).toBe(false);
    expect(existsSync(paths.desktopState)).toBe(true);
    expect(new SqliteDesktopStateStore(layer).state.page.siteKey).toBeNull();
  });

  it("does not mark a missing legacy file before it exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-legacy-missing-"));
    directories.push(directory);
    const paths = legacyPaths(directory);
    const layer = openLayer(directory, layers);

    const first = new LegacyDataMigrator(layer).migrate(paths);
    expect(first.imported).toEqual([]);
    expect(first.skipped).toHaveLength(4);
    expect(layer.hasMigration("legacy:desktop-state")).toBe(false);

    new JsonFileDesktopStateStore(paths.desktopState).patch({ theme: "dark" });
    const second = new LegacyDataMigrator(layer).migrate(paths);
    expect(second.imported).toEqual(["legacy:desktop-state"]);
    expect(layer.hasMigration("legacy:desktop-state")).toBe(true);
  });

  it("persists configuration history through normalized SQLite rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-config-sqlite-"));
    directories.push(directory);
    const layer = openLayer(directory, layers);
    const persistence = new SqliteConfigHistoryPersistence(layer);
    const store = new ConfigHistoryStore(persistence);
    const first = store.recordSuccessful(
      "https://config.example.invalid/config.json",
      "url",
      JSON.stringify({ sites: [{ key: "one", api: "csp_Douban" }] }),
      { etag: "v1" },
    );
    const second = store.recordSuccessful(
      "https://config.example.invalid/config.json",
      "url",
      JSON.stringify({ sites: [{ key: "two", api: "csp_Douban" }] }),
      { etag: "v2" },
    );

    const restored = new ConfigHistoryStore(persistence);
    expect(restored.versions(first.source)).toHaveLength(2);
    expect(restored.cached(first.source)?.id).toBe(second.id);
    expect(restored.cached(first.source)?.validators.etag).toBe("v2");
    restored.rollback(first.source, first.id);
    expect(new ConfigHistoryStore(persistence).cached(first.source)?.id).toBe(first.id);
    expect(layer.prepare("SELECT COUNT(*) AS count FROM config_versions").get()).toMatchObject({ count: 2 });
  });
});

function legacyPaths(directory: string): LegacyDataPaths {
  return {
    desktopState: join(directory, "desktop-state.json"),
    configHistory: join(directory, "config-history.json"),
    sourceHealth: join(directory, "source-health.json"),
    streamHealth: join(directory, "stream-health.json"),
  };
}

function openLayer(directory: string, layers: SqliteDataLayer[]): SqliteDataLayer {
  const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
  layers.push(layer);
  return layer;
}
