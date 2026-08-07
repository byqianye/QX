import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { HistoryRepository, PlaybackProgressRepository, SettingsRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  HISTORY_COMPLETION_RATIO,
  HistoryProgressService,
  createHistoryContext,
  historyIdentity,
  isHistoryCompleted,
} from "../src/history/history-progress.js";
import type { ProgressWriterScheduler } from "../src/data/progress-writer.js";

describe("G51 history and playback progress", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses source + vod + episode identity, so equal titles do not overwrite", () => {
    const service = openService();
    const first = context("https://source-a.example/config.json", "episode-1", "same title");
    const second = context("https://source-b.example/config.json", "episode-1", "same title");

    service.begin(first);
    service.sync({ status: "playing", currentTime: 20, duration: 100 });
    service.stop();
    service.begin(second);
    service.sync({ status: "playing", currentTime: 40, duration: 100 });
    service.stop();

    const items = service.uiState().items;
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.sourceId)).size).toBe(2);
    expect(items.map((item) => item.position).sort()).toEqual([20, 40]);
  });

  it("creates after first-frame, debounces updates, and flushes pause/stop/close", () => {
    const scheduler = new FakeScheduler();
    const service = openService(scheduler);
    const item = context("inline:fixture", "episode-1", "Fixture");

    service.begin(item);
    expect(service.uiState().items).toHaveLength(0);
    service.sync({ event: { type: "first-frame" }, currentTime: 12, duration: 100 });
    expect(service.uiState().items[0]).toMatchObject({ position: 0, duration: 0 });

    service.sync({ status: "playing", currentTime: 18, duration: 100 });
    expect(service.uiState().items[0]).toMatchObject({ position: 0, duration: 0 });
    scheduler.run(10);
    expect(service.uiState().items[0]).toMatchObject({ position: 18, duration: 100 });

    service.sync({ status: "paused", currentTime: 24, duration: 100 });
    expect(service.uiState().items[0]).toMatchObject({ position: 24 });

    service.sync({ status: "playing", currentTime: 31, duration: 100 });
    service.stop();
    expect(service.uiState().items[0]).toMatchObject({ position: 31 });

    const next = context("inline:fixture", "episode-2", "Fixture");
    service.begin(next);
    service.sync({ status: "playing", currentTime: 8, duration: 100 });
    service.appClose();
    expect(service.uiState().items.find((entry) => entry.episodeId === next.identity.episodeId)).toMatchObject({ position: 8 });
  });

  it("applies an explicit completion rule and keeps replay policy user-controlled", () => {
    expect(HISTORY_COMPLETION_RATIO).toBe(0.9);
    expect(isHistoryCompleted(90, 100)).toBe(true);
    expect(isHistoryCompleted(20, 100)).toBe(false);
    expect(isHistoryCompleted(220, 300)).toBe(true);
    expect(isHistoryCompleted(20, 100, true)).toBe(true);
    expect(isHistoryCompleted(10, 50)).toBe(false);
  });

  it("matches resume across lines by episode identity, never by line index", () => {
    const service = openService();
    const item = context("inline:fixture", "episode-stable", "Fixture");
    service.begin(item);
    service.sync({ status: "playing", currentTime: 52, duration: 200 });
    service.stop();

    const resume = service.findResumeForDetail("inline:fixture", "vod-1", [
      { lineIndex: 8, episodeIndex: 3, lineName: "备用线路", episodeName: "第三集", episodeId: "episode-stable" },
    ]);
    expect(resume).toMatchObject({ position: 52, lineIndex: 8, episodeIndex: 3, lineName: "备用线路" });
  });

  it("prefers the stored playback line when the same episode is listed twice", () => {
    const service = openService();
    const item = createHistoryContext({
      source: "inline:fixture",
      vodId: "vod-1",
      episodeId: "episode-stable",
      title: "Fixture",
      playbackLine: "主线",
    });
    if (!item) throw new Error("Expected history context");
    service.begin(item);
    service.sync({ status: "playing", currentTime: 52, duration: 200 });
    service.stop();

    const resume = service.findResumeForDetail("inline:fixture", "vod-1", [
      { lineIndex: 8, episodeIndex: 3, lineName: "备用线路", episodeName: "第三集", episodeId: "episode-stable" },
      { lineIndex: 2, episodeIndex: 3, lineName: "主线", episodeName: "第三集", episodeId: "episode-stable" },
    ]);
    expect(resume).toMatchObject({ lineIndex: 2, lineName: "主线" });
  });

  it("pauses new writes, can delete one progress, and clears history transactionally", () => {
    const service = openService();
    const item = context("inline:fixture", "episode-1", "Fixture");
    service.begin(item);
    service.sync({ status: "playing", currentTime: 20, duration: 100 });
    service.stop();

    service.setPaused(true);
    service.begin(context("inline:fixture", "episode-2", "Fixture"));
    service.sync({ status: "playing", currentTime: 30, duration: 100 });
    service.stop();
    expect(service.uiState().items).toHaveLength(1);

    service.setPaused(false);
    service.deleteProgress(historyIdentity(item.identity));
    expect(service.uiState().items[0]).toMatchObject({ position: 0, completed: false });
    service.clear();
    expect(service.uiState().items).toEqual([]);
  });

  it("deletes selected history and progress rows in one transaction", () => {
    const service = openService();
    const first = context("inline:fixture", "episode-1", "Fixture");
    const second = context("inline:fixture", "episode-2", "Fixture");
    service.begin(first);
    service.sync({ status: "playing", currentTime: 20, duration: 100 });
    service.stop();
    service.begin(second);
    service.sync({ status: "playing", currentTime: 30, duration: 100 });
    service.stop();

    service.deleteMany([historyIdentity(first.identity), historyIdentity(second.identity)]);

    expect(service.uiState().items).toEqual([]);
  });

  it("does not persist temporary playback URLs, credentials, or poster URLs", () => {
    const { service, layer } = openServiceWithLayer();
    const item = createHistoryContext({
      source: "https://source.example/config.json?token=source-secret",
      vodId: "vod-1",
      episodeId: "https://media.example/video.m3u8?token=media-secret",
      title: "Safe title",
      poster: "https://image.example/poster.jpg?token=poster-secret",
    });
    if (!item) throw new Error("Expected history context");
    service.begin(item);
    service.sync({ status: "playing", currentTime: 4, duration: 100 });
    service.stop();

    const text = layer.prepare("SELECT * FROM history").all().map((row) => JSON.stringify(row)).join("\n");
    expect(text).not.toContain("source-secret");
    expect(text).not.toContain("media-secret");
    expect(text).not.toContain("poster-secret");
    expect(text).not.toContain("https://media.example/video.m3u8");
    expect(text).not.toContain("https://source.example/config.json");
    expect(layer.prepare("SELECT poster FROM history").get()).toMatchObject({ poster: null });
  });

  it("redacts URL-like and credential-like display labels", () => {
    const { service, layer } = openServiceWithLayer();
    const item = createHistoryContext({
      source: "inline:fixture",
      vodId: "vod-1",
      episodeId: "episode-1",
      title: "https://media.example/title.m3u8?token=title-secret",
      episodeName: "Authorization: Bearer episode-secret",
      playbackLine: "https://source.example/line?cookie=line-secret",
    });
    if (!item) throw new Error("Expected history context");
    service.begin(item);
    service.sync({ status: "playing", currentTime: 4, duration: 100 });
    service.stop();

    const row = layer.prepare("SELECT title, episode_name, playback_line FROM history").get() as Record<string, unknown>;
    expect(row.title).toBe("vod-1");
    expect(row.episode_name).toBeNull();
    expect(row.playback_line).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/https?:\/\/|token|cookie|authorization|bearer/i);
  });

  function openService(scheduler?: FakeScheduler): HistoryProgressService {
    return openServiceWithLayer(scheduler).service;
  }

  function openServiceWithLayer(scheduler?: FakeScheduler): { service: HistoryProgressService; layer: SqliteDataLayer } {
    const directory = mkdtempSync(join(tmpdir(), "qx-history-progress-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    const service = new HistoryProgressService({
      db: layer,
      history: new HistoryRepository(layer),
      progress: new PlaybackProgressRepository(layer),
      settings: new SettingsRepository(layer),
      ...(scheduler ? { writerOptions: { debounceMs: 10, intervalMs: 50, scheduler } } : {}),
    });
    return { service, layer };
  }

  function context(source: string, episodeId: string, title: string) {
    const value = createHistoryContext({ source, vodId: "vod-1", episodeId, title });
    if (!value) throw new Error("Expected history context");
    return value;
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
