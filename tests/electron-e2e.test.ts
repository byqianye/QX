import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ImportTrustStore } from "../src/config/trust.js";
import {
  DesktopSpiderImportController,
} from "../src/desktop/spider-import.js";
import { DesktopSpiderUiServer } from "../src/desktop/spider-ui.js";
import type {
  DesktopSpiderSessionPort,
  DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import type { SpiderResponse } from "../src/spider/rpc.js";
import { runPackagedE2e } from "../src/electron/e2e-runner.js";

describe("packaged Electron E2E flow", () => {
  const resources: Array<{ close(): Promise<void> }> = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (resources.length > 0) await resources.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs URL, file, raw JSON, trust restart, search-detail and sidecar close checks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-electron-e2e-"));
    directories.push(directory);
    const config = JSON.stringify({
      spider: "fixture.jar",
      sites: [{ key: "douban", api: "csp_Douban", ext: "fixture" }],
    });
    const configFile = join(directory, "config.json");
    writeFileSync(configFile, config, "utf8");
    const configServer = await startConfigServer(config);
    resources.push(configServer);

    const session = new SessionFixture();
    const importer = new DesktopSpiderImportController({
      trustStore: new ImportTrustStore(),
      createSession: () => session,
    });
    const uiServer = new DesktopSpiderUiServer({ importer });
    resources.push(uiServer);
    await uiServer.start();

    const result = await runPackagedE2e({
      baseUrl: uiServer.url,
      configUrl: configServer.url,
      configFile,
      configJson: config,
      freshTrust: true,
      startAgain: async () => ({ url: uiServer.url }),
      closeWindow: async () => uiServer.close(),
      getSidecarPid: () => 4321,
      waitForSidecarExit: async () => true,
    });

    expect(result).toMatchObject({
      status: "passed",
      checks: {
        initialImportForm: true,
        urlImport: true,
        cancellation: true,
        fileImport: true,
        jsonImport: true,
        searchDetail: true,
        sidecarStopped: true,
        repeatedStart: true,
        trustedReimport: true,
      },
    });
  });

  it("runs the embedded MP4/HLS and proxy-required playback checks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-electron-playback-e2e-"));
    directories.push(directory);
    const config = JSON.stringify({
      spider: "fixture.jar",
      sites: [{ key: "douban", api: "csp_Douban", ext: "fixture" }],
    });
    const playbackConfig = JSON.stringify({
      spider: "fixture.jar",
      sites: [{ key: "playable", api: "csp_PlayableFixture", ext: "fixture-player" }],
    });
    const configFile = join(directory, "config.json");
    writeFileSync(configFile, config, "utf8");
    const configServer = await startConfigServer(config);
    resources.push(configServer);

    const importer = new DesktopSpiderImportController({
      trustStore: new ImportTrustStore(),
      createSession: (_source, _config, site) => new SessionFixture(site.api ?? "csp_Douban"),
    });
    const uiServer = new DesktopSpiderUiServer({
      importer,
      playbackProxyOrigins: ["http://127.0.0.1:43123"],
    });
    resources.push(uiServer);
    await uiServer.start();

    const result = await runPackagedE2e({
      baseUrl: uiServer.url,
      configUrl: configServer.url,
      configFile,
      configJson: config,
      freshTrust: true,
      playback: { configJson: playbackConfig },
      startAgain: async () => ({ url: uiServer.url }),
      closeWindow: async () => uiServer.close(),
      getSidecarPid: () => 4321,
      waitForSidecarExit: async () => true,
    });

    expect(result).toMatchObject({
      status: "passed",
      checks: {
        doubanUnavailable: true,
        embeddedMp4: true,
        embeddedHls: true,
        vodPlaybackFlow: true,
        proxyRequired: true,
        noExternalBrowser: true,
        detachablePlayer: true,
        singlePlaybackSession: true,
        noBackgroundPlayer: true,
      },
    });
  });
});

async function startConfigServer(config: string): Promise<ServerResource> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(config);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/config.json`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

interface ServerResource {
  url: string;
  close(): Promise<void>;
}

class SessionFixture implements DesktopSpiderSessionPort {
  public destroyed = false;
  public view: DesktopSpiderView;

  public constructor(private readonly api = "csp_Douban") {
    this.view = {
      source: "inline:fixture",
      api,
      status: "idle",
      warning: null,
      error: null,
      sidecarRunning: false,
      playback: {
        available: false,
        label: api === "csp_PlayableFixture" ? "Playable source" : "Douban：无正片播放源",
        message: api === "csp_PlayableFixture"
          ? "Select a title and resolve its playback URL"
          : "Douban 当前仅提供元数据/详情，未提供可直接播放的正片地址。",
      },
    };
  }

  public confirmImport(): void {
    this.view.status = "idle";
  }

  public async open(): Promise<SpiderResponse> {
    this.view.status = "ready";
    this.view.sidecarRunning = true;
    return ok({ initialized: true });
  }

  public async homeContent(): Promise<SpiderResponse> {
    return ok({ list: [{ vod_id: "msearch:home" }] });
  }

  public async categoryContent(): Promise<SpiderResponse> {
    return ok({ list: [{ vod_id: "msearch:category" }] });
  }

  public async searchContent(): Promise<SpiderResponse> {
    return ok({ list: [{ vod_id: "msearch:123456" }] });
  }

  public async detailContent(ids: string[]): Promise<SpiderResponse> {
    const item: Record<string, unknown> = { vod_id: ids[0], vod_name: "Fixture Detail" };
    if (this.api === "csp_PlayableFixture") {
      item.vod_play_from = "主线$$$备用线";
      item.vod_play_url = "第一集$direct-hls#第二集$headered$$$电影$direct-mp4";
    }
    return ok({ list: [item] });
  }

  public async playerContent(_flag: string, id: string): Promise<SpiderResponse> {
    if (this.api !== "csp_PlayableFixture") {
      return {
        id: "fixture",
        ok: false,
        error: { code: "PLAYBACK_UNAVAILABLE", message: "Douban has no playback" },
      };
    }
    if (id === "headered") {
      this.view.playback = {
        available: true,
        label: "Playable source",
        message: "Headered HLS URL resolved",
        parse: 0,
        url: "http://127.0.0.1:43123/protected/fixture.m3u8",
        headers: {
          Referer: "https://source.example.invalid/",
          "User-Agent": "G22-fixture",
        },
      };
      return ok({ parse: 0, url: this.view.playback.url, header: this.view.playback.headers });
    }
    const url = id === "direct-hls"
      ? "http://127.0.0.1:43123/media/fixture.m3u8"
      : "http://127.0.0.1:43123/media/fixture.mp4";
    this.view.playback = {
      available: true,
      label: "Playable source",
      message: "Direct playback URL resolved",
      parse: 0,
      url,
      headers: {},
    };
    return ok({ parse: 0, url, header: {} });
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}

function ok(result: unknown): SpiderResponse {
  return { id: "fixture", ok: true, result };
}
