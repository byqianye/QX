import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  FavoritesRepository,
  HistoryRepository,
} from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { FavoritesService } from "../src/favorites/favorites-service.js";
import { DEFAULT_FAVORITE_GROUP_ID } from "../src/favorites/favorites-types.js";

describe("G52 favorites", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates by source and vod identity while keeping same titles from different sources", () => {
    const { service, layer } = openService();
    const firstInput = {
      sourceId: "https://source-a.example/config.json?token=source-secret",
      vodId: "same-vod",
      title: "Same title",
      poster: "https://image.example/poster.jpg?token=poster-secret",
      metadata: {
        area: "内置源",
        streamUrl: "https://media.example/video.m3u8?token=stream-secret",
        cookie: "session-secret",
      },
    };
    const first = service.toggle(firstInput);
    const second = service.toggle({ ...firstInput, sourceId: "https://source-b.example/config.json?token=source-secret", poster: "https://image.example/poster.jpg" });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(service.uiState().items).toHaveLength(2);
    expect(new Set(service.uiState().items.map((item) => item.title))).toEqual(new Set(["Same title"]));

    expect(service.toggle(firstInput)).toBeNull();
    expect(service.uiState().items).toHaveLength(1);
    const unsafePoster = service.toggle({
      sourceId: "source-c",
      vodId: "vod-c",
      title: "Unsafe poster",
      poster: "https://media.example/session/abc",
    });
    expect(unsafePoster?.poster).toBeNull();

    const stored = layer.prepare("SELECT * FROM favorites").all().map((row) => JSON.stringify(row)).join("\n");
    expect(stored).not.toMatch(/source-secret|poster-secret|stream-secret|session-secret|video\.m3u8/i);
    expect(stored).toContain("https://image.example/poster.jpg");
  });

  it("supports groups, rename, move, and explicit non-empty group deletion", () => {
    const { service } = openService();
    const first = service.toggle({ sourceId: "source-a", vodId: "vod-a", title: "A" });
    const second = service.toggle({ sourceId: "source-a", vodId: "vod-b", title: "B" });
    if (!first || !second) throw new Error("Expected favorites");

    const group = service.createGroup("稍后观看");
    service.renameGroup(group.groupId, "周末观看");
    service.move(first.favoriteId, group.groupId);
    service.move(second.favoriteId, group.groupId);
    expect(service.uiState().groups.find((item) => item.groupId === group.groupId)).toMatchObject({ name: "周末观看", count: 2 });
    expect(service.uiState().items.filter((item) => item.groupId === group.groupId).map((item) => item.favoriteId))
      .toEqual([first.favoriteId, second.favoriteId]);

    expect(() => service.deleteGroup(group.groupId)).toThrow("FAVORITE_GROUP_DISPOSITION_REQUIRED");
    expect(service.get(first.favoriteId)).not.toBeNull();

    service.deleteGroup(group.groupId, "default");
    expect(service.get(first.favoriteId)?.groupId).toBe(DEFAULT_FAVORITE_GROUP_ID);

    const disposable = service.createGroup("临时组");
    service.move(second.favoriteId, disposable.groupId);
    service.deleteGroup(disposable.groupId, "delete");
    expect(service.get(second.favoriteId)).toBeNull();
    expect(() => service.renameGroup(DEFAULT_FAVORITE_GROUP_ID, "不能改")).toThrow("FAVORITE_DEFAULT_GROUP_PROTECTED");
  });

  it("sorts by manual order, added time, title, and recent history", () => {
    let now = 10;
    const { service, layer } = openService(() => now);
    const first = service.toggle({ sourceId: "source-a", vodId: "vod-a", title: "Zebra" });
    now = 20;
    const second = service.toggle({ sourceId: "source-a", vodId: "vod-b", title: "Alpha" });
    if (!first || !second) throw new Error("Expected favorites");

    expect(service.uiState(null, "added").items.map((item) => item.favoriteId)).toEqual([second.favoriteId, first.favoriteId]);
    expect(service.uiState(null, "title").items.map((item) => item.title)).toEqual(["Alpha", "Zebra"]);

    const history = new HistoryRepository(layer);
    history.upsert(historyRecord(first.sourceId, first.vodId, 200));
    history.upsert(historyRecord(second.sourceId, second.vodId, 300));
    expect(service.uiState(null, "recent").items.map((item) => item.favoriteId)).toEqual([second.favoriteId, first.favoriteId]);

    service.reorder(DEFAULT_FAVORITE_GROUP_ID, [second.favoriteId, first.favoriteId]);
    expect(service.uiState(null, "manual").items.map((item) => item.favoriteId)).toEqual([second.favoriteId, first.favoriteId]);
    expect(() => service.reorder(DEFAULT_FAVORITE_GROUP_ID, [first.favoriteId])).toThrow("FAVORITE_SORT_INVALID");
    expect(service.uiState(null, "manual").items.map((item) => item.favoriteId)).toEqual([second.favoriteId, first.favoriteId]);
  });

  it("marks a favorite unavailable without replacing or deleting it", () => {
    const { service } = openService();
    const favorite = service.toggle({ sourceId: "source-a", vodId: "vod-a", title: "A" });
    if (!favorite) throw new Error("Expected favorite");

    expect(service.uiState("source-a").items[0]).toMatchObject({ sourceAvailable: true, sourceId: "source-a" });
    expect(service.uiState("source-b").items[0]).toMatchObject({ sourceAvailable: false, sourceId: "source-a" });
    expect(service.get(favorite.favoriteId)).not.toBeNull();
  });

  it("persists favorites and custom groups across a database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-favorites-restart-"));
    directories.push(directory);
    const path = join(directory, "qx-yingshi.db");
    const firstLayer = SqliteDataLayer.create(path);
    layers.push(firstLayer);
    const firstService = createService(firstLayer);
    const group = firstService.createGroup("持久化组");
    const favorite = firstService.toggle({ sourceId: "source-a", vodId: "vod-a", title: "Persisted" });
    if (!favorite) throw new Error("Expected favorite");
    firstService.move(favorite.favoriteId, group.groupId);
    firstLayer.close();
    layers.splice(layers.indexOf(firstLayer), 1);

    const secondLayer = SqliteDataLayer.create(path);
    layers.push(secondLayer);
    const secondService = createService(secondLayer);
    expect(secondService.get(favorite.favoriteId)).toMatchObject({ title: "Persisted", groupId: group.groupId });
    expect(secondService.uiState().groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: DEFAULT_FAVORITE_GROUP_ID }),
      expect.objectContaining({ groupId: group.groupId, name: "持久化组", count: 1 }),
    ]));
  });

  function openService(now: () => number = () => Date.now()): { service: FavoritesService; layer: SqliteDataLayer } {
    const directory = mkdtempSync(join(tmpdir(), "qx-favorites-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    return { service: createService(layer, now), layer };
  }

  function createService(layer: SqliteDataLayer, now: () => number = () => Date.now()): FavoritesService {
    return new FavoritesService({
      db: layer,
      favorites: new FavoritesRepository(layer),
      history: new HistoryRepository(layer),
      now,
    });
  }
});

function historyRecord(sourceId: string, vodId: string, updatedAt: number) {
  return {
    identity: `${sourceId}:${vodId}:episode-1`,
    sourceId,
    vodId,
    seasonId: null,
    episodeId: "episode-1",
    title: "History",
    poster: null,
    episode: 1,
    episodeName: "Episode 1",
    playbackLine: null,
    position: 10,
    duration: 100,
    updatedAt,
    completed: false,
    sourceDisplayName: "Fixture source",
  } as const;
}
