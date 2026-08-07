import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LiveRepository } from "../src/data/repositories.js";
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
    expect(layer.schemaVersion).toBe(5);
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
