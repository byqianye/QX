import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigHistoryStore } from "../src/config/history.js";
import { SqliteConfigHistoryPersistence } from "../src/data/config-history-persistence.js";
import {
  CacheRepository,
  FavoritesRepository,
  FollowRepository,
  HealthRepository,
  HistoryRepository,
  PlaybackProgressRepository,
  SettingsRepository,
} from "../src/data/repositories.js";
import { PlaybackProgressWriter, type ProgressWriterScheduler } from "../src/data/progress-writer.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";

describe("SQLite repositories", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("provides CRUD boundaries for settings, history, and progress", () => {
    const { layer } = openLayer();
    const settings = new SettingsRepository(layer);
    const history = new HistoryRepository(layer);
    const progress = new PlaybackProgressRepository(layer);

    settings.set("theme", { value: "dark" });
    expect(settings.get("theme")).toEqual({ value: "dark" });

    const historyRecord = {
      identity: "source-a:vod-1:episode-1",
      sourceId: "source-a",
      vodId: "vod-1",
      seasonId: null,
      episodeId: "episode-1",
      title: "Fixture title",
      poster: "https://image.example/poster.jpg",
      episode: 1,
      episodeName: "第一集",
      playbackLine: "主线",
      position: 42,
      duration: 100,
      updatedAt: 10,
      completed: false,
      sourceDisplayName: "Fixture source",
    } as const;
    history.upsert(historyRecord);
    expect(history.get(historyRecord.identity)).toEqual(historyRecord);

    progress.upsert({ identity: historyRecord.identity, position: 42, duration: 100, updatedAt: 10, completed: false });
    expect(progress.get(historyRecord.identity)).toMatchObject({ position: 42, duration: 100 });
    history.delete(historyRecord.identity);
    expect(history.get(historyRecord.identity)).toBeNull();
  });

  it("redacts forbidden credentials and playback endpoints before SQLite writes", () => {
    const { layer } = openLayer();
    const settings = new SettingsRepository(layer);
    settings.set("unsafe-settings", {
      cookie: "session-secret",
      authorization: "Bearer auth-secret",
      url: "https://media.example.invalid/video.m3u8?token=url-secret",
      safe: "kept",
    });
    settings.set("Authorization", "direct-secret");
    const history = new ConfigHistoryStore(new SqliteConfigHistoryPersistence(layer));
    history.recordSuccessful(
      "https://config.example.invalid/config.json?token=config-secret",
      "url",
      JSON.stringify({
        sites: [{
          key: "fixture",
          api: "csp_Douban",
          cookie: "site-secret",
          headers: { Authorization: "Bearer header-secret" },
        }],
      }),
    );

    const storedText = layer.prepare(`
      SELECT value_json AS value FROM settings
      UNION ALL SELECT source FROM config_sources
      UNION ALL SELECT raw_json FROM config_versions
      UNION ALL SELECT config_json FROM config_versions
    `).all().map((row) => String(row.value)).join("\n");
    expect(storedText).not.toMatch(/session-secret|auth-secret|url-secret|config-secret|site-secret|header-secret|direct-secret/);
    expect(storedText).toContain("[redacted]");
    expect(settings.get("unsafe-settings")).toMatchObject({ safe: "kept", cookie: "[redacted]" });
    expect(settings.get("Authorization")).toBe("[redacted]");
    expect(new ConfigHistoryStore(new SqliteConfigHistoryPersistence(layer))
      .cached("https://config.example.invalid/config.json?token=config-secret"))
      .not.toBeNull();
  });

  it("supports favorite groups, transactional ordering, follow items, and health snapshots", () => {
    const { layer } = openLayer();
    const favorites = new FavoritesRepository(layer);
    const follow = new FollowRepository(layer);
    const health = new HealthRepository(layer);

    favorites.upsertGroup({ groupId: "default", name: "默认收藏", sortOrder: 0, createdAt: 1, updatedAt: 1 });
    favorites.upsert({
      favoriteId: "favorite-a",
      sourceId: "source-a",
      vodId: "vod-a",
      title: "A",
      poster: null,
      year: null,
      category: null,
      sourceName: null,
      groupId: "default",
      sortOrder: 0,
      metadata: { year: 2026 },
      addedAt: 1,
      updatedAt: 1,
    });
    favorites.upsert({
      favoriteId: "favorite-b",
      sourceId: "source-b",
      vodId: "vod-b",
      title: "B",
      poster: null,
      year: null,
      category: null,
      sourceName: null,
      groupId: "default",
      sortOrder: 1,
      metadata: null,
      addedAt: 2,
      updatedAt: 2,
    });
    favorites.reorder(["favorite-b", "favorite-a"]);
    expect(favorites.list("default").map((item) => item.favoriteId)).toEqual(["favorite-b", "favorite-a"]);

    follow.upsert({
      identity: "source-a:vod-a",
      sourceId: "source-a",
      vodId: "vod-a",
      title: "A",
      latestEpisodeId: "ep-2",
      latestEpisodeName: "第二集",
      watchedEpisodeId: "ep-1",
      watchedEpisodeName: "第一集",
      knownEpisodeCount: 2,
      lastCheckedAt: 2,
      lastUpdatedAt: 2,
      updateAvailable: true,
      checkError: null,
      enabled: true,
    });
    expect(follow.list()).toMatchObject([{ updateAvailable: true, latestEpisodeId: "ep-2" }]);

    health.upsertSource({ id: "source-a", snapshot: { circuit: "closed" }, updatedAt: 3 });
    health.upsertStream({ id: "stream-a", sourceId: "source-a", snapshot: { score: 90 }, updatedAt: 3 });
    expect(health.readSource("source-a")).toEqual({ circuit: "closed" });
  });

  it("clears cache metadata without touching user data", () => {
    const { layer } = openLayer();
    const cache = new CacheRepository(layer);
    const history = new HistoryRepository(layer);
    const favorites = new FavoritesRepository(layer);
    const now = Date.now();

    history.upsert({
      identity: "history-1",
      sourceId: "source",
      vodId: "vod",
      seasonId: null,
      episodeId: null,
      title: "History",
      poster: null,
      episode: null,
      episodeName: null,
      playbackLine: null,
      position: 0,
      duration: 0,
      updatedAt: now,
      completed: false,
      sourceDisplayName: null,
    });
    favorites.upsert({
      favoriteId: "fav-1",
      sourceId: "source",
      vodId: "vod",
      title: "Favorite",
      poster: null,
      year: null,
      category: null,
      sourceName: null,
      groupId: null,
      sortOrder: 0,
      metadata: null,
      addedAt: now,
      updatedAt: now,
    });
    cache.upsert({
      cacheKey: "search:fixture",
      type: "search",
      sourceId: "source",
      path: "cache/search-fixture.json",
      size: 12,
      createdAt: now,
      accessedAt: now,
      expiresAt: now + 1_000,
      etag: null,
      contentHash: "hash",
    });
    cache.clearCategory("search");
    expect(cache.list()).toEqual([]);
    expect(history.get("history-1")).not.toBeNull();
    expect(favorites.list()).toHaveLength(1);
  });

  it("coalesces progress updates and flushes on pause, stop, episode change, and close", () => {
    const { layer } = openLayer();
    const repository = new PlaybackProgressRepository(layer);
    const scheduler = new FakeScheduler();
    const writer = new PlaybackProgressWriter(repository, {
      debounceMs: 10,
      intervalMs: 50,
      scheduler,
    });
    const first = { identity: "episode", position: 1, duration: 100, updatedAt: 1, completed: false } as const;
    writer.update(first);
    writer.update({ ...first, position: 2, updatedAt: 2 });
    expect(writer.hasPendingWrite).toBe(true);
    expect(repository.get("episode")).toBeNull();
    scheduler.run(10);
    expect(repository.get("episode")).toMatchObject({ position: 2, updatedAt: 2 });
    expect(writer.lastFlushReason).toBe("debounce");

    writer.update({ ...first, position: 3, updatedAt: 3 });
    writer.pause();
    expect(repository.get("episode")).toMatchObject({ position: 3, updatedAt: 3 });
    expect(writer.lastFlushReason).toBe("pause");

    writer.update({ ...first, position: 4, updatedAt: 4 });
    writer.stop();
    writer.update({ ...first, position: 5, updatedAt: 5 });
    writer.episodeChange();
    writer.update({ ...first, position: 6, updatedAt: 6 });
    writer.appClose();
    expect(repository.get("episode")).toMatchObject({ position: 6, updatedAt: 6 });
    expect(writer.hasPendingWrite).toBe(false);
  });

  function openLayer(): { layer: SqliteDataLayer } {
    const directory = mkdtempSync(join(tmpdir(), "qx-repositories-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    return { layer };
  }
});

class FakeScheduler implements ProgressWriterScheduler {
  private nextId = 0;
  private readonly tasks = new Map<number, { handler: () => void; delayMs: number }>();

  public setTimeout(handler: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { handler, delayMs });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.tasks.delete(handle);
  }

  public run(delayMs: number): void {
    const task = [...this.tasks.entries()].find(([, value]) => value.delayMs === delayMs);
    if (!task) throw new Error(`No scheduled task for ${delayMs}ms`);
    this.tasks.delete(task[0]);
    task[1].handler();
  }
}
