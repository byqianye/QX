import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { HealthRepository, LiveRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { PlaybackProxyServer } from "../src/desktop/playback-proxy.js";
import { createMediaFixtureServer, type MediaFixtureServer } from "../src/electron/media-fixture.js";
import {
  LivePlaybackError,
  LivePlaybackService,
  type LivePlaybackProxyPort,
} from "../src/live/live-playback.js";
import type { LiveChannelWithStreams, LiveSourceRecord } from "../src/live/live-types.js";
import { EMPTY_LIVE_UI_STATE } from "../src/live/live-types.js";

const layers: SqliteDataLayer[] = [];
const directories: string[] = [];

describe("live playback session", () => {
  let fixture: MediaFixtureServer;

  beforeAll(async () => {
    fixture = createMediaFixtureServer();
    await fixture.start();
  });

  afterAll(async () => {
    await fixture.close();
  });

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects HLS, proxies headered streams, switches lines, and persists safe recent state", async () => {
    const { repository, layer } = createRepository();
    const source = seedFixture(repository, fixture.baseUrl);
    const proxy = new PlaybackProxyServer({ allowedOrigins: [fixture.baseUrl] });
    const service = new LivePlaybackService({ repository, proxy, now: () => 1_000 });

    const channelA = await service.selectChannel("channel-a");
    expect(channelA.state).toBe("loading");
    expect(service.proxySessionCount).toBe(0);
    const directUrl = service.uiState(EMPTY_LIVE_UI_STATE).player?.source?.url;
    expect(directUrl).toBe(`${fixture.baseUrl}/live/channel-a.m3u8`);
    expect((await fetch(directUrl!)).status).toBe(200);

    const channelB = await service.selectChannel("channel-b");
    expect(channelB.backend).toBe("hls-js");
    expect(service.proxySessionCount).toBe(1);
    const proxyUrl = service.uiState(EMPTY_LIVE_UI_STATE).player?.source?.url;
    expect(proxyUrl).toContain("__qx_playback");
    const protectedPlaylist = await fetch(proxyUrl!);
    expect(protectedPlaylist.status).toBe(200);
    expect(await protectedPlaylist.text()).toContain("__qx_playback");

    const channelE = await service.selectChannel("channel-e", "channel-e-line-2");
    expect(channelE.streamId).toBe("channel-e-line-2");
    expect(service.uiState(EMPTY_LIVE_UI_STATE).catalog.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: "channel-e", sourceId: source.id, lastStreamId: "channel-e-line-2" }),
    ]));
    expect(repository.listRecent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: "channel-a" }),
      expect.objectContaining({ channelId: "channel-b" }),
      expect.objectContaining({ channelId: "channel-e", lastStreamId: "channel-e-line-2" }),
    ]));

    await service.stop();
    expect(service.proxySessionCount).toBe(0);
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.state).toBe("stopped");
    await service.close();
    expect(layer.schemaVersion).toBe(8);
  });

  it("cancels stale channel work and never lets a late response replace the newest generation", async () => {
    const { repository } = createRepository();
    seedFixture(repository, "http://127.0.0.1:43199", true);
    const proxy = new DelayedProxy();
    const service = new LivePlaybackService({ repository, proxy, now: () => 2_000 });

    const slow = service.selectChannel("channel-a");
    await Promise.resolve();
    const fast = service.selectChannel("channel-b");
    await expect(slow).rejects.toMatchObject({ code: "LIVE_SWITCH_CANCELLED" });
    await expect(fast).resolves.toMatchObject({ channelId: "channel-b" });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session).toMatchObject({
      channelId: "channel-b",
      generation: 2,
    });
    expect(proxy.closedTokens).toContain("slow");
    await service.close();
  });

  it("maps disabled, missing, protocol, startup timeout, and fatal stream states to stable errors", async () => {
    const { repository } = createRepository();
    seedFixture(repository, "http://127.0.0.1:43200");
    const service = new LivePlaybackService({ repository, proxy: new DelayedProxy() });

    repository.upsertSource({ ...repository.getSource("fixture-source")!, enabled: false });
    await expect(service.selectChannel("channel-a")).rejects.toMatchObject({ code: "LIVE_SOURCE_UNAVAILABLE" });
    repository.upsertSource({ ...repository.getSource("fixture-source")!, enabled: true });
    await expect(service.selectChannel("missing")).rejects.toMatchObject({ code: "LIVE_CHANNEL_UNAVAILABLE" });

    const session = await service.selectChannel("channel-a");
    const playing = service.sync(session.sessionId, {
      status: "playing",
      event: { type: "first-frame" },
    });
    expect(playing).toMatchObject({ state: "playing" });
    service.sync(session.sessionId, {
      status: "error",
      error: { code: "PLAYBACK_STARTUP_TIMEOUT", message: "fixture timeout" },
    });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session).toMatchObject({
      state: "error",
      error: { code: "LIVE_STREAM_TIMEOUT" },
    });
    await service.close();
  });

  it("switches after repeated segment failures, but not after one segment failure", async () => {
    const { repository } = createRepository();
    seedFixture(repository, fixture.baseUrl);
    const service = new LivePlaybackService({ repository, failoverMode: "auto", now: () => 5_000 });
    const started = await service.selectChannel("channel-e", "channel-e-line-1");
    service.sync(started.sessionId, { status: "playing", event: { type: "first-frame", at: 5_100 } });
    service.sync(started.sessionId, { event: { type: "segment-failure", reason: "one" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-1");
    await service.syncAndMaybeFailover(started.sessionId, { event: { type: "segment-failure", reason: "two" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session).toMatchObject({ streamId: "channel-e-line-2", state: "loading" });
    const replacement = service.uiState(EMPTY_LIVE_UI_STATE).session!;
    service.sync(replacement.sessionId, { status: "playing", event: { type: "first-frame" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).failover.status).toBe("recovered");
    await service.close();
  });

  it("switches after continuous long buffering, but not after a short buffer", async () => {
    vi.useFakeTimers();
    try {
      const { repository } = createRepository();
      seedFixture(repository, fixture.baseUrl);
      const service = new LivePlaybackService({ repository, failoverMode: "auto", now: () => 5_000 });
      const started = await service.selectChannel("channel-e", "channel-e-line-1");
      service.sync(started.sessionId, { status: "playing", event: { type: "first-frame" } });
      service.sync(started.sessionId, { status: "playing", event: { type: "buffer-start" } });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-1");
      service.sync(started.sessionId, { event: { type: "buffer-end", at: 12_000 } });
      await vi.advanceTimersByTimeAsync(1);
      expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-1");

      service.sync(started.sessionId, { status: "playing", event: { type: "buffer-start" } });
      await vi.advanceTimersByTimeAsync(8_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-2");
      await service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches after repeated playlist failures and records backend disconnect", async () => {
    const { repository } = createRepository();
    seedFixture(repository, fixture.baseUrl);
    const service = new LivePlaybackService({ repository, failoverMode: "auto", now: () => 5_000 });
    const started = await service.selectChannel("channel-e", "channel-e-line-1");
    service.sync(started.sessionId, { status: "playing", event: { type: "first-frame" } });
    service.sync(started.sessionId, { event: { type: "playlist-refresh-failure", reason: "first refresh" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-1");
    await service.syncAndMaybeFailover(started.sessionId, { event: { type: "playlist-refresh-failure", reason: "second refresh" } });
    const replacement = service.uiState(EMPTY_LIVE_UI_STATE).session!;
    expect(replacement.streamId).toBe("channel-e-line-2");
    service.sync(replacement.sessionId, { status: "playing", event: { type: "first-frame" } });
    await service.syncAndMaybeFailover(replacement.sessionId, { event: { type: "disconnect", reason: "fixture backend stopped" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).failover).toMatchObject({
      status: "stopped",
      trigger: "backend-crash",
    });
    await service.close();
  });

  it("prompts in Ask mode and supports cancel/stay without looping", async () => {
    const { repository } = createRepository();
    seedFixture(repository, fixture.baseUrl);
    const service = new LivePlaybackService({ repository, failoverMode: "ask", now: () => 6_000 });
    const started = await service.selectChannel("channel-e", "channel-e-line-1");
    service.sync(started.sessionId, { status: "playing", event: { type: "first-frame" } });
    service.sync(started.sessionId, { event: { type: "segment-failure", reason: "one" } });
    await service.syncAndMaybeFailover(started.sessionId, { event: { type: "segment-failure", reason: "two" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).failover).toMatchObject({ status: "prompt", attempts: 0 });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).failover.next?.streamId).toBe("channel-e-line-2");
    service.stayOnCurrentLine();
    expect(service.uiState(EMPTY_LIVE_UI_STATE).failover.status).toBe("stopped");
    await service.close();
  });

  it("does not immediately return to a manually rejected line, then retries it after override expiry", async () => {
    let now = 10_000;
    const { repository } = createRepository();
    seedFixture(repository, fixture.baseUrl);
    const service = new LivePlaybackService({
      repository,
      failoverMode: "auto",
      manualOverrideMs: 1_000,
      now: () => now,
    });
    const first = await service.selectChannel("channel-e", "channel-e-line-1");
    service.sync(first.sessionId, { status: "playing", event: { type: "first-frame", at: now } });

    now = 10_100;
    await service.selectLine("channel-e-line-2");
    const replacement = service.uiState(EMPTY_LIVE_UI_STATE).session!;
    service.sync(replacement.sessionId, { status: "playing", event: { type: "first-frame", at: now } });
    service.sync(replacement.sessionId, { event: { type: "segment-failure", reason: "one" } });
    await service.syncAndMaybeFailover(replacement.sessionId, { event: { type: "segment-failure", reason: "two" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-2");
    expect(service.uiState(EMPTY_LIVE_UI_STATE).failover.status).toBe("stopped");

    now = 11_200;
    service.sync(replacement.sessionId, { event: { type: "segment-failure", reason: "three" } });
    await service.syncAndMaybeFailover(replacement.sessionId, { event: { type: "segment-failure", reason: "four" } });
    expect(service.uiState(EMPTY_LIVE_UI_STATE).session?.streamId).toBe("channel-e-line-1");
    await service.close();
  });

  it("persists a debounced health summary and hydrates it after restart", async () => {
    const { repository, layer } = createRepository();
    seedFixture(repository, fixture.baseUrl);
    const health = new HealthRepository(layer);
    const first = new LivePlaybackService({ repository, healthStore: health, now: () => 7_000 });
    const session = await first.selectChannel("channel-a");
    first.sync(session.sessionId, { status: "playing", event: { type: "first-frame", at: 7_120 } });
    await first.close();

    const restarted = new LivePlaybackService({ repository, healthStore: health, now: () => 8_000 });
    const hydrated = await restarted.selectChannel("channel-a");
    expect(restarted.uiState(EMPTY_LIVE_UI_STATE).health).toMatchObject({
      streamId: "channel-a",
      firstFrameMs: { value: 120 },
      score: expect.any(Number),
    });
    await restarted.close();
    expect(hydrated.streamId).toBe("channel-a");
  });
});

function createRepository(): { repository: LiveRepository; layer: SqliteDataLayer } {
  const directory = mkdtempSync(join(tmpdir(), "qx-live-playback-"));
  directories.push(directory);
  const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
  layers.push(layer);
  return { repository: new LiveRepository(layer), layer };
}

function seedFixture(repository: LiveRepository, baseUrl: string, forceProxyForA = false): LiveSourceRecord {
  const source: LiveSourceRecord = {
    id: "fixture-source",
    name: "G57 Fixture",
    type: "fixture",
    location: "fixture:m3u:g57",
    enabled: true,
    refreshMode: "manual",
    lastUpdatedAt: 1,
    lastSuccessAt: 1,
    lastError: null,
    contentHash: null,
    etag: null,
    lastModified: null,
  };
  const channel = (id: string, name: string, url: string, headers: Record<string, string> = {}, group = "Fixtures"): LiveChannelWithStreams => ({
    id,
    sourceId: source.id,
    externalId: null,
    name,
    normalizedName: name.toLocaleLowerCase(),
    group,
    logo: null,
    tvgId: null,
    tvgName: null,
    tvgLogo: null,
    tvgChno: null,
    catchup: null,
    attributes: {},
    enabled: true,
    sortOrder: 0,
    streams: [{ id, channelId: id, url, headers, priority: 0, label: "线路 1", protocol: "HLS" }],
  });
  const channelE: LiveChannelWithStreams = {
    ...channel("channel-e", "Fixture Channel E", `${baseUrl}/live/channel-e-line1.m3u8`),
    streams: [
      { id: "channel-e-line-1", channelId: "channel-e", url: `${baseUrl}/live/channel-e-line1.m3u8`, headers: {}, priority: 0, label: "线路 1", protocol: "HLS" },
      { id: "channel-e-line-2", channelId: "channel-e", url: `${baseUrl}/live/channel-e-line2.m3u8`, headers: {}, priority: 1, label: "线路 2", protocol: "HLS" },
    ],
  };
  repository.saveSourceContent(source, [
    channel("channel-a", "Fixture Channel A", `${baseUrl}/live/channel-a.m3u8`, forceProxyForA ? { Referer: "https://source.example.invalid/" } : {}),
    channel("channel-b", "Fixture Channel B", `${baseUrl}/live/channel-b.m3u8`, {
      Referer: "https://source.example.invalid/",
      "User-Agent": "G22-fixture",
    }),
    channelE,
  ]);
  return source;
}

class DelayedProxy implements LivePlaybackProxyPort {
  private readonly active = new Set<string>();
  public readonly closedTokens: string[] = [];

  public get activeSessionCount(): number {
    return this.active.size;
  }

  public async createSession(source: { url: string }): Promise<{ url: string; token: string; expiresAt: number; close(): Promise<void> }> {
    const token = source.url.includes("channel-a") ? "slow" : "fast";
    if (token === "slow") await new Promise((resolve) => setTimeout(resolve, 30));
    this.active.add(token);
    return {
      url: `http://127.0.0.1/proxy/${token}`,
      token,
      expiresAt: Date.now() + 10_000,
      close: async () => {
        this.active.delete(token);
        this.closedTokens.push(token);
      },
    };
  }

  public async close(): Promise<void> {
    this.active.clear();
  }
}
