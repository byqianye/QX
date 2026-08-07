import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EpgRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  type DesktopSpiderSessionPort,
  type DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import { EpgService } from "../src/epg/epg-service.js";
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("EPG UI API", () => {
  let directory: string;
  let layer: SqliteDataLayer;
  let server: DesktopSpiderUiServer;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "qx-epg-ui-"));
    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    const epg = new EpgService({ repository: new EpgRepository(layer), now: () => Date.UTC(2026, 7, 7, 12) });
    server = new DesktopSpiderUiServer({
      ui: new DesktopSpiderUiController({ session: new EpgApiSession() }),
      siteKey: "fixture",
      ext: "fixture",
      epg,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    layer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("supports preview, apply, refresh state, disable, and remove", async () => {
    const preview = await post(server.url, "/api/epg/source/preview", {
      name: "G58 EPG",
      type: "fixture",
      content: `<tv><channel id="news"><display-name>新闻台</display-name></channel><programme channel="news" start="20260807120000 UTC" stop="20260807130000 UTC"><title>午间新闻</title></programme></tv>`,
    });
    expect(preview.live.epg.sources).toHaveLength(0);
    expect(preview.live.epg.preview.stats).toMatchObject({ channelCount: 1, programmeCount: 1 });
    const applied = await post(server.url, "/api/epg/source/apply", { previewId: preview.live.epg.preview.id });
    const source = applied.live.epg.sources[0];
    expect(source).toMatchObject({ name: "G58 EPG", channelCount: 1, programmeCount: 1, enabled: true });
    const disabled = await post(server.url, "/api/epg/source/toggle", { sourceId: source.id, enabled: false });
    expect(disabled.live.epg.sources[0].enabled).toBe(false);
    const removed = await post(server.url, "/api/epg/source/remove", { sourceId: source.id });
    expect(removed.live.epg.sources).toHaveLength(0);
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

class EpgApiSession implements DesktopSpiderSessionPort {
  public readonly view: DesktopSpiderView = {
    source: "fixture:epg-api",
    api: "csp_EpgFixture",
    status: "ready",
    warning: null,
    error: null,
    sidecarRunning: false,
    playback: { available: false, label: "Unavailable", message: "No playback" },
  };

  public confirmImport(): void {}
  public async open(): Promise<SpiderResponse> { return { id: "epg-api", ok: true, result: {} }; }
  public async homeContent(): Promise<SpiderResponse> { return { id: "epg-api", ok: true, result: { list: [] } }; }
  public async categoryContent(): Promise<SpiderResponse> { return { id: "epg-api", ok: true, result: { list: [] } }; }
  public async searchContent(): Promise<SpiderResponse> { return { id: "epg-api", ok: true, result: { list: [] } }; }
  public async detailContent(): Promise<SpiderResponse> { return { id: "epg-api", ok: true, result: { list: [] } }; }
  public async playerContent(): Promise<SpiderResponse> { return { id: "epg-api", ok: false, error: { code: "PLAYBACK_UNAVAILABLE", message: "No playback" } }; }
  public async destroy(): Promise<void> {}
}
