import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  DesktopSpiderPlaybackState,
  DesktopSpiderSessionPort,
  DesktopSpiderSessionStatus,
  DesktopSpiderView,
} from "../src/desktop/spider-ui.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  renderDesktopSpiderUi,
} from "../src/desktop/spider-ui.js";
import type { PlaybackSourceResolution } from "../src/desktop/playback-source-resolver.js";
import {
  IsolatedSniffer,
  type IsolatedSnifferPlatform,
  type IsolatedSnifferSession,
  type SnifferNavigationEvent,
  type SnifferPolicy,
  type SnifferRequestEvent,
  type SnifferResponseEvent,
  type SnifferViolation,
} from "../src/electron/isolated-sniffer.js";
import type { SpiderResponse } from "../src/spider/rpc.js";
import {
  CacheRepository,
  FavoritesRepository,
  FollowRepository,
  HistoryRepository,
  PlaybackProgressRepository,
  SettingsRepository,
} from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { HistoryProgressService } from "../src/history/history-progress.js";
import { FavoritesService } from "../src/favorites/favorites-service.js";
import { FollowService } from "../src/follow/follow-service.js";
import { CacheService } from "../src/cache/cache-service.js";
import { DataDirectoryResolver, DataStorageService } from "../src/data/data-directory.js";
import { LocalMediaService } from "../src/local-media/local-media-service.js";
import { DownloadService } from "../src/downloads/download-service.js";
import { FakeDownloadBackend } from "../src/downloads/download-backend.js";
import type { BackupUiState } from "../src/backup-types.js";

describe("desktop Spider UI", () => {
  const servers: DesktopSpiderUiServer[] = [];
  const historyLayers: SqliteDataLayer[] = [];
  const historyDirectories: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (historyLayers.length > 0) historyLayers.pop()?.close();
    while (historyDirectories.length > 0) {
      const directory = historyDirectories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders import confirmation and disables playback for Douban", () => {
    const fixture = new FixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });

    expect(ui.state).toMatchObject({
      page: "import",
      status: "confirmation_required",
      warning: "Confirm this import before running Spider code",
      loading: false,
      canPlay: false,
    });

    const html = renderDesktopSpiderUi(ui.state);
    expect(html).toContain('data-testid="import-warning"');
    expect(html).toContain("确认并信任");
    expect(html).toContain("Douban：无正片播放源");
    expect(html).toMatch(/data-testid="play-button"[^>]*disabled/);
  });

  it("keeps the list poster when detail metadata omits the poster", async () => {
    const fixture = new PosterFixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });

    ui.confirmImport();
    await ui.open("douban", "fixture-endpoint");
    await ui.home();
    await ui.detail("poster-fixture");

    expect(ui.state.detail).toMatchObject({
      vod_name: "Fixture Detail",
      vod_pic: "https://img.example.invalid/poster.jpg@Referer=https://api.example.invalid/",
    });
  });

  it("does not render source query credentials in the legacy shell", () => {
    const fixture = new FixtureSession("https://media.example/internal/config.json?token=secret");
    const ui = new DesktopSpiderUiController({ session: fixture });

    const html = renderDesktopSpiderUi(ui.state);
    expect(html).not.toContain("token=secret");
    expect(html).toContain("https://media.example/…");
  });

  it("enables the playback entry after a playable JVM source resolves playerContent", async () => {
    const fixture = new FixtureSession(
      "inline:playable",
      "csp_PlayableFixture",
      true,
    );
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });

    ui.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.detail("fixture:movie-1");
    expect(ui.state.canPlay).toBe(false);
    expect(renderDesktopSpiderUi(ui.state)).toMatch(/data-testid="play-button"[^>]*disabled/);

    await ui.player("default", "fixture:movie-1", ["vip"]);

    expect(ui.state).toMatchObject({
      status: "ready",
      canPlay: true,
      playback: {
        available: true,
        parse: 0,
        url: "https://media.example.invalid/fixture.m3u8",
        headers: {},
      },
      player: {
        status: "loading",
        source: {
          parse: 0,
          mediaType: "hls",
        },
      },
    });
    expect(ui.state.player.source?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__qx_playback\//);
    expect(renderDesktopSpiderUi(ui.state)).toContain('data-testid="embedded-player"');
    expect(renderDesktopSpiderUi(ui.state)).not.toContain("window.open");
    expect(renderDesktopSpiderUi(ui.state)).toContain("hlsInstance.destroy");
    expect(renderDesktopSpiderUi(ui.state)).toContain("removeEventListener");
    expect(renderDesktopSpiderUi(ui.state)).not.toMatch(/data-testid="play-button"[^>]*disabled/);
  });

  it("plays a Push source-item only through the selected source", async () => {
    const fixture = new FixtureSession("source-a", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({ session: fixture });
    fixture.confirmImport();
    await ui.open("playable", "fixture-endpoint");

    await ui.playPushSourceItem({ sourceId: "source-a", contentId: "headered", flag: "default" });
    expect(fixture.calls).toContain("player:default:headered:");
    await expect(ui.playPushSourceItem({ sourceId: "source-b", contentId: "headered", flag: "default" })).rejects.toMatchObject({
      code: "PUSH_SOURCE_UNAVAILABLE",
    });
    await ui.close();
  });

  it("routes a headered URL through a controlled LocalProxy session", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["http://127.0.0.1:43123", "https://media.example.invalid"],
    });

    ui.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.player("default", "headered", []);

    expect(ui.state).toMatchObject({
      status: "ready",
      error: null,
      player: {
        status: "loading",
        source: {
          parse: 0,
          headers: {},
        },
      },
    });
    expect(ui.state.player.source?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__qx_playback\//);
    expect(renderDesktopSpiderUi(ui.state)).toContain("__qx_playback");
    expect(renderDesktopSpiderUi(ui.state)).toContain("/assets/hls.min.js");
    expect(renderDesktopSpiderUi(ui.state)).not.toMatch(/data-testid="play-button"[^>]*disabled/);
    await ui.close();
  });

  it("resolves parse=1 through the controlled parser chain before loading the player", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["https://media.example.invalid"],
      parserCandidates: [{
        id: "fixture-parser",
        name: "Fixture parser",
        type: "json",
        endpoint: "https://parser.example.invalid/resolve",
        enabled: true,
        priority: 1,
        timeout: 100,
      }],
      parserAllowedOrigins: ["https://parser.example.invalid", "https://media.example.invalid"],
      parserFetch: async () => new Response(JSON.stringify({
        url: "https://media.example.invalid/parsed.m3u8",
        headers: {},
      }), { headers: { "content-type": "application/json" } }),
    });

    fixture.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.player("default", "parse-one");

    expect(ui.state).toMatchObject({
      error: null,
      player: {
        status: "loading",
        parse: {
          status: "succeeded",
        parserId: "fixture-parser",
        },
        source: { parse: 0, jx: 0, mediaType: "hls", headers: {} },
      },
    });
    expect(ui.state.player.source?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__qx_playback\//);
    expect(renderDesktopSpiderUi(ui.state)).toContain('data-testid="parser-status"');
    expect(renderDesktopSpiderUi(ui.state)).toContain('data-testid="parser-diagnostics"');
    await ui.close();
  });

  it("surfaces parse-unavailable as a controlled player error", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({ session: fixture });

    fixture.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    const failed = await ui.player("default", "parse-one");

    expect(failed).toMatchObject({
      status: "error",
      error: { code: "PARSE_UNAVAILABLE" },
      player: {
        status: "error",
        parse: { status: "failed", error: { code: "PARSE_UNAVAILABLE" } },
      },
    });
    await ui.close();
  });

  it("falls back to the isolated sniffer after parser failure", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const platform = new UiSnifferPlatform();
    const sniffer = new IsolatedSniffer(platform);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["https://media.example.invalid"],
      sniffer,
      parserCandidates: [{
        id: "unavailable-parser",
        name: "Unavailable parser",
        type: "json",
        endpoint: "https://parser.example.invalid/resolve",
        enabled: true,
        priority: 1,
        timeout: 20,
      }],
      parserAllowedOrigins: ["https://parser.example.invalid", "https://media.example.invalid"],
      parserFetch: async () => {
        throw new Error("parser unavailable");
      },
    });

    fixture.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.player("default", "parse-one");

    expect(ui.state).toMatchObject({
      status: "ready",
      error: null,
      player: {
        status: "loading",
        parse: {
          status: "succeeded",
          parserId: "isolated-sniffer",
        },
        source: {
          parse: 0,
          mediaType: "hls",
        },
      },
    });
    expect(ui.state.player.source?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__qx_playback\//);
    expect(platform.policy).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowDownloads: false,
      allowPopups: false,
    });
    await ui.close();
    await sniffer.close();
    expect(platform.session.closeCount).toBe(1);
  });

  it("renders playback lines and passes episode selection through the same Spider session", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["http://127.0.0.1:43123", "https://media.example.invalid"],
    });

    ui.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.detail("fixture:movie-1");

    expect(ui.state.playbackCatalog).toMatchObject({
      lines: [
        { name: "主线", episodes: [{ name: "第一集" }, { name: "第二集" }] },
        { name: "备用线", episodes: [{ name: "电影" }] },
      ],
    });
    const html = renderDesktopSpiderUi(ui.state);
    expect(html).toContain('data-testid="playback-selector"');
    expect(html).toContain('data-testid="current-line"');
    expect(html).toContain('data-action="player-episode"');
    expect(html).toContain('data-testid="playback-order"');
    expect(html).toContain('data-order="forward"');
    expect(html).toContain('data-order="reverse"');
    expect(html).toContain("正序");
    expect(html).toContain("倒序");
    expect(html).toContain('data-play-flag="主线"');
    expect(html).toContain('data-play-id="headered"');

    await ui.playEpisode(0, 1, ["vip"]);
    expect(fixture.calls).toContain("player:主线:headered:vip");
    expect(ui.state.playbackSelection).toEqual({ lineIndex: 0, episodeIndex: 1 });
    expect(fixture.destroyed).toBe(false);

    ui.syncPlayerState({ status: "playing", currentTime: 44, duration: 100, volume: 0.35, muted: true });
    await ui.playEpisode(1, 0);
    expect(fixture.calls).toContain("player:备用线:direct-mp4:");
    expect(ui.state.playbackSelection).toEqual({ lineIndex: 1, episodeIndex: 0 });
    expect(ui.state.player).toMatchObject({ currentTime: 44, volume: 0.35, muted: true });
    expect(fixture.calls.filter((call) => call.startsWith("open:")).length).toBe(1);
    await ui.close();
  });

  it("creates history only after playback sync, shows resume after restart, and seeks only after choice", async () => {
    const history = createHistoryService();
    const first = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const firstUi = new DesktopSpiderUiController({
      session: first,
      history,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });
    first.confirmImport();
    await firstUi.open("playable", "fixture-endpoint");
    await firstUi.detail("fixture:movie-1");
    await firstUi.playEpisode(0, 0);
    expect(history.uiState().items).toHaveLength(0);
    firstUi.syncPlayerState({ status: "playing", currentTime: 44, duration: 100 });
    await firstUi.stopPlayer();
    expect(history.uiState().items[0]).toMatchObject({ episodeId: "direct-hls", position: 44 });
    await firstUi.close();

    const second = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const secondUi = new DesktopSpiderUiController({
      session: second,
      history,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });
    second.confirmImport();
    await secondUi.open("playable", "fixture-endpoint");
    await secondUi.detail("fixture:movie-1");
    expect(secondUi.state.historyResume).toMatchObject({ position: 44 });
    await secondUi.playEpisode(0, 0);
    expect(secondUi.state.player.currentTime).toBe(0);
    await secondUi.stopPlayer();
    await secondUi.playEpisode(0, 0, [], undefined, "continue");
    expect(secondUi.state.player.currentTime).toBe(44);
    await secondUi.close();
  });

  it("restores the exact history item selected through the legacy HTTP route", async () => {
    const history = createHistoryService();
    const first = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const firstUi = new DesktopSpiderUiController({
      session: first,
      history,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });
    first.confirmImport();
    await firstUi.open("playable", "fixture-endpoint");
    await firstUi.detail("fixture:movie-1");
    await firstUi.playEpisode(0, 0);
    firstUi.syncPlayerState({ status: "playing", currentTime: 20, duration: 100 });
    await firstUi.stopPlayer();
    await firstUi.playEpisode(0, 1);
    firstUi.syncPlayerState({ status: "playing", currentTime: 40, duration: 100 });
    await firstUi.stopPlayer();
    const firstEpisode = history.uiState().items.find((item) => item.episodeId === "direct-hls");
    if (!firstEpisode) throw new Error("Expected first episode history");
    await firstUi.close();

    const second = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const secondUi = new DesktopSpiderUiController({
      session: second,
      history,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });
    second.confirmImport();
    await secondUi.open("playable", "fixture-endpoint");
    await secondUi.detail("fixture:movie-1");
    const server = new DesktopSpiderUiServer({
      ui: secondUi,
      siteKey: "playable",
      ext: "fixture-endpoint",
      history,
    });
    servers.push(server);
    await server.start();

    const opened = await post(server.url, "/api/history/open", { identity: firstEpisode.identity });
    expect(opened.state.historyResume).toMatchObject({
      identity: firstEpisode.identity,
      position: 20,
      episodeIndex: 0,
    });
    await secondUi.close();
  });

  it("persists history, favorites and follow for details that use the generic id fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-generic-id-"));
    historyDirectories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    historyLayers.push(layer);
    const history = new HistoryProgressService({
      db: layer,
      history: new HistoryRepository(layer),
      progress: new PlaybackProgressRepository(layer),
      settings: new SettingsRepository(layer),
    });
    const favorites = new FavoritesService({
      db: layer,
      favorites: new FavoritesRepository(layer),
      history: new HistoryRepository(layer),
    });
    const follow = new FollowService({
      db: layer,
      follow: new FollowRepository(layer),
      history: new HistoryRepository(layer),
    });
    const fixture = new GenericIdFixtureSession();
    const ui = new DesktopSpiderUiController({
      session: fixture,
      history,
      favorites,
      follow,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });

    fixture.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.detail("generic-movie-1");
    ui.toggleFavorite();
    ui.toggleFollow();
    await ui.playEpisode(0, 0);
    ui.syncPlayerState({ status: "playing", currentTime: 18, duration: 120 });
    await ui.stopPlayer();

    expect(favorites.uiState().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ vodId: "generic-movie-1", title: "Generic Detail" }),
    ]));
    expect(follow.uiState().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ vodId: "generic-movie-1", title: "Generic Detail" }),
    ]));
    expect(history.uiState().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ vodId: "generic-movie-1", title: "Generic Detail", position: 18 }),
    ]));

    const reloadedFavorites = new FavoritesService({
      db: layer,
      favorites: new FavoritesRepository(layer),
      history: new HistoryRepository(layer),
    });
    const reloadedFollow = new FollowService({
      db: layer,
      follow: new FollowRepository(layer),
      history: new HistoryRepository(layer),
    });
    const reloadedHistory = new HistoryProgressService({
      db: layer,
      history: new HistoryRepository(layer),
      progress: new PlaybackProgressRepository(layer),
      settings: new SettingsRepository(layer),
    });
    expect(reloadedFavorites.uiState().items).toHaveLength(1);
    expect(reloadedFollow.uiState().items).toHaveLength(1);
    expect(reloadedHistory.uiState().items).toHaveLength(1);
  });

  it("preserves the selected episode and detail when playback fails", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["http://127.0.0.1:43123", "https://media.example.invalid"],
    });

    ui.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.detail("fixture:movie-1");
    await ui.playEpisode(0, 0);
    const failed = await ui.player("主线", "fail", []);

    expect(failed).toMatchObject({
      page: "detail",
      status: "error",
      error: { code: "PLAYBACK_UPSTREAM_ERROR" },
      playbackSelection: { lineIndex: 0, episodeIndex: 0 },
    });
    expect(failed.detail?.vod_id).toBe("fixture:movie-1");
    expect(failed.playbackCatalog?.lines).toHaveLength(2);
    expect(renderDesktopSpiderUi(failed)).toContain('data-testid="playback-retry"');

    const retried = await ui.playEpisode(0, 0);
    expect(retried).toMatchObject({ status: "ready", playbackSelection: { lineIndex: 0, episodeIndex: 0 } });
    await ui.close();
  });

  it("keeps the active playback context while browsing home", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });

    ui.confirmImport();
    await ui.open("playable", "fixture-endpoint");
    await ui.detail("fixture:movie-1");
    await ui.playEpisode(0, 0);
    await ui.home();

    expect(ui.state.page).toBe("home");
    expect(ui.state.detail).toBeNull();
    expect(ui.state.playbackCatalog?.lines).toHaveLength(2);
    expect(ui.state.player.source).not.toBeNull();
    await ui.close();
  });

  it("drives home, category, search and detail, then destroys on switch and close", async () => {
    const first = new FixtureSession();
    const second = new FixtureSession("http://example.invalid/second.json");
    const sessions = [second];
    const ui = new DesktopSpiderUiController({
      session: first,
      createSession: () => sessions.shift() ?? second,
    });

    ui.confirmImport();
    await ui.open("douban", "fixture-endpoint");
    await ui.home();
    expect(ui.state).toMatchObject({ page: "home", status: "ready" });
    expect(ui.state.items[0]?.vod_id).toBe("msearch:home-1");

    await ui.category("hot_gaia", 2, true, { sort: "U" });
    expect(ui.state).toMatchObject({ page: "category", status: "ready" });
    expect(first.calls).toContain("category:hot_gaia:2:true:U");

    await ui.search("蜘蛛侠", false, 1);
    expect(ui.state).toMatchObject({ page: "search", status: "ready" });
    expect(ui.state.items[0]?.vod_id).toBe("msearch:search-1");

    await ui.detail("msearch:search-1");
    expect(ui.state).toMatchObject({ page: "detail", status: "ready" });
    expect(ui.state.detail?.vod_name).toBe("Fixture Detail");
    expect(ui.state.canPlay).toBe(false);

    await ui.switchSource();
    expect(first.destroyed).toBe(true);
    expect(ui.state).toMatchObject({ page: "import", status: "confirmation_required" });

    await ui.close();
    expect(second.destroyed).toBe(true);
    expect(ui.state.status).toBe("destroyed");
  });

  it("closes detail back to the exact search context without another Spider request", async () => {
    const fixture = new FixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });

    ui.confirmImport();
    await ui.open("douban", "fixture-endpoint");
    await ui.search("蜘蛛侠", false, 1);
    ui.setScrollTop(420);
    await ui.detail("msearch:search-1");
    expect(ui.state.page).toBe("detail");

    const callsBeforeClose = fixture.calls.length;
    const closed = ui.closeDetail();

    expect(closed.page).toBe("search");
    expect(closed.scrollTop).toBe(420);
    expect(closed.detail).toBeNull();
    expect(closed.items[0]?.vod_id).toBe("msearch:search-1");
    expect(fixture.calls).toHaveLength(callsBeforeClose);
    await ui.close();
  });

  it("shows loading while a call is pending and maps timeout errors to the UI", async () => {
    const fixture = new FixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });
    ui.confirmImport();
    await ui.open("douban", "fixture-endpoint");

    const pending = deferred<SpiderResponse>();
    fixture.homeResult = pending.promise;
    const home = ui.home();
    expect(ui.state.loading).toBe(true);
    expect(ui.state.status).toBe("loading");
    expect(renderDesktopSpiderUi(ui.state)).toContain("加载中");

    pending.resolve(ok({ list: [{ vod_id: "msearch:loaded" }] }));
    await home;
    expect(ui.state.loading).toBe(false);
    expect(ui.state.items[0]?.vod_id).toBe("msearch:loaded");

    fixture.searchError = new Error("sidecar request timeout");
    await ui.search("timeout", false, 1);
    expect(ui.state.status).toBe("error");
    expect(ui.state.error).toMatchObject({ code: "SPIDER_TIMEOUT" });
    expect(renderDesktopSpiderUi(ui.state)).toContain("请求超时");
    expect(renderDesktopSpiderUi(ui.state)).toContain("SPIDER_TIMEOUT");
  });

  it("serves the interactive page and closes the session through HTTP", async () => {
    const fixture = new FixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
    });
    servers.push(server);
    await server.start();

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-testid="import-warning"');

    await post(server.url, "/api/import/confirm");
    await post(server.url, "/api/open");
    const home = await post(server.url, "/api/home");
    expect(home.state).toMatchObject({ page: "home", status: "ready" });

    await post(server.url, "/api/search", { key: "蜘蛛侠", page: 1, quick: false });
    await post(server.url, "/api/detail", { vodId: "msearch:search-1" });
    const restored = await post(server.url, "/api/detail/close");
    expect(restored.state).toMatchObject({ page: "search", detail: null });

    const closed = await post(server.url, "/api/close");
    expect(closed.state.status).toBe("destroyed");
    expect(fixture.destroyed).toBe(true);
  });

  it("rewrites source posters to the local image route in API state", async () => {
    const fixture = new PosterFixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
    });
    servers.push(server);
    await server.start();

    await post(server.url, "/api/import/confirm");
    await post(server.url, "/api/open");
    const home = await post(server.url, "/api/home");

    expect(home.state).toMatchObject({
      items: [{ vod_pic: expect.stringMatching(/^\/api\/poster\/[a-f0-9]{40}$/) }],
    });
  });

  it("routes HTTP episode selection to the real flag, id and vipFlags", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["https://media.example.invalid"],
    });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "playable",
      ext: "fixture-endpoint",
    });
    servers.push(server);
    await server.start();

    await post(server.url, "/api/import/confirm");
    await post(server.url, "/api/open");
    await post(server.url, "/api/detail", { vodId: "fixture:movie-1" });
    const player = await post(server.url, "/api/player", {
      lineIndex: 0,
      episodeIndex: 1,
      vipFlags: ["vip"],
    });

    expect(player.state).toMatchObject({
      page: "detail",
      playbackSelection: { lineIndex: 0, episodeIndex: 1 },
    });
    expect(fixture.calls).toContain("player:主线:headered:vip");
  });

  it("serves the bundled hls.js asset locally", async () => {
    const fixture = new FixtureSession();
    const ui = new DesktopSpiderUiController({ session: fixture });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
    });
    servers.push(server);
    await server.start();

    const response = await fetch(new URL("/assets/hls.min.js", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("Hls");
  });

  it("exposes cache state and category clearing through the local API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-cache-"));
    historyDirectories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    historyLayers.push(layer);
    const cache = new CacheService({
      root: join(directory, "cache"),
      repository: new CacheRepository(layer),
    });
    await cache.put({ type: "search", key: "fixture", bytes: Buffer.from("cached") });
    const ui = new DesktopSpiderUiController({ session: new FixtureSession(), cache });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
      cache,
    });
    servers.push(server);
    await server.start();

    const refreshed = await post(server.url, "/api/cache/refresh");
    expect(refreshed.state?.cache).toMatchObject({ entries: 1 });
    const cleared = await post(server.url, "/api/cache/clear", { scope: "search" });
    expect(cleared.state?.cache).toMatchObject({ entries: 0, totalBytes: 0 });
    const rejected = await fetch(new URL("/api/cache/clear", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "history" }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("CACHE_CLEAR_SCOPE_INVALID");
  });

  it("exposes storage state, folder opening, and confirmed mode switching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-storage-"));
    historyDirectories.push(directory);
    const resolver = new DataDirectoryResolver(join(directory, "user-data"));
    resolver.prepare();
    const storage = new DataStorageService(resolver);
    let opened = 0;
    let switched: string | null = null;
    const ui = new DesktopSpiderUiController({ session: new FixtureSession(), storage });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
      storage,
      onStorageOpen: () => { opened += 1; },
      onStorageSwitch: (mode) => { switched = mode; },
    });
    servers.push(server);
    await server.start();

    const refreshed = await post(server.url, "/api/storage/refresh");
    expect(refreshed.state?.storage).toMatchObject({ mode: "normal", dataRoot: "…/user-data" });
    await post(server.url, "/api/storage/open");
    await post(server.url, "/api/storage/switch", { mode: "portable", confirmed: true });
    expect(opened).toBe(1);
    expect(switched).toBe("portable");

    const rejected = await fetch(new URL("/api/storage/switch", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "portable", confirmed: false }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("STORAGE_CONFIRMATION_REQUIRED");
  });

  it("exposes backup creation, restore preview, and explicit replace confirmation", async () => {
    const state: BackupUiState = {
      status: "idle",
      lastBackup: null,
      preview: null,
      error: null,
    };
    let createdIncludeCache = false;
    let applied = 0;
    const ui = new DesktopSpiderUiController({ session: new FixtureSession() });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
      onBackupCreate: async (includeCache) => {
        createdIncludeCache = includeCache;
        return {
          ...state,
          lastBackup: {
            fileName: "fixture.zip",
            size: 12,
            createdAt: "2026-08-08T00:00:00.000Z",
            includeCache,
            summary: { settings: 1, history: 2, favorites: 3, following: 4 },
          },
        };
      },
      onBackupPick: async () => ({
        ...state,
        status: "preview",
        preview: {
          formatVersion: 1,
          appVersion: "0.1.0",
          createdAt: "2026-08-08T00:00:00.000Z",
          sections: ["database"],
          databaseSchemaVersion: 10,
          summary: { settings: 1, history: 2, favorites: 3, following: 4 },
          includeCache: false,
          compatibility: "compatible",
        },
      }),
      onBackupApply: () => { applied += 1; },
    });
    servers.push(server);
    await server.start();

    const created = await post(server.url, "/api/backup/create", { includeCache: true });
    expect(created.state.backup).toMatchObject({ status: "idle", lastBackup: { fileName: "fixture.zip", includeCache: true } });
    expect(createdIncludeCache).toBe(true);
    const preview = await post(server.url, "/api/backup/pick");
    expect(preview.state.backup).toMatchObject({ status: "preview", preview: { compatibility: "compatible" } });
    const appliedState = await post(server.url, "/api/backup/apply");
    expect(appliedState.state.backup).toMatchObject({ status: "restarting" });
    expect(applied).toBe(1);
  });

  it("plays an authorized local file through the existing player and records local history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-local-media-"));
    historyDirectories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    historyLayers.push(layer);
    const mediaPath = join(directory, "fixture.mp4");
    const folderPath = join(directory, "library");
    const droppedPath = join(directory, "dropped.webm");
    mkdirSync(folderPath);
    writeFileSync(mediaPath, Buffer.alloc(32));
    writeFileSync(join(folderPath, "library.webm"), Buffer.alloc(12));
    writeFileSync(droppedPath, Buffer.alloc(8));
    const history = new HistoryProgressService({
      db: layer,
      history: new HistoryRepository(layer),
      progress: new PlaybackProgressRepository(layer),
      settings: new SettingsRepository(layer),
    });
    const localMedia = new LocalMediaService({ db: layer });
    const ui = new DesktopSpiderUiController({
      session: new FixtureSession(),
      history,
      localMedia,
    });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
      history,
      localMedia,
      onLocalFilePicker: async () => [mediaPath],
      onLocalFolderPicker: async () => folderPath,
    });
    servers.push(server);
    await server.start();

    const opened = await post(server.url, "/api/local-media/open-file");
    const item = (opened.state.localMedia as { items: Array<{ id: string; fileReference: string }> }).items[0];
    if (!item) throw new Error("Expected local media item");
    expect(item).toMatchObject({ fileReference: expect.stringMatching(/^local-file:/) });
    expect(JSON.stringify(opened.state)).not.toContain(directory);
    const folderAdded = await post(server.url, "/api/local-media/add-folder");
    expect((folderAdded.state?.localMedia as { folders: Array<{ displayName: string }> }).folders)
      .toEqual(expect.arrayContaining([expect.objectContaining({ displayName: "library" })]));
    const dropped = await post(server.url, "/api/local-media/drop", { paths: [droppedPath] });
    expect((dropped.state?.localMedia as { items: Array<{ displayName: string }> }).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ displayName: "dropped.webm" })]));
    const played = await post(server.url, "/api/local-media/play", { itemId: item.id });
    const source = (played.state.player as { source: { url: string } }).source;
    const sessionId = (played.state.playbackSession as { id: string }).id;
    expect(source.url).toContain("/api/local-media/stream/");
    const media = await fetch(source.url, { headers: { range: "bytes=0-3" } });
    expect(media.status).toBe(206);
    expect((await media.arrayBuffer()).byteLength).toBe(4);

    await post(server.url, "/api/player/sync", {
      sessionId,
      status: "playing",
      currentTime: 5,
      duration: 100,
      event: { type: "first-frame" },
    });
    await post(server.url, "/api/player/sync", {
      sessionId,
      status: "paused",
      currentTime: 5,
      duration: 100,
      event: { type: "user-pause" },
    });
    await post(server.url, "/api/player/sync", {
      sessionId: "stale-renderer-session",
      status: "paused",
      currentTime: 0,
      duration: 1,
    });
    expect(history.uiState().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "local", position: 5 }),
    ]));

    await ui.stopPlayer();
    const resumedUi = new DesktopSpiderUiController({
      session: new FixtureSession(),
      history,
      localMedia,
    });
    await resumedUi.playLocalMedia(item.id, server.url, "continue");
    expect(resumedUi.state.player.currentTime).toBe(5);
    await resumedUi.stopPlayer();
  });

  it("serves the download manager through opaque folder IDs and explicit URL actions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-downloads-"));
    historyDirectories.push(directory);
    const targetPath = join(directory, "downloads");
    mkdirSync(targetPath);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    historyLayers.push(layer);
    const downloads = new DownloadService({
      db: layer,
      backend: new FakeDownloadBackend({ autoComplete: true }),
    });
    let openedPath: string | null = null;
    const ui = new DesktopSpiderUiController({
      session: new FixtureSession(),
      downloads,
    });
    const server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: "fixture-endpoint",
      downloads,
      onDownloadFolderPicker: async () => targetPath,
      onDownloadFolderOpen: async (path) => { openedPath = path; },
    });
    servers.push(server);
    await server.start();

    const selected = await post(server.url, "/api/downloads/select-folder");
    const target = (selected.state.downloads as { targetDirectories: Array<{ id: string }> }).targetDirectories[0];
    if (!target) throw new Error("Expected a selected download directory");
    expect(target.id).toMatch(/^download-dir-[a-f0-9]{24}$/);
    expect(JSON.stringify(selected.state)).not.toContain(directory);

    const added = await post(server.url, "/api/downloads/add", {
      title: "Fixture download",
      url: "https://media.example.test/files/fixture.mp4",
      filename: "fixture.mp4",
      targetDirectoryId: target.id,
    });
    const task = (added.state.downloads as { tasks: Array<Record<string, unknown>> }).tasks[0];
    expect(task).toMatchObject({ status: "completed", title: "Fixture download" });
    expect(task?.requestReference).toMatch(/^download:/);
    expect(JSON.stringify(added.state)).not.toContain("https://media.example.test");
    expect(JSON.stringify(added.state)).not.toContain(directory);

    await post(server.url, "/api/downloads/open-folder", { targetDirectoryId: target.id });
    expect(openedPath).toBe(targetPath);
    await downloads.close();
  });

  function createHistoryService(): HistoryProgressService {
    const directory = mkdtempSync(join(tmpdir(), "qx-desktop-history-"));
    historyDirectories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    historyLayers.push(layer);
    return new HistoryProgressService({
      db: layer,
      history: new HistoryRepository(layer),
      progress: new PlaybackProgressRepository(layer),
      settings: new SettingsRepository(layer),
    });
  }
});

class FixtureSession implements DesktopSpiderSessionPort {
  public readonly calls: string[] = [];
  public destroyed = false;
  public homeResult: Promise<SpiderResponse> | undefined;
  public searchError: Error | undefined;
  public view: DesktopSpiderView;

  public constructor(
    source = "http://example.invalid/config.json",
    api = "csp_Douban",
    playable = false,
  ) {
    this.view = {
      source,
      api,
      status: "confirmation_required",
      warning: "Confirm this import before running Spider code",
      error: null,
      sidecarRunning: false,
      playback: playable ? unavailablePlayback("Playable fixture: resolve a player URL") : playback(),
    };
  }

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

  public async homeContent(): Promise<SpiderResponse> {
    this.calls.push("home");
    if (this.homeResult) return this.homeResult;
    return ok({ list: [{ vod_id: "msearch:home-1", vod_name: "Fixture Home" }] });
  }

  public async categoryContent(
    typeId: string,
    page: number,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<SpiderResponse> {
    this.calls.push(`category:${typeId}:${page}:${filter}:${extend.sort ?? ""}`);
    return ok({ list: [{ vod_id: "msearch:category-1", vod_name: "Fixture Category" }] });
  }

  public async searchContent(key: string, quick: boolean, page: number): Promise<SpiderResponse> {
    this.calls.push(`search:${key}:${quick}:${page}`);
    if (this.searchError) throw this.searchError;
    return ok({ list: [{ vod_id: "msearch:search-1", vod_name: "Fixture Search" }] });
  }

  public async detailContent(ids: string[]): Promise<SpiderResponse> {
    this.calls.push(`detail:${ids.join(",")}`);
    const item: Record<string, unknown> = { vod_id: ids[0], vod_name: "Fixture Detail" };
    if (this.view.api === "csp_PlayableFixture") {
      item.vod_play_from = "主线$$$备用线";
      item.vod_play_url = "第一集$direct-hls#第二集$headered$$$电影$direct-mp4";
    }
    return ok({ list: [item] });
  }

  public async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<SpiderResponse> {
    this.calls.push(`player:${flag}:${id}:${vipFlags.join(",")}`);
    if (this.view.api !== "csp_PlayableFixture") {
      return { id: "fixture", ok: false, error: { code: "PLAYBACK_UNAVAILABLE", message: "Douban has no playback" } };
    }
    if (id === "headered") {
      this.view.playback = {
        available: true,
        label: "Playable fixture",
        message: "Headered HLS URL resolved",
        parse: 0,
        url: "http://127.0.0.1:43123/protected/fixture.m3u8",
        headers: {
          Referer: "https://source.example.invalid/",
          "User-Agent": "G22-fixture",
        },
      };
      return ok({
        parse: 0,
        url: this.view.playback.url,
        header: this.view.playback.headers,
      });
    }
    if (id === "parse-one") {
      this.view.playback = {
        available: true,
        label: "Parse fixture",
        message: "parse=1 fixture",
        parse: 1,
        jx: 1,
        url: "https://parser.example.invalid/resolve-input",
        headers: {},
      };
      return ok({ parse: 1, jx: 1, url: this.view.playback.url, header: {} });
    }
    if (id === "fail") {
      return {
        id: "fixture",
        ok: false,
        error: { code: "PLAYBACK_UPSTREAM_ERROR", message: "Fixture playback failed" },
      };
    }
    this.view.playback = {
      available: true,
      label: "Playable fixture",
      message: "Direct HLS URL resolved",
      parse: 0,
      url: "https://media.example.invalid/fixture.m3u8",
      headers: {},
    };
    return ok({
      parse: 0,
      url: this.view.playback.url,
      header: this.view.playback.headers,
    });
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}

class GenericIdFixtureSession extends FixtureSession {
  public constructor() {
    super("inline:generic-id", "csp_PlayableFixture", true);
  }

  public override async detailContent(ids: string[]): Promise<SpiderResponse> {
    this.calls.push(`detail:${ids.join(",")}`);
    return ok({
      list: [{
        id: ids[0],
        name: "Generic Detail",
        poster: "https://img.example.invalid/generic.jpg",
        vod_play_from: "主线",
        vod_play_url: "第一集$direct-hls",
      }],
    });
  }
}

class PosterFixtureSession extends FixtureSession {
  public override async homeContent(): Promise<SpiderResponse> {
    return ok({
      list: [{
        vod_id: "poster-fixture",
        vod_name: "Poster fixture",
        vod_pic: "https://img.example.invalid/poster.jpg@Referer=https://api.example.invalid/",
      }],
    });
  }
}

class UiSnifferPlatform implements IsolatedSnifferPlatform {
  public policy: SnifferPolicy | undefined;
  public readonly session = new UiSnifferSession();

  public async createSession(policy: SnifferPolicy): Promise<IsolatedSnifferSession> {
    this.policy = policy;
    return this.session;
  }
}

class UiSnifferSession implements IsolatedSnifferSession {
  public closeCount = 0;
  private readonly requestListeners = new Set<(event: SnifferRequestEvent) => void>();
  private readonly responseListeners = new Set<(event: SnifferResponseEvent) => void>();
  private readonly navigationListeners = new Set<(event: SnifferNavigationEvent) => void>();
  private readonly violationListeners = new Set<(event: SnifferViolation) => void>();

  public async load(): Promise<void> {
    queueMicrotask(() => {
      for (const listener of this.responseListeners) listener({
        requestId: "sniffed-playlist",
        url: "https://media.example.invalid/sniffed.m3u8",
        resourceType: "xhr",
        statusCode: 200,
        contentType: "application/vnd.apple.mpegurl",
        contentLength: 128,
        isMasterPlaylist: true,
      });
    });
  }

  public onRequest(listener: (event: SnifferRequestEvent) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  public onResponse(listener: (event: SnifferResponseEvent) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  public onNavigate(listener: (event: SnifferNavigationEvent) => void): () => void {
    this.navigationListeners.add(listener);
    return () => this.navigationListeners.delete(listener);
  }

  public onViolation(listener: (event: SnifferViolation) => void): () => void {
    this.violationListeners.add(listener);
    return () => this.violationListeners.delete(listener);
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function playback(): DesktopSpiderPlaybackState {
  return {
    available: false,
    label: "Douban：无正片播放源",
    message: "Douban 当前仅提供元数据/详情，未提供可直接播放的正片地址。",
  };
}

function unavailablePlayback(message: string): DesktopSpiderPlaybackState {
  return {
    available: false,
    label: "Playable source",
    message,
  };
}

function ok(result: unknown): SpiderResponse {
  return { id: "fixture", ok: true, result };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function post(base: string, path: string, body?: unknown): Promise<{ state: Record<string, unknown> }> {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { state: Record<string, unknown> };
}
