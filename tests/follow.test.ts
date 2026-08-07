import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FollowRepository,
  HistoryRepository,
  type HistoryRecord,
} from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  FollowService,
  followIdentity,
} from "../src/follow/follow-service.js";

const layers: SqliteDataLayer[] = [];
const directories: string[] = [];

describe("follow updates", () => {
  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates by source and vod identity and keeps an initial baseline", () => {
    const { service } = createService();
    const input = content("source-a", "vod-1", [{ id: "ep-1", name: "第一集" }]);
    const first = service.follow(input);
    const duplicate = service.follow({ ...input, title: "Renamed" });

    expect(duplicate.identity).toBe(first.identity);
    expect(service.uiState("source-a").items).toMatchObject([{
      identity: first.identity,
      latestEpisodeId: "ep-1",
      updateAvailable: false,
      sourceAvailable: true,
      status: "caught-up",
    }]);
    expect(service.toggle(input)).toBeNull();
    expect(service.uiState().items).toHaveLength(0);
  });

  it("detects stable-id and episode-name changes without comparing count alone", async () => {
    const { service } = createService();
    service.follow(content("source-a", "vod-1", [
      { id: "ep-1", name: "第一集" },
      { id: "ep-2", name: "第二集" },
    ]));

    await service.check(async () => content("source-a", "vod-1", [
      { id: "ep-1", name: "第一集" },
      { id: "ep-2", name: "第二集" },
      { id: "ep-2-extra", name: "第二集花絮" },
    ]));
    expect(service.uiState("source-a").items[0]).toMatchObject({
      latestEpisodeId: "ep-2-extra",
      updateAvailable: true,
    });

    const fresh = createService();
    const freshService = fresh.service;
    service.unfollow(followIdentity("source-a", "vod-1"));
    freshService.follow(content("source-a", "vod-2", [
      { id: "ep-1", name: "第一集" },
    ]));
    await freshService.check(async () => content("source-a", "vod-2", [
      { id: "ep-old", name: "第一集" },
      { id: "ep-1", name: "第一集" },
    ]));
    expect(freshService.uiState().items[0]?.updateAvailable).toBe(false);
    await freshService.check(async () => content("source-a", "vod-2", [
      { id: "ep-1", name: "第一集" },
      { id: "ep-2", name: "番外" },
    ]));
    expect(freshService.uiState().items[0]).toMatchObject({
      latestEpisodeName: "番外",
      updateAvailable: true,
    });
  });

  it("isolates source failures and limits concurrent detail checks", async () => {
    const { service } = createService({ maxConcurrentChecks: 2 });
    service.follow(content("source-a", "vod-a", [{ id: "a-1", name: "A" }]));
    service.follow(content("source-b", "vod-b", [{ id: "b-1", name: "B" }]));
    let running = 0;
    let maximum = 0;

    await service.check(async (record) => {
      running += 1;
      maximum = Math.max(maximum, running);
      await Promise.resolve();
      running -= 1;
      if (record.sourceId === "source-a") {
        const error = new Error("source circuit open") as Error & { code: string };
        error.code = "SOURCE_CIRCUIT_OPEN";
        throw error;
      }
      return content(record.sourceId, record.vodId, [{ id: "b-2", name: "B updated" }]);
    });

    const items = service.uiState("source-b").items;
    expect(maximum).toBeLessThanOrEqual(2);
    expect(items.find((item) => item.sourceId === "source-a")).toMatchObject({
      checkError: "SOURCE_CIRCUIT_OPEN",
      status: "error",
    });
    expect(items.find((item) => item.sourceId === "source-b")).toMatchObject({
      latestEpisodeId: "b-2",
      updateAvailable: true,
      status: "updated",
    });
  });

  it("syncs watched episodes from history without deleting history", () => {
    const { service, history } = createService();
    const input = content("source-a", "vod-1", [
      { id: "ep-1", name: "第一集" },
      { id: "ep-2", name: "第二集" },
    ]);
    service.follow(input);
    history.upsert(historyRecord("source-a", "vod-1", "ep-1", 10));

    expect(service.uiState("source-a").items[0]).toMatchObject({
      watchedEpisodeId: "ep-1",
      updateAvailable: true,
    });
    const identity = followIdentity("source-a", "vod-1");
    service.markWatched(identity);
    expect(service.uiState().items[0]?.updateAvailable).toBe(false);
    service.markUnwatched(identity);
    expect(service.uiState().items[0]?.updateAvailable).toBe(true);
    expect(history.get(historyRecord("source-a", "vod-1", "ep-1", 10).identity)).not.toBeNull();
  });

  it("keeps follow state across a database restart and marks unavailable sources", () => {
    const first = createService();
    const record = first.service.follow(content("source-a", "vod-1", [{ id: "ep-1", name: "第一集" }]));
    const directory = directories[directories.length - 1]!;
    const path = join(directory, "qx-yingshi.db");
    const layer = layers.pop();
    layer?.close();

    const reopened = SqliteDataLayer.create(path);
    layers.push(reopened);
    const service = new FollowService({
      db: reopened,
      follow: new FollowRepository(reopened),
      history: new HistoryRepository(reopened),
    });
    expect(service.uiState("source-b").items).toMatchObject([{
      identity: record.identity,
      sourceAvailable: false,
    }]);
  });
});

function createService(options: { maxConcurrentChecks?: number } = {}): {
  service: FollowService;
  history: HistoryRepository;
} {
  const directory = mkdtempSync(join(tmpdir(), "qx-follow-"));
  directories.push(directory);
  const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
  layers.push(layer);
  const history = new HistoryRepository(layer);
  return {
    service: new FollowService({
      db: layer,
      follow: new FollowRepository(layer),
      history,
      ...(options.maxConcurrentChecks === undefined ? {} : { maxConcurrentChecks: options.maxConcurrentChecks }),
    }),
    history,
  };
}

function content(sourceId: string, vodId: string, episodes: readonly { id: string; name: string }[]) {
  return {
    sourceId,
    vodId,
    title: vodId,
    poster: null,
    episodes,
  };
}

function historyRecord(sourceId: string, vodId: string, episodeId: string, position: number): HistoryRecord {
  return {
    identity: `${sourceId}:${vodId}:${episodeId}`,
    sourceId,
    vodId,
    seasonId: null,
    episodeId,
    title: vodId,
    poster: null,
    episode: episodeId === "ep-1" ? 1 : 2,
    episodeName: episodeId,
    playbackLine: null,
    position,
    duration: 100,
    updatedAt: position,
    completed: false,
    sourceDisplayName: "Fixture",
  };
}
