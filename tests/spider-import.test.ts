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
      await urlImporter.import("https://example.invalid/config.json");
      expect(fetchedUrl).toBe("https://example.invalid/config.json");
      expect(urlImporter.state).toMatchObject({
        inputKind: "url",
        sourceKind: "remote",
        source: "https://example.invalid/config.json",
      });
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
      expect(initialValue.persistence).toMatchObject({ theme: "light", siteKey: null });

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
    return response({ list: [{ vod_id: "msearch:fixture" }] });
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
