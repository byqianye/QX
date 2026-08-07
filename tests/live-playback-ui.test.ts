import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LiveRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  type DesktopSpiderSessionPort,
  type DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import { createMediaFixtureServer, type MediaFixtureServer } from "../src/electron/media-fixture.js";
import { LivePlaybackService } from "../src/live/live-playback.js";
import { LiveSourceService } from "../src/live/live-service.js";
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("live playback UI API", () => {
  let fixture: MediaFixtureServer;
  let layer: SqliteDataLayer;
  let server: DesktopSpiderUiServer;
  let playback: LivePlaybackService;
  let directory: string;

  beforeEach(async () => {
    fixture = createMediaFixtureServer();
    await fixture.start();
    directory = mkdtempSync(join(tmpdir(), "qx-live-ui-playback-"));
    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    const repository = new LiveRepository(layer);
    const live = new LiveSourceService({ repository });
    playback = new LivePlaybackService({ repository, proxyAllowedOrigins: [fixture.baseUrl] });
    const ui = new DesktopSpiderUiController({ session: new LiveApiSession() });
    server = new DesktopSpiderUiServer({
      ui,
      siteKey: "fixture",
      ext: "fixture",
      live,
      livePlayback: playback,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    layer.close();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("exposes groups, plays protected HLS through LocalProxy, switches lines, and stops on source disable", async () => {
    const preview = await post(server.url, "/api/live/source/preview", {
      name: "G57 API Fixture",
      type: "m3u-url",
      location: fixture.livePlaybackUrl,
    });
    const previewId = preview.live.preview.id as string;
    const applied = await post(server.url, "/api/live/source/apply", { previewId });
    const sourceId = applied.live.sources.find((source: any) => source.name === "G57 API Fixture").id as string;
    const channels = applied.live.catalog.channels as Array<{ id: string; name: string; streams: Array<{ id: string }> }>;
    expect(applied.live.catalog.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "全部频道" }),
      expect.objectContaining({ name: "Fixtures" }),
    ]));
    const channelB = channels.find((channel) => channel.name === "Fixture Channel B");
    expect(channelB?.streams).toHaveLength(1);

    const played = await post(server.url, "/api/live/play", { channelId: channelB?.id });
    expect(played.live.session).toMatchObject({ channelId: channelB?.id, state: "loading", backend: "hls-js" });
    const proxyUrl = played.live.player.source.url as string;
    expect(proxyUrl).toContain("__qx_playback");
    expect((await fetch(proxyUrl)).status).toBe(200);

    const channelE = channels.find((channel) => channel.name === "Fixture Channel E");
    expect(channelE?.streams).toHaveLength(2);
    const selectedE = await post(server.url, "/api/live/play", { channelId: channelE?.id });
    expect(selectedE.live.session.channelId).toBe(channelE?.id);
    const switched = await post(server.url, "/api/live/line", { streamId: channelE?.streams[1]?.id });
    expect(switched.live.session).toMatchObject({ channelId: channelE?.id, streamId: channelE?.streams[1]?.id });

    const disabled = await post(server.url, "/api/live/source/toggle", { sourceId, enabled: false });
    expect(disabled.live.session.state).toBe("stopped");
    expect(disabled.live.catalog.channels).toHaveLength(0);
    expect(JSON.stringify(disabled.live.catalog)).not.toContain("__qx_playback");
  });

  it("exposes finite failover mode and cancellation actions through the UI API", async () => {
    const preview = await post(server.url, "/api/live/source/preview", {
      name: "G61 API Fixture",
      type: "m3u-url",
      location: fixture.liveFailoverUrl,
    });
    const applied = await post(server.url, "/api/live/source/apply", { previewId: preview.live.preview.id });
    const channel = applied.live.catalog.channels.find((candidate: any) => candidate.sourceName === "G61 API Fixture");
    const firstLine = channel?.streams[0];
    const secondLine = channel?.streams[1];
    expect(firstLine).toBeTruthy();
    expect(secondLine).toBeTruthy();

    const ask = await post(server.url, "/api/live/failover/mode", { mode: "ask" });
    expect(ask.live.failover.mode).toBe("ask");
    const started = await post(server.url, "/api/live/play", { channelId: channel.id, streamId: firstLine.id });
    const firstFrame = await post(server.url, "/api/live/sync", {
      sessionId: started.live.session.sessionId,
      event: { type: "first-frame" },
      status: "playing",
    });
    await post(server.url, "/api/live/sync", {
      sessionId: firstFrame.live.session.sessionId,
      event: { type: "segment-failure", reason: "one" },
    });
    const prompt = await post(server.url, "/api/live/sync", {
      sessionId: firstFrame.live.session.sessionId,
      event: { type: "segment-failure", reason: "two" },
    });
    expect(prompt.live.failover.status).toBe("prompt");

    const approved = await post(server.url, "/api/live/failover/approve", {});
    expect(approved.live.session.streamId).toBe(secondLine.id);
    const cancelled = await post(server.url, "/api/live/failover/cancel", {});
    expect(cancelled.live.session.streamId).toBe(firstLine.id);
    expect(cancelled.live.failover.status).toBe("cancelled");
    const stayed = await post(server.url, "/api/live/failover/stay", {});
    expect(stayed.live.failover.status).toBe("stopped");
    const returned = await post(server.url, "/api/live/failover/return", {});
    expect(returned.live.session.streamId).toBe(firstLine.id);
    const off = await post(server.url, "/api/live/failover/mode", { mode: "off" });
    expect(off.live.failover.mode).toBe("off");
    expect(off.live.failover.status).toBe("disabled");
  });
});

async function post(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(`${pathname}: ${JSON.stringify(value)}`);
  return value;
}

class LiveApiSession implements DesktopSpiderSessionPort {
  public readonly view: DesktopSpiderView = {
    source: "fixture:live-api",
    api: "csp_LiveFixture",
    status: "confirmation_required",
    warning: "Confirm this import before running Spider code",
    error: null,
    sidecarRunning: false,
    playback: { available: false, label: "Unavailable", message: "No playback" },
  };

  public confirmImport(): void { this.view.status = "idle"; this.view.warning = null; }
  public async open(): Promise<SpiderResponse> { this.view.status = "ready"; this.view.sidecarRunning = true; return { id: "live-api", ok: true, result: {} }; }
  public async homeContent(): Promise<SpiderResponse> { return { id: "live-api", ok: true, result: { list: [] } }; }
  public async categoryContent(): Promise<SpiderResponse> { return { id: "live-api", ok: true, result: { list: [] } }; }
  public async searchContent(): Promise<SpiderResponse> { return { id: "live-api", ok: true, result: { list: [] } }; }
  public async detailContent(): Promise<SpiderResponse> { return { id: "live-api", ok: true, result: { list: [] } }; }
  public async playerContent(): Promise<SpiderResponse> { return { id: "live-api", ok: false, error: { code: "PLAYBACK_UNAVAILABLE", message: "No playback" } }; }
  public async destroy(): Promise<void> { this.view.status = "destroyed"; this.view.sidecarRunning = false; }
}
