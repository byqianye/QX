import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DataDirectoryError, DataDirectoryResolver, DataStorageService } from "../src/data/data-directory.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";

const testDirectories: string[] = [];

describe("data directory resolver and migration", () => {
  afterEach(() => {
    while (testDirectories.length > 0) {
      const directory = testDirectories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses normal mode by default and does not mistake a development data folder for portable mode", () => {
    const root = mkdtempSync(join(tmpdir(), "qx-data-resolver-"));
    testDirectories.push(root);
    const executable = join(root, "app", "QX影视.exe");
    mkdirSync(join(root, "app", "data"), { recursive: true });
    const userData = join(root, "user-data");
    const resolver = new DataDirectoryResolver(userData, {
      executablePath: executable,
      packaged: false,
    });

    expect(resolver.resolve()).toMatchObject({ mode: "normal", dataRoot: userData });
    expect(resolver.resolve().settings).toBe(join(userData, "settings"));
  });

  it("selects portable data only for the packaged QX executable with a sibling data folder", () => {
    const root = mkdtempSync(join(tmpdir(), "qx-portable-detect-"));
    testDirectories.push(root);
    const executable = join(root, "QX影视.exe");
    const portableRoot = join(root, "data");
    mkdirSync(portableRoot, { recursive: true });
    const resolver = new DataDirectoryResolver(join(root, "user-data"), {
      executablePath: executable,
      packaged: true,
    });

    expect(resolver.resolve()).toMatchObject({ mode: "portable", dataRoot: portableRoot });
    resolver.setModeOverride("normal");
    expect(resolver.resolve()).toMatchObject({ mode: "normal" });
  });

  it("prepares all data directories and reports a safe storage summary", () => {
    const root = mkdtempSync(join(tmpdir(), "qx-data-prepare-"));
    testDirectories.push(root);
    const resolver = new DataDirectoryResolver(join(root, "user-data"));
    const prepared = resolver.prepare();
    const storage = new DataStorageService(resolver);

    expect(prepared.mode).toBe("normal");
    expect([prepared.dataRoot, prepared.cache, prepared.logs, prepared.temp, prepared.backups, prepared.settings]
      .every((path) => existsSync(path))).toBe(true);
    expect(storage.uiState()).toMatchObject({
      mode: "normal",
      dataRoot: "…/user-data",
      writable: true,
      databaseBytes: 0,
      cacheBytes: 0,
      totalBytes: 0,
    });
  });

  it("returns a stable portable writability error", () => {
    const root = mkdtempSync(join(tmpdir(), "qx-portable-permission-"));
    testDirectories.push(root);
    const executable = join(root, "QX影视.exe");
    const userData = join(root, "user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(root, "data"), "not a directory", "utf8");
    const resolver = new DataDirectoryResolver(userData, { executablePath: executable, packaged: true });
    resolver.setModeOverride("portable");

    expect(() => resolver.prepare()).toThrowError(DataDirectoryError);
    try {
      resolver.prepare();
    } catch (error) {
      expect(error).toMatchObject({ code: "PORTABLE_DATA_NOT_WRITABLE" });
    }
  });

  it("migrates database and cache data to portable mode without deleting the source", () => {
    const fixture = createFixture("qx-data-migrate-");
    const normalResolver = new DataDirectoryResolver(fixture.userData, {
      executablePath: fixture.executable,
      packaged: false,
    });
    const normal = normalResolver.prepare();
    createDatabase(normal.database);
    writeFileSync(join(normal.cache, "fixture.txt"), "cache-value", "utf8");
    const storage = new DataStorageService(normalResolver);

    const result = storage.migrateTo("portable");

    expect(result.from.mode).toBe("normal");
    expect(result.to.mode).toBe("portable");
    expect(result.archivedSourcePath).toBeNull();
    expect(existsSync(result.to.database)).toBe(true);
    expect(readFileSync(join(result.to.cache, "fixture.txt"), "utf8")).toBe("cache-value");
    const migrated = SqliteDataLayer.create(result.to.database);
    try {
      expect(migrated.prepare("SELECT value_json FROM settings WHERE key = ?").get("fixture"))
        .toMatchObject({ value_json: "{\"ok\":true}" });
    } finally {
      migrated.close();
    }
    expect(existsSync(normal.database)).toBe(true);
    expect(storage.directories().mode).toBe("portable");
    expect(storage.uiState().dataRoot).toBe("…/data");
    expect(readdirSync(result.to.dataRoot)).toEqual(expect.arrayContaining(["qx-yingshi.db", "cache"]));
  });

  it("switches back to normal mode, keeps a target backup, and archives the old portable root", () => {
    const fixture = createFixture("qx-data-roundtrip-");
    const resolver = new DataDirectoryResolver(fixture.userData, {
      executablePath: fixture.executable,
      packaged: false,
    });
    const normal = resolver.prepare();
    createDatabase(normal.database);
    writeFileSync(join(normal.cache, "normal.txt"), "normal", "utf8");
    const storage = new DataStorageService(resolver);
    const portableResult = storage.migrateTo("portable");
    writeFileSync(join(portableResult.to.cache, "portable.txt"), "portable", "utf8");

    const packagedResolver = new DataDirectoryResolver(fixture.userData, {
      executablePath: fixture.executable,
      packaged: true,
    });
    const portableStorage = new DataStorageService(packagedResolver);
    const result = portableStorage.migrateTo("normal");

    expect(result.archivedSourcePath).toMatch(/data\.previous-/);
    expect(existsSync(result.to.database)).toBe(true);
    expect(readFileSync(join(result.to.cache, "portable.txt"), "utf8")).toBe("portable");
    expect(existsSync(result.archivedSourcePath!)).toBe(true);
    expect(existsSync(join(result.to.backups))).toBe(true);
    expect(new DataDirectoryResolver(fixture.userData, {
      executablePath: fixture.executable,
      packaged: true,
    }).resolve().mode).toBe("normal");
  });

  it("validates the staged database and preserves the source when migration fails", () => {
    const fixture = createFixture("qx-data-migration-failure-");
    const resolver = new DataDirectoryResolver(fixture.userData, {
      executablePath: fixture.executable,
      packaged: false,
    });
    const normal = resolver.prepare();
    writeFileSync(normal.database, "not a sqlite database", "utf8");
    const storage = new DataStorageService(resolver);

    expect(() => storage.migrateTo("portable")).toThrowError(DataDirectoryError);
    try {
      storage.migrateTo("portable");
    } catch (error) {
      expect(error).toMatchObject({ code: "DATA_MIGRATION_FAILED" });
    }
    expect(readFileSync(normal.database, "utf8")).toBe("not a sqlite database");
    expect(existsSync(join(fixture.root, "data"))).toBe(false);
    expect(readdirSync(fixture.root).some((name) => name.includes("qx-data-migration-"))).toBe(false);
  });
});

function createFixture(prefix: string): {
  root: string;
  userData: string;
  executable: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  testDirectories.push(root);
  const appDirectory = join(root, "app");
  mkdirSync(appDirectory, { recursive: true });
  return {
    root,
    userData: join(root, "user-data"),
    executable: join(appDirectory, "QX影视.exe"),
  };
}

function createDatabase(path: string): void {
  const layer = SqliteDataLayer.create(path);
  try {
    layer.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)").run("fixture", "{\"ok\":true}", 1);
  } finally {
    layer.close();
  }
}
