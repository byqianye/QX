import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { JsonFileTrustPersistence, ImportTrustStore } from "../config/trust.js";
import {
  DesktopSpiderImportController,
  type DesktopSpiderImportState,
} from "../desktop/spider-import.js";
import { DesktopSpiderUiServer } from "../desktop/spider-ui.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import { DesktopSpiderClient } from "../spider/desktop-client.js";
import { defaultDoubanEndpoint } from "./douban-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runDoubanDesktopImportProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "desktop-jvm-csp-douban-import",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  const endpoint = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;
  const sourceInput = JSON.stringify({
    spider: "csp_Douban.jvm.jar",
    sites: [{
      key: "douban",
      name: "Douban",
      type: 3,
      api: "csp_Douban",
      ext: endpoint,
    }],
  });
  const trustDirectory = mkdtempSync(join(tmpdir(), "qx-desktop-import-"));
  const trustPath = join(trustDirectory, "trusted-sources.json");
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let importer: DesktopSpiderImportController | undefined;
  let server: DesktopSpiderUiServer | undefined;
  let createdSessions = 0;

  try {
    artifacts = await buildJvmArtifacts();
    const trustStore = new ImportTrustStore(new JsonFileTrustPersistence(trustPath));
    const createSession = (source: string, config: TvBoxConfig, site: TvBoxSite) => {
      createdSessions += 1;
      return createImportSession(source, config, site, trustStore, javaExecutable, artifacts);
    };
    importer = new DesktopSpiderImportController({
      trustStore,
      requestTimeoutMs: 30_000,
      createSession,
    });
    server = new DesktopSpiderUiServer({ importer });
    await server.start();

    const initial = await fetch(server.url);
    const initialHtml = await initial.text();
    const initialImportForm = initial.status === 200
      && initialHtml.includes('data-testid="config-import-form"');

    const loaded = await post(server.url, "/api/import/load", { input: sourceInput });
    const warningHtmlResponse = await fetch(server.url);
    const warningHtml = await warningHtmlResponse.text();
    const warningShown = warningHtml.includes('data-testid="import-warning"');
    const noSessionBeforeConfirm = createdSessions === 0 && loaded.state === null;

    const selected = await post(server.url, "/api/import/select", { siteKey: "douban" });
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
    const runningBeforeClose = Boolean(detail.state?.sidecarRunning);
    const closed = await post(server.url, "/api/import/cancel");

    const reloadedTrustStore = new ImportTrustStore(new JsonFileTrustPersistence(trustPath));
    const repeatedImporter = new DesktopSpiderImportController({
      trustStore: reloadedTrustStore,
      requestTimeoutMs: 30_000,
      createSession,
    });
    const repeated = await repeatedImporter.import(sourceInput);
    const repeatedNoWarning = repeated.status === "ready"
      && repeated.trusted
      && repeatedImporter.session?.view.status === "idle";
    await repeatedImporter.cancel();

    const passed = initialImportForm
      && loaded.import.status === "confirmation_required"
      && warningShown
      && noSessionBeforeConfirm
      && selected.import.selectedSiteKey === "douban"
      && confirmed.import.status === "ready"
      && confirmed.state?.status === "idle"
      && opened.state?.status === "ready"
      && listCount(home.state) > 0
      && listCount(category.state) > 0
      && listCount(search.state) > 0
      && detail.state?.page === "detail"
      && detail.state.detail?.vod_id === firstVodId
      && detail.state.playback.available === false
      && runningBeforeClose
      && closed.import.status === "cancelled"
      && closed.state?.status === "destroyed"
      && repeatedNoWarning;

    return {
      probe: "desktop-jvm-csp-douban-import",
      status: passed ? ("passed" as const) : ("failed" as const),
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      input: {
        kind: "json",
        warningShown,
        noSessionBeforeConfirm,
        selectedSite: selected.import.selectedSiteKey,
        repeatedNoWarning,
      },
      calls: {
        confirmed: confirmed.state?.status,
        opened: opened.state?.status,
        home: listCount(home.state),
        category: listCount(category.state),
        search: { listCount: listCount(search.state), firstVodId },
        detail: {
          page: detail.state?.page,
          vodId: detail.state?.detail?.vod_id,
          name: detail.state?.detail?.vod_name,
        },
      },
      playback: detail.state?.playback,
      lifecycle: {
        runningBeforeClose,
        statusAfterClose: closed.state?.status,
        sidecarStopped: closed.state?.status === "destroyed",
      },
      createdSessions,
    };
  } catch (error) {
    return {
      probe: "desktop-jvm-csp-douban-import",
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
        if (importer) await importer.close();
      } finally {
        try {
          if (artifacts) await removeJvmArtifacts(artifacts);
        } finally {
          rmSync(trustDirectory, { recursive: true, force: true });
        }
      }
    }
  }
}

function createImportSession(
  source: string,
  config: TvBoxConfig,
  site: TvBoxSite,
  trustStore: ImportTrustStore,
  javaExecutable: string,
  artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined,
): DesktopSpiderSession {
  return new DesktopSpiderSession({
    source,
    config,
    trustStore,
    requestTimeoutMs: 30_000,
    createClient: () => new DesktopSpiderClient({
      api: site.api ?? "",
      javaExecutable,
      hostJar: artifacts?.hostJar ?? "",
      spiderJar: artifacts?.spiderJar ?? "",
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      requestTimeoutMs: 30_000,
    }),
  });
}

async function post(
  baseUrl: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{
  import: DesktopSpiderImportState;
  state: UiState | null;
}> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || !isRecord(value.import)) {
    throw new Error(`UI import request failed: ${path}`);
  }
  return value as unknown as {
    import: DesktopSpiderImportState;
    state: UiState | null;
  };
}

interface UiState {
  page: string;
  status: string;
  sidecarRunning: boolean;
  playback: { available: false };
  items: readonly Record<string, unknown>[];
  detail: Record<string, unknown> | null;
}

function listCount(state: UiState | null): number {
  return state?.items.length ?? 0;
}

function firstVodIdFrom(state: UiState | null): string {
  const first = state?.items[0];
  if (!first || typeof first.vod_id !== "string") throw new Error("UI search returned no vod_id");
  return first.vod_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-desktop-import-probe.ts")) {
  runDoubanDesktopImportProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
