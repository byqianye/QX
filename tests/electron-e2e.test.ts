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
import type { SubtitleTrack } from "../src/subtitles.js";
import { runPackagedE2e } from "../src/electron/e2e-runner.js";
import { CacheRepository, FavoritesRepository, FollowRepository, HistoryRepository, PlaybackProgressRepository, SettingsRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { CacheService } from "../src/cache/cache-service.js";
import { FavoritesService } from "../src/favorites/favorites-service.js";
import { FollowService } from "../src/follow/follow-service.js";
import { HistoryProgressService } from "../src/history/history-progress.js";

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
      sites: [
        { key: "douban", api: "csp_Douban", ext: "fixture" },
        { key: "douban-alt", api: "csp_Douban", ext: "fixture" },
      ],
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
    const dataServices = createHistoryService(resources, directory);
    const cache = new CacheService({
      root: join(directory, "cache"),
      repository: new CacheRepository(dataServices.layer),
    });
    const uiServer = new DesktopSpiderUiServer({
      importer,
      history: dataServices.service,
      favorites: new FavoritesService({
        db: dataServices.layer,
        favorites: new FavoritesRepository(dataServices.layer),
        history: new HistoryRepository(dataServices.layer),
      }),
      follow: new FollowService({
        db: dataServices.layer,
        follow: new FollowRepository(dataServices.layer),
        history: new HistoryRepository(dataServices.layer),
      }),
      cache,
      playbackProxyOrigins: ["http://127.0.0.1:43123"],
      parserCandidates: [
        {
          id: "fixture-parser-first",
          name: "Fixture parser first",
          type: "json",
          endpoint: "https://parser.example.invalid/first",
          enabled: true,
          priority: 1,
          timeout: 100,
        },
        {
          id: "fixture-parser-second",
          name: "Fixture parser second",
          type: "json",
          endpoint: "https://parser.example.invalid/second",
          enabled: true,
          priority: 2,
          timeout: 100,
        },
      ],
      parserAllowedOrigins: ["http://127.0.0.1:43123", "https://parser.example.invalid"],
      parserFetch: async (input) => String(input).endsWith("/first")
        ? new Response("fixture parser failed", { status: 503 })
        : new Response(JSON.stringify({
          parse: 0,
          url: "http://127.0.0.1:43123/media/fixture.m3u8",
          headers: {},
        }), { headers: { "content-type": "application/json" } }),
      playbackFallbackMode: "auto",
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
      verifySubtitleTracks: true,
      verifyPlaybackHealth: true,
      verifyParserFallback: true,
      verifyPlaybackFallback: true,
      verifyHistory: true,
      verifyFavorites: true,
      verifyFollow: true,
      verifyCache: true,
      verifyAggregateSearch: true,
      verifyFakeMpv: true,
      fakeMpv: async () => true,
      resourceCleanup: async () => ({ proxySessions: 0, snifferSessions: 0 }),
    });

    expect(result).toMatchObject({
      status: "passed",
      checks: {
        doubanUnavailable: true,
        embeddedMp4: true,
        embeddedHls: true,
        parseChain: true,
        vodPlaybackFlow: true,
        proxyRequired: true,
        noExternalBrowser: true,
        errorSurface: true,
        detachablePlayer: true,
        singlePlaybackSession: true,
        noBackgroundPlayer: true,
        subtitleTracks: true,
        playbackHealth: true,
        aggregateSearch: true,
        parserFallback: true,
        playbackFallback: true,
        history: true,
        historyRestart: true,
        favorites: true,
        follow: true,
        cache: true,
        fakeMpvExit: true,
        proxyCleanup: true,
        snifferCleanup: true,
      },
    });
  });
});

function createHistoryService(
  resources: Array<{ close(): Promise<void> }>,
  directory: string,
): { service: HistoryProgressService; layer: SqliteDataLayer } {
  const layer = SqliteDataLayer.create(join(directory, "history-e2e.db"));
  resources.push({ close: async () => { layer.close(); } });
  return {
    service: new HistoryProgressService({
      db: layer,
      history: new HistoryRepository(layer),
      progress: new PlaybackProgressRepository(layer),
      settings: new SettingsRepository(layer),
    }),
    layer,
  };
}

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
      if (ids[0] === "fixture:fallback") {
        item.vod_play_from = "故障线路$$$备用线路";
        item.vod_play_url = "第一集$fallback-fail$$$第一集$fallback-good";
      } else {
        item.vod_play_from = "主线$$$备用线";
        item.vod_play_url = "第一集$direct-hls#第二集$headered$$$电影$direct-mp4";
      }
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
      const playback = {
        available: true,
        label: "Playable source",
        message: "Headered HLS URL resolved",
        parse: 0,
        url: "http://127.0.0.1:43123/protected/fixture.m3u8",
        headers: {
          Referer: "https://source.example.invalid/",
          "User-Agent": "G22-fixture",
        },
        subtitles: fixtureSubtitles(),
      } as const;
      this.view.playback = playback;
      return ok({ parse: 0, url: playback.url, header: playback.headers, subtitles: fixtureSubtitles() });
    }
    if (id === "fallback-fail") {
      return {
        id: "fixture",
        ok: false,
        error: { code: "JVM_SPIDER_ERROR", message: "fixture first line failed" },
      };
    }
    if (id === "fallback-good") {
      const url = "http://127.0.0.1:43123/media/fixture.m3u8";
      this.view.playback = {
        available: true,
        label: "Fallback fixture",
        message: "fallback line succeeded",
        parse: 0,
        url,
        headers: {},
        subtitles: fixtureSubtitles(),
      };
      return ok({ parse: 0, url, header: {}, subtitles: fixtureSubtitles() });
    }
    if (id === "parse-one") {
      this.view.playback = {
        available: true,
        label: "Parser fixture",
        message: "parse=1 fixture",
        parse: 1,
        url: "https://parser.example.invalid/input",
        headers: {},
      };
      return ok({ parse: 1, url: this.view.playback.url, header: {} });
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
      ...(id === "direct-hls" ? { subtitles: fixtureSubtitles() } : {}),
    };
    return ok({ parse: 0, url, header: {}, ...(id === "direct-hls" ? { subtitles: fixtureSubtitles() } : {}) });
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}

function fixtureSubtitles(): SubtitleTrack[] {
  return [
    {
      id: "fixture-zh",
      label: "简体中文",
      language: "zh-CN",
      format: "vtt",
      url: "http://127.0.0.1:43123/subtitles/fixture.vtt",
      default: true,
      forced: false,
      source: "fixture",
    },
    {
      id: "fixture-forced",
      label: "强制字幕",
      language: "zh-CN",
      format: "srt",
      url: "http://127.0.0.1:43123/subtitles/fixture.srt",
      default: false,
      forced: true,
      source: "fixture",
    },
  ];
}

function ok(result: unknown): SpiderResponse {
  return { id: "fixture", ok: true, result };
}
