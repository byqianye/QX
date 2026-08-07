import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CacheRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  CACHE_MAX_IMAGE_BYTES,
  CacheService,
} from "../src/cache/cache-service.js";

const testLayers: SqliteDataLayer[] = [];
const testDirectories: string[] = [];

describe("cache management", () => {
  afterEach(() => {
    while (testLayers.length > 0) testLayers.pop()?.close();
    while (testDirectories.length > 0) {
      const directory = testDirectories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores hashed entries, reads them, expires them, and survives restart", async () => {
    let now = 1_000;
    const first = createCache(() => now);
    const record = await first.service.put({
      type: "search",
      key: { query: "fixture", sourceId: "source-a" },
      bytes: Buffer.from("search-result"),
      etag: "fixture-etag",
      ttlMs: 100,
    });
    const reorderedKey = first.service.cacheKey("search", { sourceId: "source-a", query: "fixture" });

    expect(record.cacheKey).toBe(reorderedKey);
    expect(record.etag).toBe("fixture-etag");
    expect(record.path).toMatch(/^search\/[a-f0-9-]+\.bin$/);
    expect(record.path).not.toContain("fixture");
    expect(first.service.read(record.cacheKey)?.toString()).toBe("search-result");
    expect(first.service.uiState().byType.find((item) => item.type === "search")).toMatchObject({
      count: 1,
      bytes: 13,
    });

    first.layer.close();
    const reopenedLayer = SqliteDataLayer.create(first.databasePath);
    testLayers.push(reopenedLayer);
    const reopened = new CacheService({
      root: first.root,
      repository: new CacheRepository(reopenedLayer),
      now: () => now,
    });
    expect(reopened.read(record.cacheKey)?.toString()).toBe("search-result");

    now += 101;
    expect(reopened.get(record.cacheKey)).toBeNull();
    expect(reopenedLayer.prepare("SELECT COUNT(*) AS count FROM cache_entries").get()).toMatchObject({ count: 0 });
    expect(existsSync(join(first.root, record.path))).toBe(false);
  });

  it("uses independent TTLs and removes expired entries before LRU entries", async () => {
    let now = 10;
    const { service } = createCache(() => now, { maxBytes: 5 });
    const expired = await service.put({ type: "temporary", key: "expired", bytes: Buffer.from("1234"), ttlMs: 1 });
    now = 20;
    const oldest = await service.put({ type: "search", key: "oldest", bytes: Buffer.from("1234"), ttlMs: 1_000 });
    now = 30;
    const newest = await service.put({ type: "detail", key: "newest", bytes: Buffer.from("1234"), ttlMs: 1_000 });

    expect(service.get(expired.cacheKey)).toBeNull();
    expect(service.get(oldest.cacheKey)).toBeNull();
    expect(service.get(newest.cacheKey)).not.toBeNull();
    expect(service.uiState().totalBytes).toBe(4);
  });

  it("does not remove an in-use entry until its lease is released", async () => {
    const { service } = createCache();
    const record = await service.put({ type: "detail", key: "in-use", bytes: Buffer.from("content") });
    const lease = service.acquire(record.cacheKey);
    expect(lease).not.toBeNull();
    expect(service.clear("all")).toBe(0);
    expect(service.get(record.cacheKey)).not.toBeNull();
    lease?.release();
    expect(service.clear("all")).toBe(1);
    expect(service.get(record.cacheKey)).toBeNull();
  });

  it("clears only the requested regenerable categories and reports every category", async () => {
    const { service } = createCache();
    await service.put({ type: "poster", key: "poster", bytes: Buffer.from("poster") });
    await service.put({ type: "backdrop", key: "backdrop", bytes: Buffer.from("backdrop") });
    await service.put({ type: "search", key: "search", bytes: Buffer.from("search") });
    await service.put({ type: "detail", key: "detail", bytes: Buffer.from("detail") });

    expect(service.uiState().byType.map((item) => item.type)).toEqual([
      "poster", "backdrop", "source-config", "home", "category", "search", "detail",
      "subtitle", "epg", "parser-metadata", "temporary",
    ]);
    expect(service.clear("images")).toBe(2);
    expect(service.clear("search")).toBe(1);
    expect(service.uiState()).toMatchObject({ entries: 1 });
    expect(service.clear("all")).toBe(1);
    expect(service.uiState()).toMatchObject({ entries: 0, totalBytes: 0 });
  });

  it("validates images, rejects oversized entries, and returns a placeholder on failure", async () => {
    const fetchImpl = async () => new Response("<html>not an image</html>", {
      status: 200,
      headers: { "content-type": "text/html", "content-length": "25" },
    });
    const { service } = createCache(Date.now, { maxEntryBytes: 8, fetchImpl });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const stored = await service.cacheImage({ type: "poster", key: "valid", bytes: png, contentType: "image/png" });
    expect(stored.status).toBe("stored");
    expect(stored.record?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const mismatch = await service.cacheImage({ type: "poster", key: "mismatch", bytes: png, contentType: "image/jpeg" });
    expect(mismatch).toMatchObject({ status: "placeholder", errorCode: "CACHE_IMAGE_MIME_MISMATCH" });
    const invalid = await service.cacheImage({ type: "poster", key: "invalid", bytes: Buffer.from("not-image") });
    expect(invalid).toMatchObject({ status: "placeholder", errorCode: "CACHE_IMAGE_DECODE_FAILED" });
    const downloadFailure = await service.cacheImage({ type: "poster", key: "remote", url: "https://example.invalid/poster" });
    expect(downloadFailure).toMatchObject({ status: "placeholder", errorCode: "CACHE_IMAGE_MIME_INVALID" });

    await expect(service.put({ type: "detail", key: "large", bytes: Buffer.from("123456789") })).rejects.toMatchObject({
      code: "CACHE_ENTRY_TOO_LARGE",
    });
    const oversizedImage = await service.cacheImage({
      type: "poster",
      key: "large-image",
      bytes: Buffer.alloc(CACHE_MAX_IMAGE_BYTES + 1),
      maxBytes: CACHE_MAX_IMAGE_BYTES,
    });
    expect(oversizedImage).toMatchObject({ status: "placeholder", errorCode: "CACHE_IMAGE_TOO_LARGE" });
  });

  it("rejects remote MIME and content-length violations before storing", async () => {
    const fetchImpl = async () => new Response(new Uint8Array(8), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "100" },
    });
    const { service } = createCache(Date.now, { fetchImpl });
    const result = await service.cacheImage({
      type: "poster",
      key: "remote-too-large",
      url: "https://example.invalid/poster.png",
      maxBytes: 10,
    });
    expect(result).toMatchObject({ status: "placeholder", errorCode: "CACHE_IMAGE_TOO_LARGE" });
  });

  it("deduplicates concurrent requests for the same metadata key", async () => {
    const { service } = createCache();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const results = await Promise.all(Array.from({ length: 12 }, () => service.cacheImage({
      type: "poster",
      key: { sourceId: "source-a", vodId: "movie-1" },
      bytes: png,
      contentType: "image/png",
    })));

    expect(results.every((result) => result.status === "stored")).toBe(true);
    expect(new Set(results.map((result) => result.record?.cacheKey)).size).toBe(1);
    expect(service.uiState().entries).toBe(1);
  });

  it("keeps traversal and symlinked paths inside the cache root", () => {
    const { service, repository } = createCache();
    const outside = mkdtempSync(join(tmpdir(), "qx-cache-outside-"));
    testDirectories.push(outside);
    const outsideFile = join(outside, "protected.txt");
    writeFileSync(outsideFile, "keep", "utf8");

    const traversalKey = service.cacheKey("search", "malicious");
    repository.upsert({
      cacheKey: traversalKey,
      type: "search",
      sourceId: null,
      path: "../protected.txt",
      size: 4,
      createdAt: 1,
      accessedAt: 1,
      expiresAt: null,
      etag: null,
      contentHash: null,
    });
    expect(() => service.get(traversalKey)).toThrow(/CACHE_PATH_TRAVERSAL/);
    expect(readFileSync(outsideFile, "utf8")).toBe("keep");

    const link = join(service.rootPath, "escape");
    try {
      symlinkSync(outside, link, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const symlinkKey = service.cacheKey("detail", "symlink");
    repository.upsert({
      cacheKey: symlinkKey,
      type: "detail",
      sourceId: null,
      path: "escape/protected.txt",
      size: 4,
      createdAt: 1,
      accessedAt: 1,
      expiresAt: null,
      etag: null,
      contentHash: null,
    });
    expect(() => service.get(symlinkKey)).toThrow(/CACHE_SYMLINK_ESCAPE/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(outsideFile, "utf8")).toBe("keep");
  });

  it("never clears user data or the database", async () => {
    const { service, layer, databasePath } = createCache();
    layer.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)").run("keep", "{\"value\":1}", 1);
    layer.prepare(`INSERT INTO history(
      identity, source_id, vod_id, title, position, duration, updated_at, completed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("history", "source", "movie", "History", 0, 0, 1, 0);
    layer.prepare(`INSERT INTO favorite_groups(group_id, name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run("group", "Group", 0, 1, 1);
    layer.prepare(`INSERT INTO favorites(
      favorite_id, source_id, vod_id, title, group_id, sort_order, added_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("favorite", "source", "movie", "Favorite", "group", 0, 1, 1);
    layer.prepare(`INSERT INTO follow_items(
      identity, source_id, vod_id, title, enabled, update_available
    ) VALUES (?, ?, ?, ?, ?, ?)`).run("follow", "source", "movie", "Follow", 1, 0);
    await service.put({ type: "temporary", key: "regenerable", bytes: Buffer.from("cache") });

    expect(service.clear("all")).toBe(1);
    expect(existsSync(databasePath)).toBe(true);
    expect(layer.prepare("SELECT COUNT(*) AS count FROM settings").get()).toMatchObject({ count: 1 });
    expect(layer.prepare("SELECT COUNT(*) AS count FROM history").get()).toMatchObject({ count: 1 });
    expect(layer.prepare("SELECT COUNT(*) AS count FROM favorites").get()).toMatchObject({ count: 1 });
    expect(layer.prepare("SELECT COUNT(*) AS count FROM follow_items").get()).toMatchObject({ count: 1 });
    expect(layer.prepare("SELECT COUNT(*) AS count FROM cache_entries").get()).toMatchObject({ count: 0 });
  });
});

function createCache(
  now: () => number = Date.now,
  options: { maxBytes?: number; maxEntryBytes?: number; fetchImpl?: typeof fetch } = {},
): {
  service: CacheService;
  repository: CacheRepository;
  layer: SqliteDataLayer;
  root: string;
  databasePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "qx-cache-"));
  testDirectories.push(directory);
  const databasePath = join(directory, "qx-yingshi.db");
  const layer = SqliteDataLayer.create(databasePath);
  testLayers.push(layer);
  const repository = new CacheRepository(layer);
  const root = join(directory, "cache");
  return {
    service: new CacheService({ root, repository, now, ...options }),
    repository,
    layer,
    root,
    databasePath,
  };
}
