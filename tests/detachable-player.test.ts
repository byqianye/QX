import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  type DesktopSpiderSessionPort,
  type DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("detachable player session", () => {
  const servers: DesktopSpiderUiServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("keeps one playback session while switching hosts and syncing media state", async () => {
    const fixture = new DetachableFixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });

    ui.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.detail("fixture:movie-1");
    await ui.playEpisode(0, 1);

    const before = ui.state;
    const sessionId = before.playbackSession?.id;
    const sourceUrl = before.player.source?.url;
    expect(sessionId).toBeTruthy();
    expect(before.playbackSession).toMatchObject({
      host: "embedded",
      lineIndex: 0,
      episodeIndex: 1,
      lineName: "主线",
      episodeName: "第二集",
    });

    const synced = ui.syncPlayerState({
      status: "paused",
      currentTime: 42,
      duration: 90,
      volume: 0.35,
      muted: true,
    });
    expect(synced.player).toMatchObject({
      status: "paused",
      currentTime: 42,
      duration: 90,
      volume: 0.35,
      muted: true,
    });

    const detached = ui.detachPlayer();
    expect(detached).toMatchObject({
      playerHost: "detached",
      playbackSession: { id: sessionId, host: "detached" },
      player: { source: { url: sourceUrl }, currentTime: 42, volume: 0.35, muted: true },
    });

    const attached = ui.attachPlayer();
    expect(attached).toMatchObject({
      playerHost: "embedded",
      playbackSession: { id: sessionId, host: "embedded" },
      player: { source: { url: sourceUrl }, currentTime: 42, volume: 0.35, muted: true },
    });
    expect(fixture.calls.filter((call) => call.startsWith("player:")).length).toBe(1);

    await ui.close();
  });

  it("exposes detach, attach, sync and stop through one server lifecycle", async () => {
    const fixture = new DetachableFixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });
    let openCalls = 0;
    let attachCalls = 0;
    let stopCalls = 0;
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "playable",
      ext: "fixture-endpoint",
      onPlayerOpen: () => { openCalls += 1; },
      onPlayerAttach: () => { attachCalls += 1; },
      onPlayerStop: () => { stopCalls += 1; },
    });
    servers.push(server);
    await server.start();

    await post(server.url, "/api/import/confirm");
    await post(server.url, "/api/open");
    await post(server.url, "/api/detail", { vodId: "fixture:movie-1" });
    const played = await post(server.url, "/api/player", { lineIndex: 0, episodeIndex: 1 });
    const sessionId = played.state.playbackSession?.id;

    const detached = await post(server.url, "/api/player/detach");
    expect(detached.state).toMatchObject({
      playerHost: "detached",
      playbackSession: { id: sessionId, host: "detached" },
    });
    expect(openCalls).toBe(0);

    const opened = await post(server.url, "/api/player/open");
    expect(opened.state).toMatchObject({
      playerHost: "detached",
      playbackSession: { id: sessionId, host: "detached" },
    });
    expect(openCalls).toBe(1);

    const synced = await post(server.url, "/api/player/sync", {
      status: "paused",
      currentTime: 12,
      duration: 60,
      volume: 0.2,
      muted: false,
    });
    expect(synced.state.player).toMatchObject({ status: "paused", currentTime: 12, volume: 0.2 });

    const mediaError = await post(server.url, "/api/player/sync", {
      status: "error",
      error: { code: "HLS_ERROR", message: "HLS 播放失败" },
    });
    expect(mediaError.state).toMatchObject({
      error: { code: "HLS_ERROR", message: "HLS 播放失败" },
      player: { status: "error", error: { code: "HLS_ERROR" } },
    });

    const attached = await post(server.url, "/api/player/attach");
    expect(attached.state).toMatchObject({ playerHost: "embedded", playbackSession: { id: sessionId, host: "embedded" } });
    expect(attachCalls).toBe(1);

    const stopped = await post(server.url, "/api/player/stop");
    expect(stopped.state).toMatchObject({ playerHost: "embedded", playbackSession: null, player: { source: null } });
    expect(stopCalls).toBe(1);
    expect(fixture.calls.filter((call) => call.startsWith("player:")).length).toBe(1);
  });
});

class DetachableFixtureSession implements DesktopSpiderSessionPort {
  public readonly calls: string[] = [];
  public view: DesktopSpiderView = {
    source: "inline:detachable-fixture",
    api: "csp_PlayableFixture",
    status: "confirmation_required",
    warning: "Confirm this import",
    error: null,
    sidecarRunning: false,
    playback: {
      available: false,
      label: "Playable fixture",
      message: "Resolve a playback source",
    },
  };

  public confirmImport(): void {
    this.view.status = "idle";
    this.view.warning = null;
  }

  public async open(siteKey: string, ext: string): Promise<SpiderResponse> {
    this.calls.push(`open:${siteKey}:${ext}`);
    this.view.status = "ready";
    this.view.sidecarRunning = true;
    return ok({ initialized: true });
  }

  public async homeContent(): Promise<SpiderResponse> { return ok({ list: [] }); }
  public async categoryContent(): Promise<SpiderResponse> { return ok({ list: [] }); }
  public async searchContent(): Promise<SpiderResponse> { return ok({ list: [] }); }

  public async detailContent(ids: string[]): Promise<SpiderResponse> {
    this.calls.push(`detail:${ids.join(",")}`);
    return ok({
      list: [{
        vod_id: ids[0],
        vod_name: "Detachable fixture",
        vod_play_from: "主线",
        vod_play_url: "第一集$direct-hls#第二集$second-hls",
      }],
    });
  }

  public async playerContent(flag: string, id: string): Promise<SpiderResponse> {
    this.calls.push(`player:${flag}:${id}`);
    this.view.playback = {
      available: true,
      label: "Playable fixture",
      message: "Direct fixture media",
      parse: 0,
      url: "http://127.0.0.1:43123/media/fixture.m3u8",
      headers: {},
    };
    return ok({ parse: 0, url: this.view.playback.url, header: {} });
  }

  public async destroy(): Promise<void> {
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}

async function post(baseUrl: string, path: string, body: Record<string, unknown> = {}): Promise<{ state: any }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return await response.json() as { state: any };
}

function ok(result: unknown): SpiderResponse {
  return { id: "detachable-fixture", ok: true, result };
}
