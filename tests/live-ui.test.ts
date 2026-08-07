import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { LiveRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  type DesktopSpiderSessionPort,
  type DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import { LiveSourceService } from "../src/live/live-service.js";
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("live source UI API", () => {
  const servers: DesktopSpiderUiServer[] = [];
  const layers: SqliteDataLayer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps preview, apply, toggle, remove, and safe state in the typed API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-live-ui-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    const live = new LiveSourceService({ repository: new LiveRepository(layer), now: () => 300 });
    const ui = new DesktopSpiderUiController({ session: new LiveUiSession() });
    const server = new DesktopSpiderUiServer({ ui, siteKey: "fixture", ext: "fixture", live });
    servers.push(server);
    await server.start();

    const previewResponse = await post(server.url, "/api/live/source/preview", {
      name: "UI 测试源",
      type: "fixture",
      format: "m3u",
      content: "#EXTM3U\n#EXTINF:-1,UI 频道\nhttps://media.example/ui.m3u8?token=not-persisted\n#EXTINF:-1,安全频道\nhttps://media.example/safe.m3u8\n",
    });
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json() as Record<string, any>;
    expect(previewBody.live.preview.stats).toMatchObject({ channelCount: 1, invalidCount: 1 });
    expect(JSON.stringify(previewBody.live)).not.toContain("not-persisted");
    expect(previewBody.live.preview.channelNames).toEqual(["安全频道"]);

    const previewId = previewBody.live.preview.id as string;
    const applyResponse = await post(server.url, "/api/live/source/apply", { previewId });
    const appliedBody = await applyResponse.json() as Record<string, any>;
    expect(appliedBody.live.sources).toHaveLength(1);
    const sourceId = appliedBody.live.sources[0].id as string;
    expect(appliedBody.state.live.sources[0]).toMatchObject({ name: "UI 测试源", channelCount: 1 });

    const toggleResponse = await post(server.url, "/api/live/source/toggle", { sourceId, enabled: false });
    expect((await toggleResponse.json() as Record<string, any>).live.sources[0].enabled).toBe(false);
    const removeResponse = await post(server.url, "/api/live/source/remove", { sourceId });
    expect((await removeResponse.json() as Record<string, any>).live.sources).toHaveLength(0);
  });
});

async function post(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

class LiveUiSession implements DesktopSpiderSessionPort {
  public readonly view: DesktopSpiderView = {
    source: "inline:live-fixture",
    api: "csp_LiveFixture",
    status: "confirmation_required",
    warning: "Confirm this import before running Spider code",
    error: null,
    sidecarRunning: false,
    playback: { available: false, label: "Unavailable", message: "No playback" },
  };

  public confirmImport(): void {
    this.view.status = "idle";
    this.view.warning = null;
  }

  public async open(): Promise<SpiderResponse> {
    this.view.status = "ready";
    this.view.sidecarRunning = true;
    return { id: "live-fixture", ok: true, result: { initialized: true } };
  }

  public async homeContent(): Promise<SpiderResponse> {
    return { id: "live-fixture", ok: true, result: { list: [] } };
  }

  public async categoryContent(): Promise<SpiderResponse> {
    return { id: "live-fixture", ok: true, result: { list: [] } };
  }

  public async searchContent(): Promise<SpiderResponse> {
    return { id: "live-fixture", ok: true, result: { list: [] } };
  }

  public async detailContent(): Promise<SpiderResponse> {
    return { id: "live-fixture", ok: true, result: { list: [] } };
  }

  public async playerContent(): Promise<SpiderResponse> {
    return { id: "live-fixture", ok: false, error: { code: "PLAYBACK_UNAVAILABLE", message: "No playback" } };
  }

  public async destroy(): Promise<void> {
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}
