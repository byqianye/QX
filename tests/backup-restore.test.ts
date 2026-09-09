import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsRepository } from "../src/data/repositories.js";
import { BACKUP_DATABASE_ENTRY, BackupRestoreService } from "../src/data/backup-restore.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";

const roots: string[] = [];
const layers: SqliteDataLayer[] = [];

describe("backup and restore", () => {
  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a consistent versioned backup, excludes web secrets, and restores by replacement", async () => {
    const root = createFixtureRoot();
    const databasePath = join(root, "qx-yingshi.db");
    const layer = openLayer(databasePath);
    const settings = new SettingsRepository(layer);
    settings.set("safe-setting", { enabled: true });
    settings.set("web.security", { allowLan: true, pin: { salt: "secret", digest: "secret" } });
    mkdirSync(join(root, "downloads"), { recursive: true });
    insertBusinessRows(layer, "before-backup");
    layer.prepare("INSERT INTO download_target_directories(id, directory_path, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "downloads-1", join(root, "downloads"), "Downloads", 1, 1,
    );
    layer.prepare("INSERT INTO download_tasks(id, title, target_directory_id, suggested_filename, request_reference, status, created_at, updated_at, backend_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "download-1", "Movie", "downloads-1", "movie.mp4", "https://media.example.invalid/temp.mp4?expires=secret", "paused", 1, 1, "aria2-secret",
    );

    const service = createService(root, databasePath);
    const created = await service.createBackup(layer);
    expect(created.fileName).toMatch(/\.zip$/u);
    expect(readFileSync(join(root, "backups", created.fileName)).subarray(0, 2).toString("ascii")).toBe("PK");
    expect(created.includeCache).toBe(false);
    expect(created.summary).toMatchObject({ history: 1, favorites: 1, following: 1 });

    layer.close();
    layers.splice(layers.indexOf(layer), 1);
    const preview = service.preview(join(root, "backups", created.fileName));
    expect(preview).toMatchObject({ compatibility: "compatible", includeCache: false, summary: created.summary });

    const changed = openLayer(databasePath);
    changed.prepare("DELETE FROM history").run();
    changed.prepare("DELETE FROM settings WHERE key = ?").run("safe-setting");
    changed.close();
    layers.splice(layers.indexOf(changed), 1);

    const restored = service.restore();
    expect(restored.preRestoreBackupPath).toBeTruthy();
    expect(existsSync(join(restored.preRestoreBackupPath as string, "qx-yingshi.db"))).toBe(true);

    const reopened = openLayer(databasePath);
    expect(reopened.prepare("SELECT title FROM history WHERE identity = ?").get("history-1")).toMatchObject({ title: "before-backup" });
    expect(new SettingsRepository(reopened).get("safe-setting")).toEqual({ enabled: true });
    expect(new SettingsRepository(reopened).get("web.security")).toEqual({ allowLan: true });
    expect(reopened.prepare("SELECT request_reference, backend_id FROM download_tasks WHERE id = ?").get("download-1"))
      .toEqual({ request_reference: "backup:redacted:download-1", backend_id: null });
  });

  it("round-trips optional cache files and removes cache metadata when cache is excluded", async () => {
    const root = createFixtureRoot();
    const databasePath = join(root, "qx-yingshi.db");
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(join(root, "cache", "poster.txt"), "poster", "utf8");
    const layer = openLayer(databasePath);
    layer.prepare("INSERT INTO cache_entries(cache_key, type, path, size, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "poster", "image", "poster.txt", 6, 1, 1,
    );
    const service = createService(root, databasePath);
    const created = await service.createBackup(layer, { includeCache: true });
    layer.close();
    layers.splice(layers.indexOf(layer), 1);
    const preview = service.preview(join(root, "backups", created.fileName));
    expect(preview.includeCache).toBe(true);
    rmSync(join(root, "cache"), { recursive: true, force: true });
    service.restore();
    expect(readFileSync(join(root, "cache", "poster.txt"), "utf8")).toBe("poster");

    const noCacheLayer = openLayer(databasePath);
    const noCacheService = createService(root, databasePath);
    const noCache = await noCacheService.createBackup(noCacheLayer);
    noCacheLayer.close();
    layers.splice(layers.indexOf(noCacheLayer), 1);
    noCacheService.preview(join(root, "backups", noCache.fileName));
    noCacheService.restore();
    const reopened = openLayer(databasePath);
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM cache_entries").get()).toMatchObject({ count: 0 });
  });

  it("rejects corrupt, newer, traversal, and zip-bomb archives before staging", () => {
    const root = createFixtureRoot();
    const service = createService(root, join(root, "qx-yingshi.db"));
    const traversal = join(root, "traversal.zip");
    writeFileSync(traversal, storedZip([{ name: "../outside", data: Buffer.from("x") }]));
    expectBackupCode(() => service.preview(traversal), "BACKUP_ZIP_SLIP");
    for (const [label, name] of [["absolute", "/outside"], ["drive", "C:/outside"], ["unc", "//server/share/outside"]] as const) {
      const archive = join(root, `${label}.zip`);
      writeFileSync(archive, storedZip([{ name, data: Buffer.from("x") }]));
      expectBackupCode(() => service.preview(archive), "BACKUP_ZIP_SLIP");
    }

    const newer = join(root, "newer.zip");
    writeFileSync(newer, storedZip([{
      name: "manifest.json",
      data: Buffer.from(JSON.stringify({ formatVersion: 99 }), "utf8"),
    }]));
    expectBackupCode(() => service.preview(newer), "BACKUP_VERSION_TOO_NEW");

    const checksum = join(root, "checksum.zip");
    writeFileSync(checksum, storedZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify({
        formatVersion: 1,
        sections: ["database"],
        checksums: { "data/database.db": "0".repeat(64) },
      }), "utf8") },
      { name: "data/database.db", data: Buffer.from("database") },
    ]));
    expectBackupCode(() => service.preview(checksum), "BACKUP_CHECKSUM_FAILED");

    const bomb = join(root, "bomb.zip");
    writeFileSync(bomb, storedZip([{ name: "manifest.json", data: Buffer.from("{}"), uncompressedSize: 300 * 1024 * 1024 }]));
    expectBackupCode(() => service.preview(bomb), "BACKUP_ZIP_BOMB");
  });

  it("accepts the previous backup format and runs the staged database through migrations", () => {
    const root = createFixtureRoot();
    const databasePath = join(root, "qx-yingshi.db");
    const layer = openLayer(databasePath);
    insertBusinessRows(layer, "older-format");
    layer.close();
    layers.splice(layers.indexOf(layer), 1);
    const database = readFileSync(databasePath);
    const olderArchive = join(root, "older.zip");
    writeFileSync(olderArchive, storedZip([
      {
        name: "manifest.json",
        data: Buffer.from(JSON.stringify({
          formatVersion: 0,
          appVersion: "0.0.1",
          createdAt: "2026-01-01T00:00:00.000Z",
          sections: ["database"],
          checksums: { "data/database.db": createHash("sha256").update(database).digest("hex") },
          summary: { history: 1, favorites: 1, following: 1 },
        }), "utf8"),
      },
      { name: "data/database.db", data: database },
    ]));
    const service = createService(root, databasePath);
    expect(service.preview(olderArchive)).toMatchObject({ compatibility: "migration-required" });
  });

  it("rolls back the current database when replacement validation fails", async () => {
    const root = createFixtureRoot();
    const databasePath = join(root, "qx-yingshi.db");
    const layer = openLayer(databasePath);
    insertBusinessRows(layer, "rollback-source");
    const service = createService(root, databasePath);
    const created = await service.createBackup(layer);
    layer.close();
    layers.splice(layers.indexOf(layer), 1);
    service.preview(join(root, "backups", created.fileName));
    const pending = (service as unknown as { pendingRestore: { stageDirectory: string } | null }).pendingRestore;
    expect(pending).not.toBeNull();
    writeFileSync(join(pending!.stageDirectory, BACKUP_DATABASE_ENTRY), Buffer.from("not a sqlite database"));
    expectBackupCode(() => service.restore(), "BACKUP_RESTORE_FAILED");

    const reopened = openLayer(databasePath);
    expect(reopened.prepare("SELECT title FROM history WHERE identity = ?").get("history-1"))
      .toMatchObject({ title: "rollback-source" });
  });
});

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qx-backup-"));
  roots.push(root);
  mkdirSync(join(root, "backups"), { recursive: true });
  mkdirSync(join(root, "temp"), { recursive: true });
  return root;
}

function openLayer(path: string): SqliteDataLayer {
  const layer = SqliteDataLayer.create(path);
  layers.push(layer);
  return layer;
}

function createService(root: string, databasePath: string): BackupRestoreService {
  return new BackupRestoreService({
    dataRoot: root,
    databasePath,
    backupsDirectory: join(root, "backups"),
    tempDirectory: join(root, "temp"),
  });
}

function insertBusinessRows(layer: SqliteDataLayer, title: string): void {
  layer.prepare("INSERT INTO history(identity, source_id, vod_id, title, position, duration, updated_at, completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "history-1", "source-1", "vod-1", title, 10, 100, 1, 0,
  );
  layer.prepare("INSERT INTO favorite_groups(group_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    "group-1", "Group", 0, 1, 1,
  );
  layer.prepare("INSERT INTO favorites(favorite_id, source_id, vod_id, title, group_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "favorite-1", "source-1", "vod-1", title, "group-1", 1, 1,
  );
  layer.prepare("INSERT INTO follow_items(identity, source_id, vod_id, title, enabled) VALUES (?, ?, ?, ?, ?)").run(
    "follow-1", "source-1", "vod-1", title, 1,
  );
}

function storedZip(entries: readonly { name: string; data: Buffer; uncompressedSize?: number }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = testCrc32(entry.data);
    const size = entry.uncompressedSize ?? entry.data.byteLength;
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.byteLength + entry.data.byteLength;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function testCrc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    let current = (value ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    value = (value >>> 8) ^ current;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function expectBackupCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected backup error ${code}`);
}
