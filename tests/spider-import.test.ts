import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopSpiderImportController,
  type DesktopSpiderImportOptions,
} from "../src/desktop/spider-import.js";
import { DesktopSpiderUiServer } from "../src/desktop/spider-ui.js";
import { JsonFileDesktopStateStore } from "../src/desktop/state-persistence.js";
import type { DesktopSpiderSessionPort, DesktopSpiderView } from "../src/desktop/spider-ui.js";
import type { SpiderResponse } from "../src/spider/rpc.js";
import { ImportTrustStore } from "../src/config/trust.js";
import { ConfigHistoryStore } from "../src/config/history.js";
import type { SourceCapabilities, Vod } from "../src/source/media-source.js";
import type { SpiderRuntimeManagerPort } from "../src/spider/runtime-types.js";

describe("real configuration import", () => {
  const servers: DesktopSpiderUiServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("reads raw JSON without creating a session before confirmation", async () => {
    const fixture = new SessionFixture();
    let createCount = 0;
    const importer = createImporter({
      createSession: (source, config, site) => {
        createCount += 1;
        expect(source).toMatch(/^inline:/);
        expect(config.sites?.[0]?.api).toBe("csp_Douban");
        expect(site.key).toBe("douban");
        return fixture;
      },
    });

    const pending = await importer.import(configJson());
    expect(pending).toMatchObject({
      status: "confirmation_required",
      inputKind: "json",
      selectedSiteKey: "douban",
      trusted: false,
      error: null,
    });
    expect(pending.summary?.siteCount).toBe(1);
    expect(importer.session).toBeUndefined();
    expect(createCount).toBe(0);

    const confirmed = importer.confirm();
    expect(confirmed).toMatchObject({ status: "ready", trusted: true });
    expect(importer.session?.view.status).toBe("idle");
    expect(createCount).toBe(1);
  });

  it("accepts a file path and a URL through the same trust boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-import-"));
    try {
      const path = join(directory, "config.json");
      writeFileSync(path, configJson(), "utf8");
      const fileImporter = createImporter();
      await fileImporter.import(path);
      expect(fileImporter.state).toMatchObject({
        inputKind: "file",
        sourceKind: "local",
        status: "confirmation_required",
      });

      let fetchedUrl = "";
      const urlImporter = createImporter({
        fetchText: async (url) => {
          fetchedUrl = url;
          return configJson();
        },
      });
      await urlImporter.import("https://example.invalid/config.json?token=secret");
      expect(fetchedUrl).toBe("https://example.invalid/config.json?token=secret");
      expect(urlImporter.state).toMatchObject({
        inputKind: "url",
        sourceKind: "remote",
        source: "https://example.invalid/config.json",
      });
      expect(JSON.stringify(urlImporter.state)).not.toContain("token=secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports invalid config and URL failures without invoking the session factory", async () => {
    let createCount = 0;
    const importer = createImporter({
      createSession: () => {
        createCount += 1;
        return new SessionFixture();
      },
    });

    await importer.import("{\"sites\":");
    expect(importer.state).toMatchObject({
      status: "error",
      error: { code: "IMPORT_INVALID_CONFIG" },
    });
    expect(createCount).toBe(0);

    const networkImporter = createImporter({
      fetchText: async () => {
        throw new Error("connection refused");
      },
    });
    await networkImporter.import("https://example.invalid/config.json");
    expect(networkImporter.state).toMatchObject({
      status: "error",
      error: { code: "IMPORT_FETCH_ERROR", message: "connection refused" },
    });
  });

  it("loads the last successful URL configuration when the network is unavailable", async () => {
    let online = true;
    const importer = createImporter({
      history: new ConfigHistoryStore(),
      fetchText: async () => {
        if (!online) throw new Error("offline");
        return configJson();
      },
    });

    await importer.import("https://example.invalid/config.json");
    importer.confirm();
    online = false;
    const fallback = await importer.import("https://example.invalid/config.json");

    expect(fallback).toMatchObject({ status: "ready", trusted: true });
    expect(fallback.warning).toContain("最后成功版本");
    expect(importer.session).toBeDefined();
  });

  it("reviews scheduled configuration changes without destroying the active session", async () => {
    const history = new ConfigHistoryStore();
    const nextConfig = JSON.stringify({
      spider: "fixture.jar",
      sites: [
        { key: "douban", name: "Douban", type: 3, api: "csp_Douban", ext: "fixture" },
        { key: "playable", name: "Playable", type: 3, api: "csp_PlayableFixture", ext: "fixture" },
      ],
    });
    const importer = createImporter({
      history,
      fetchText: async () => configJson(),
      fetchRefresh: async () => ({ body: nextConfig, etag: "v2" }),
    });

    await importer.import("https://example.invalid/config.json");
    importer.confirm();
    const activeSession = importer.session;
    const pending = await importer.refreshConfiguration();
    expect(pending.refresh.pendingVersionId).toBeTruthy();
    expect(pending.refresh.pendingChange?.addedSites).toEqual(["playable"]);
    expect(activeSession?.view.status).not.toBe("destroyed");

    await importer.approveConfigurationRefresh(pending.refresh.pendingVersionId ?? undefined);
    expect(activeSession?.view.status).not.toBe("destroyed");
    expect(importer.state.status).toBe("confirmation_required");
    importer.rejectConfigurationRefresh();
  });

  it("supports selecting only csp_Douban, cancellation, and repeated import", async () => {
    const first = new SessionFixture();
    const second = new SessionFixture();
    const sessions = [first, second];
    const importer = createImporter({
      createSession: () => sessions.shift() ?? second,
    });

    await importer.import(configJson(true));
    expect(importer.selectSite("other")).toMatchObject({
      status: "error",
      error: { code: "UNSUPPORTED_SPIDER_ENGINE" },
    });
    expect(importer.selectSite("douban")).toMatchObject({
      status: "confirmation_required",
      selectedSiteKey: "douban",
    });
    expect(await importer.cancel()).toMatchObject({ status: "cancelled" });
    expect(importer.session).toBeUndefined();

    await importer.import(configJson());
    importer.confirm();
    const firstSession = importer.session;
    expect(firstSession).toBeDefined();
    await firstSession?.open("douban", "douban");

    await importer.import(configJson());
    expect(first.destroyed).toBe(true);
    expect(importer.state.status).toBe("ready");
    expect(importer.session).not.toBe(firstSession);

    await importer.cancel();
    expect(second.destroyed).toBe(true);
    expect(importer.state.status).toBe("cancelled");
  });

  it("keeps independent site sessions alive while browsing another site", async () => {
    const sessions = new Map<string, SessionFixture>();
    const importer = createImporter({
      createSession: (_source, _config, site) => {
        const key = site.key ?? site.api ?? "unknown";
        const session = new SessionFixture();
        sessions.set(key, session);
        return session;
      },
    });
    const config = JSON.stringify({
      sites: [
        { key: "douban", api: "csp_Douban", ext: "fixture" },
        { key: "playable", api: "csp_PlayableFixture", ext: "fixture" },
      ],
    });

    await importer.import(config);
    importer.confirm();
    const douban = importer.session;
    expect(douban).toBeDefined();
    expect(importer.selectSite("playable").status).toBe("ready");
    const playable = importer.session;
    expect(playable).toBeDefined();
    expect(playable).not.toBe(douban);
    expect(douban?.view.status).not.toBe("destroyed");
    expect(importer.selectSite("douban").status).toBe("ready");
    expect(importer.session).toBe(douban);
    await importer.cancel();
    expect(sessions.get("douban")?.destroyed).toBe(true);
    expect(sessions.get("playable")?.destroyed).toBe(true);
  });

  it("aggregates search across enabled sites without losing per-source errors", async () => {
    const importer = createImporter({
      createSession: (_source, _config, site) => new SessionFixture(site.key ?? "site"),
    });
    await importer.import(JSON.stringify({
      sites: [
        { key: "douban", api: "csp_Douban" },
        { key: "playable", api: "csp_PlayableFixture" },
      ],
    }));
    importer.confirm();
    const result = await importer.aggregateSearch("QX");
    expect(result.status).toBe("complete");
    expect(result.completed).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sourceIds).toEqual(["douban", "playable"]);
    await importer.cancel();
  });

  it("resolves a playable source from a metadata-only detail", async () => {
    const importer = createImporter({
      createSession: (_source, _config, site) => new PlaybackResolverSession(site.api ?? ""),
    });
    const server = new DesktopSpiderUiServer({ importer });
    servers.push(server);
    await server.start();

    const config = JSON.stringify({
      sites: [
        { key: "douban", name: "Douban", type: 3, api: "csp_Douban", ext: "fixture" },
        { key: "playable", name: "Playable", type: 3, api: "csp_PlayableFixture", ext: "fixture" },
      ],
    });
    await post(server.url, "/api/import/load", { input: config });
    await post(server.url, "/api/import/confirm");
    await post(server.url, "/api/open");
    await post(server.url, "/api/home");
    await post(server.url, "/api/detail", { vodId: "meta-1" });

    const searched = await post(server.url, "/api/playback-sources/search");
    expect(searched.state?.playbackSources).toMatchObject({
      query: "欢迎来龙餐厅",
      candidates: [{ siteKey: "playable", playable: true }],
    });

    const selected = await post(server.url, "/api/playback-sources/select", {
      siteKey: "playable",
      vodId: "play-1",
    });
    expect(selected.state).toMatchObject({
      api: "csp_PlayableFixture",
      detail: { vod_id: "play-1" },
      playbackCatalog: { lines: [{ episodes: [{ id: "episode-1" }] }] },
    });
  });

  it("builds playback search candidates from every configured site, not the active site only", async () => {
    const importer = createImporter({
      createSession: (_source, _config, site) => new PlaybackResolverSession(site.api ?? ""),
    });
    await importer.import(JSON.stringify({
      sites: [
        { key: "douban", type: 3, api: "csp_Douban" },
        { key: "playable-1", type: 3, api: "csp_PlayableFixture" },
        { key: "playable-2", type: 3, api: "csp_PlayableFixture" },
        { key: "playable-3", type: 3, api: "csp_PlayableFixture" },
        { key: "playable-4", type: 3, api: "csp_PlayableFixture" },
      ],
    }));
    importer.confirm();

    const current: Vod = {
      id: "meta-1",
      name: "欢迎来龙餐厅",
      raw: {},
      vod_id: "meta-1",
      vod_name: "欢迎来龙餐厅",
      vod_year: "2026",
      type_name: "剧情",
    };
    const result = await importer.resolvePlaybackSources(current);

    expect(result.diagnostics).toMatchObject({
      configSiteCount: 5,
      searchableSites: 4,
      runtimeSupportedSites: 4,
      searchSuccessSites: expect.arrayContaining(["playable-1", "playable-2", "playable-3", "playable-4"]),
    });
    expect(result.candidates.filter((candidate) => candidate.playable)).toHaveLength(4);
  });

  it("routes the validated Android DEX site through RuntimeManager without a desktop binding", async () => {
    const androidRuntime = {
      kind: "android-dex",
      capabilities: {
        home: true,
        category: true,
        search: true,
        detail: true,
        playback: true,
        localProxy: false,
        filters: false,
        pagination: true,
        engine: "android-dex",
      },
      init: async () => undefined,
      search: async () => ({
        page: 1,
        items: [{ id: "android-1", name: "Shared title", raw: {}, vod_id: "android-1", vod_name: "Shared title" }],
      }),
      detail: async () => [{
        id: "android-1",
        name: "Shared title",
        raw: {},
        vod_id: "android-1",
        vod_name: "Shared title",
        vod_play_from: "UC",
        vod_play_url: "Episode 1$https://media.example.invalid/android.m3u8",
      }],
      destroy: async () => undefined,
    };
    const events: string[] = [];
    const runtimeManager = {
      prepareForSources: async () => {
        events.push("prepare");
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      supports: async (site: { api?: string }) => site.api === "csp_Duopan"
        ? {
            runtime: "android-dex",
            supported: true,
            reason: "android_dex_runtime_supported",
            capabilities: androidRuntime.capabilities,
          }
        : {
            runtime: "native",
            supported: true,
            reason: "native_supported",
      capabilities: { ...androidRuntime.capabilities, engine: "android-dex" },
          },
      getRuntime: async () => ({
        ...androidRuntime,
        init: async () => { events.push("init"); },
      }),
    } as unknown as SpiderRuntimeManagerPort;
    const importer = createImporter({ runtimeManagerFactory: () => runtimeManager });
    await importer.import(JSON.stringify({
      sites: [
        { key: "douban", type: 3, api: "csp_Douban" },
        { key: "csp_FeiMaoUC", type: 3, api: "csp_Duopan", ext: "{}" },
      ],
    }));
    importer.confirm();

    const result = await importer.resolvePlaybackSources({
      id: "meta-1",
      name: "Shared title",
      raw: {},
      vod_id: "meta-1",
      vod_name: "Shared title",
    });

    expect(result.searchedSites).toContain("csp_FeiMaoUC");
    expect(events[0]).toBe("prepare");
    expect(events).toContain("init");
    expect(result.diagnostics.sites).toContainEqual(expect.objectContaining({
      siteKey: "csp_FeiMaoUC",
      runtime: "android-dex",
      supported: true,
      initialization: "success",
      search: "success",
    }));
  });

  it("can select the JVM-native playable source for the player spike", async () => {
    const importer = createImporter();

    await importer.import(playableConfigJson());

    expect(importer.state).toMatchObject({
      status: "confirmation_required",
      selectedSiteKey: "playable",
      selectedApi: "csp_PlayableFixture",
    });
    expect(importer.selectSite("playable")).toMatchObject({
      selectedSiteKey: "playable",
      selectedApi: "csp_PlayableFixture",
    });
  });

  it("restores the persisted preferred JVM-native site without persisting its source URL", async () => {
    const importer = createImporter({ preferredSiteKey: () => "playable" });

    await importer.import(JSON.stringify({
      spider: "fixture.jar",
      sites: [
        { key: "douban", name: "Douban", type: 3, api: "csp_Douban", ext: "fixture" },
        { key: "playable", name: "Playable", type: 3, api: "csp_PlayableFixture", ext: "fixture" },
      ],
    }));

    expect(importer.state).toMatchObject({
      selectedSiteKey: "playable",
      selectedApi: "csp_PlayableFixture",
    });
  });

  it("connects import actions to the existing UI server", async () => {
    const importer = createImporter();
    const server = new DesktopSpiderUiServer({ importer });
    servers.push(server);
    await server.start();

    const initial = await fetch(server.url);
    expect(await initial.text()).toContain('data-testid="config-import-form"');

    const loaded = await post(server.url, "/api/import/load", { input: configJson() });
    expect(loaded.import.status).toBe("confirmation_required");
    expect(loaded.state).toBeNull();

    const warning = await fetch(server.url);
    expect(await warning.text()).toContain('data-testid="import-warning"');

    const confirmed = await post(server.url, "/api/import/confirm");
    expect(confirmed.import.status).toBe("ready");
    expect(confirmed.state?.status).toBe("idle");

    const opened = await post(server.url, "/api/open");
    expect(opened.state?.status).toBe("ready");
    const home = await post(server.url, "/api/home");
    expect(home.state?.items).toHaveLength(1);
    const directSearch = await post(server.url, "/api/search", { key: "QX", aggregate: false });
    const directItems = directSearch.state?.items as Array<{ vod_id?: string }> | undefined;
    expect(directItems?.[0]?.vod_id).toBe("msearch:fixture");

    const cancelled = await post(server.url, "/api/import/cancel");
    expect(cancelled.import.status).toBe("cancelled");
    expect(cancelled.state?.status).toBe("destroyed");
    const resetPage = await fetch(server.url);
    expect(await resetPage.text()).toContain('data-testid="config-import-form"');
  });

  it("persists page context and theme through the UI server without source credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-state-server-"));
    try {
      const stateStore = new JsonFileDesktopStateStore(join(directory, "desktop-state.json"));
      const importer = createImporter();
      const server = new DesktopSpiderUiServer({ importer, stateStore });
      servers.push(server);
      await server.start();

      const initial = await fetch(new URL("/api/state", server.url));
      const initialValue = await initial.json() as { persistence: Record<string, unknown> };
      expect(initialValue.persistence).toMatchObject({ theme: "dark", siteKey: null });

      await post(server.url, "/api/import/load", { input: configJson() });
      await post(server.url, "/api/import/confirm");
      await post(server.url, "/api/open");
      await post(server.url, "/api/category", { typeId: "hot_gaia", page: 2 });
      await post(server.url, "/api/search", { key: "蜘蛛侠", page: 3 });
      await post(server.url, "/api/detail", { vodId: "msearch:fixture" });
      await post(server.url, "/api/view-state", {
        theme: "dark",
        navigation: "settings",
        scrollTop: 640,
      });

      expect(stateStore.state).toMatchObject({
        theme: "dark",
        page: {
          navigation: "settings",
          siteKey: "douban",
          category: { typeId: "hot_gaia", page: 2 },
          search: { key: "蜘蛛侠", page: 3 },
          scrollTop: 640,
          recentDetailId: "msearch:fixture",
        },
      });
      expect(readFileSync(join(directory, "desktop-state.json"), "utf8")).not.toContain("fixture-endpoint");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createImporter(overrides: Partial<DesktopSpiderImportOptions> = {}): DesktopSpiderImportController {
  return new DesktopSpiderImportController({
    trustStore: new ImportTrustStore(),
    createSession: () => new SessionFixture(),
    ...overrides,
  });
}

function configJson(includeOther = false): string {
  return JSON.stringify({
    spider: "fixture.jar",
    sites: [
      ...(includeOther
        ? [{ key: "other", name: "Other", type: 3, api: "csp_Other", ext: "other" }]
        : []),
      { key: "douban", name: "Douban", type: 3, api: "csp_Douban", ext: "fixture" },
    ],
  });
}

function playableConfigJson(): string {
  return JSON.stringify({
    spider: "csp_PlayableFixture.jvm.jar",
    sites: [{
      key: "playable",
      name: "Playable fixture",
      type: 3,
      api: "csp_PlayableFixture",
      ext: "fixture-endpoint",
    }],
  });
}

class SessionFixture implements DesktopSpiderSessionPort {
  public readonly capabilities: SourceCapabilities = {
    home: true,
    category: true,
    search: true,
    detail: true,
    playback: true,
    localProxy: false,
    filters: true,
    pagination: true,
    engine: "fixture",
  };
  public destroyed = false;
  public view: DesktopSpiderView = {
    source: "inline:fixture",
    api: "csp_Douban",
    status: "idle",
    warning: null,
    error: null,
    sidecarRunning: false,
    playback: {
      available: false,
      label: "Douban：无正片播放源",
      message: "Douban 当前仅提供元数据/详情，未提供可直接播放的正片地址。",
    },
  };

  public constructor(sourceKey = "douban") {
    this.view = { ...this.view, source: `inline:${sourceKey}`, api: sourceKey };
  }

  public async open(): Promise<SpiderResponse> {
    this.view.status = "ready";
    this.view.sidecarRunning = true;
    return response({ initialized: true });
  }

  public async homeContent(): Promise<SpiderResponse> {
    return response({ list: [{ vod_id: "msearch:fixture" }] });
  }

  public async categoryContent(): Promise<SpiderResponse> {
    return response({ list: [{ vod_id: "msearch:fixture" }] });
  }

  public async searchContent(): Promise<SpiderResponse> {
    return response({ list: [{ vod_id: "msearch:fixture", vod_name: "Shared title", vod_year: "2024" }] });
  }

  public async detailContent(ids: string[]): Promise<SpiderResponse> {
    return response({ list: [{ vod_id: ids[0], vod_name: "Fixture" }] });
  }

  public async playerContent(): Promise<SpiderResponse> {
    return response({
      parse: 0,
      url: "https://media.example.invalid/fixture.m3u8",
      header: { "User-Agent": "Spike19" },
    });
  }

  public confirmImport(): void {
    this.view.status = "idle";
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.view.status = "destroyed";
    this.view.sidecarRunning = false;
  }
}

class PlaybackResolverSession extends SessionFixture {
  public constructor(api: string) {
    super(api);
  }

  public override async open(): Promise<SpiderResponse> {
    if (this.view.status === "ready") throw new Error("session already open");
    return super.open();
  }

  public override async homeContent(): Promise<SpiderResponse> {
    return response({ list: [{
      vod_id: "meta-1",
      vod_name: "欢迎来龙餐厅",
      vod_year: "2026",
      type_name: "剧情",
    }] });
  }

  public override async searchContent(): Promise<SpiderResponse> {
    return response({ list: [{
      vod_id: "play-1",
      vod_name: "欢迎来龙餐厅",
      vod_year: "2026",
      type_name: "剧情",
    }] });
  }

  public override async detailContent(ids: string[]): Promise<SpiderResponse> {
    const item: Record<string, unknown> = {
      vod_id: ids[0],
      vod_name: "欢迎来龙餐厅",
      vod_year: "2026",
      type_name: "剧情",
    };
    if (this.view.api === "csp_PlayableFixture") {
      item.vod_play_from = "主线";
      item.vod_play_url = "第一集$episode-1";
    }
    return response({ list: [item] });
  }
}

function response(result: unknown): SpiderResponse {
  return { id: "fixture", ok: true, result };
}

async function post(
  base: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{
  import: Record<string, unknown>;
  state: Record<string, unknown> | null;
  persistence?: Record<string, unknown>;
}> {
  const result = await fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(result.status).toBe(200);
  return await result.json() as {
    import: Record<string, unknown>;
    state: Record<string, unknown> | null;
    persistence?: Record<string, unknown>;
  };
}
