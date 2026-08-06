import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { parseTvBoxConfig } from "../config/decoder.js";
import { JsonFileTrustPersistence, ImportTrustStore } from "../config/trust.js";
import {
  DesktopSpiderUiController,
  DesktopSpiderUiServer,
  type DesktopSpiderUiState,
} from "../desktop/spider-ui.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import { DesktopSpiderClient } from "../spider/desktop-client.js";
import type { SpiderResponse } from "../spider/rpc.js";
import { defaultDoubanEndpoint } from "./douban-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runDoubanDesktopUiProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "desktop-jvm-csp-douban-ui",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  const endpoint = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;
  const source = process.env.QX_DOUBAN_CONFIG_SOURCE
    ?? "https://example.invalid/fongmi-config.json";
  const trustDirectory = mkdtempSync(join(tmpdir(), "qx-desktop-ui-"));
  const trustPath = join(trustDirectory, "trusted-sources.json");
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let ui: DesktopSpiderUiController | undefined;
  let server: DesktopSpiderUiServer | undefined;

  try {
    artifacts = await buildJvmArtifacts();
    const config = parseTvBoxConfig(JSON.stringify({
      spider: "csp_Douban.jvm.jar",
      sites: [{ key: "douban", name: "Douban", type: 3, api: "csp_Douban" }],
    }));
    const trustStore = new ImportTrustStore(new JsonFileTrustPersistence(trustPath));
    const createSession = () => new DesktopSpiderSession({
      source,
      config,
      trustStore,
      requestTimeoutMs: 30_000,
      createClient: (site) => new DesktopSpiderClient({
        api: site.api ?? "",
        javaExecutable,
        hostJar: artifacts?.hostJar ?? "",
        spiderJar: artifacts?.spiderJar ?? "",
        spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
        requestTimeoutMs: 30_000,
      }),
    });
    ui = new DesktopSpiderUiController({
      session: createSession(),
      createSession,
    });
    server = new DesktopSpiderUiServer({
      ui,
      siteKey: "douban",
      ext: endpoint,
    });
    await server.start();

    const initialPage = await fetch(server.url);
    const initialHtml = await initialPage.text();
    const initialWarning = initialPage.status === 200
      && initialHtml.includes('data-testid="import-warning"');
    const initialPlaybackDisabled = initialHtml.includes("Douban：无正片播放源")
      && /data-testid="play-button" disabled/.test(initialHtml);

    const confirmed = await post(server.url, "/api/import/confirm");
    const opened = await post(server.url, "/api/open");
    const home = await post(server.url, "/api/home");
    const category = await post(server.url, "/api/category", {
      typeId: "hot_gaia",
      page: 1,
      filter: false,
    });
    const search = await post(server.url, "/api/search", {
      key: "蜘蛛侠",
      quick: false,
      page: 1,
    });
    const firstVodId = firstVodIdFrom(search.state);
    const detail = await post(server.url, "/api/detail", { vodId: firstVodId });
    const detailPage = await fetch(server.url);
    const detailHtml = await detailPage.text();
    const runningBeforeClose = detail.state.sidecarRunning;
    const closed = await post(server.url, "/api/close");
    const passed = initialWarning
      && initialPlaybackDisabled
      && confirmed.state.status === "idle"
      && opened.state.status === "ready"
      && listCount(home.state) > 0
      && listCount(category.state) > 0
      && listCount(search.state) > 0
      && detail.state.page === "detail"
      && detail.state.detail?.vod_id === firstVodId
      && detailHtml.includes('data-testid="detail-panel"')
      && detailHtml.includes("Douban：无正片播放源")
      && /data-testid="play-button" disabled/.test(detailHtml)
      && runningBeforeClose
      && closed.state.status === "destroyed"
      && !closed.state.sidecarRunning;

    return {
      probe: "desktop-jvm-csp-douban-ui",
      status: passed ? ("passed" as const) : ("failed" as const),
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      ui: {
        url: server.url,
        initialWarning,
        initialPlaybackDisabled,
      },
      calls: {
        confirmed: confirmed.state.status,
        opened: opened.state.status,
        home: listCount(home.state),
        category: listCount(category.state),
        search: {
          listCount: listCount(search.state),
          firstVodId,
        },
        detail: {
          page: detail.state.page,
          vodId: detail.state.detail?.vod_id,
          name: detail.state.detail?.vod_name,
        },
      },
      playback: detail.state.playback,
      lifecycle: {
        runningBeforeClose,
        statusAfterClose: closed.state.status,
        sidecarStopped: !closed.state.sidecarRunning,
      },
    };
  } catch (error) {
    return {
      probe: "desktop-jvm-csp-douban-ui",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (server) await server.close();
    } finally {
      try {
        if (artifacts) await removeJvmArtifacts(artifacts);
      } finally {
        rmSync(trustDirectory, { recursive: true, force: true });
      }
    }
  }
}

async function post(
  baseUrl: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ state: DesktopSpiderUiState }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || !isRecord(value.state)) {
    throw new Error(`UI request failed: ${path}`);
  }
  return { state: value.state as unknown as DesktopSpiderUiState };
}

function listCount(state: DesktopSpiderUiState): number {
  return state.items.length;
}

function firstVodIdFrom(state: DesktopSpiderUiState): string {
  const first = state.items[0];
  if (!first || typeof first.vod_id !== "string") {
    throw new Error("UI search returned no vod_id");
  }
  return first.vod_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-desktop-ui-probe.ts")) {
  runDoubanDesktopUiProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
