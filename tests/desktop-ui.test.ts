import { afterEach, describe, expect, it } from "vitest";

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
import type { SpiderResponse } from "../src/spider/rpc.js";

describe("desktop Spider UI", () => {
  const servers: DesktopSpiderUiServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
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

  it("enables the playback entry after a playable JVM source resolves playerContent", async () => {
    const fixture = new FixtureSession(
      "inline:playable",
      "csp_PlayableFixture",
      true,
    );
    const ui = new DesktopSpiderUiController({ session: fixture });

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
          url: "https://media.example.invalid/fixture.m3u8",
          parse: 0,
        },
      },
    });
    expect(renderDesktopSpiderUi(ui.state)).toContain("https://media.example.invalid/fixture.m3u8");
    expect(renderDesktopSpiderUi(ui.state)).toContain('data-testid="embedded-player"');
    expect(renderDesktopSpiderUi(ui.state)).not.toContain("window.open");
    expect(renderDesktopSpiderUi(ui.state)).toContain("hlsInstance.destroy");
    expect(renderDesktopSpiderUi(ui.state)).toContain("removeEventListener");
    expect(renderDesktopSpiderUi(ui.state)).not.toMatch(/data-testid="play-button"[^>]*disabled/);
  });

  it("routes a headered URL through a controlled LocalProxy session", async () => {
    const fixture = new FixtureSession("inline:playable", "csp_PlayableFixture", true);
    const ui = new DesktopSpiderUiController({
      session: fixture,
      playbackProxyOrigins: ["http://127.0.0.1:43123"],
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

    const closed = await post(server.url, "/api/close");
    expect(closed.state.status).toBe("destroyed");
    expect(fixture.destroyed).toBe(true);
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
    return ok({ list: [{ vod_id: ids[0], vod_name: "Fixture Detail" }] });
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

async function post(base: string, path: string): Promise<{ state: Record<string, unknown> }> {
  const response = await fetch(new URL(path, base), { method: "POST" });
  expect(response.status).toBe(200);
  return await response.json() as { state: Record<string, unknown> };
}
