import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { parseTvBoxConfig } from "../config/decoder.js";
import { JsonFileTrustPersistence, ImportTrustStore } from "../config/trust.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import type { SpiderResponse } from "../spider/rpc.js";
import { DesktopSpiderClient } from "../spider/desktop-client.js";
import { defaultDoubanEndpoint } from "./douban-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runDoubanDesktopSessionProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "desktop-jvm-csp-douban-session",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  const endpoint = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;
  const source = process.env.QX_DOUBAN_CONFIG_SOURCE
    ?? "https://example.invalid/fongmi-config.json";
  const trustDirectory = mkdtempSync(join(tmpdir(), "qx-desktop-session-"));
  const trustPath = join(trustDirectory, "trusted-sources.json");
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let session: DesktopSpiderSession | undefined;
  let warningShown = false;
  let trustPersisted = false;

  try {
    artifacts = await buildJvmArtifacts();
    const config = parseTvBoxConfig(JSON.stringify({
      spider: "csp_Douban.jvm.jar",
      sites: [{ key: "douban", name: "Douban", type: 3, api: "csp_Douban" }],
    }));
    const trustStore = new ImportTrustStore(new JsonFileTrustPersistence(trustPath));
    session = new DesktopSpiderSession({
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

    warningShown = session.view.status === "confirmation_required"
      && Boolean(session.view.warning);
    session.confirmImport();
    const reloadedTrustStore = new ImportTrustStore(
      new JsonFileTrustPersistence(trustPath),
    );
    const reloadedSession = new DesktopSpiderSession({
      source,
      config,
      trustStore: reloadedTrustStore,
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
    trustPersisted = reloadedTrustStore.isTrusted(source);
    const reopenedWithoutWarning = reloadedSession.view.status === "idle";
    await reloadedSession.destroy();

    const init = requireJsonResult(await session.open("douban", endpoint), "init");
    const home = summarizeList(
      requireJsonResult(await session.homeContent(false), "homeContent"),
    );
    const category = summarizeList(
      requireJsonResult(
        await session.categoryContent("hot_gaia", 1, false, {}),
        "categoryContent",
      ),
    );
    const searchResponse = requireJsonResult(
      await session.searchContent("蜘蛛侠", false, 1),
      "searchContent",
    );
    const search = summarizeSearch(searchResponse);
    const detail = summarizeDetail(
      requireJsonResult(await session.detailContent([search.firstVodId]), "detailContent"),
      search.firstVodId,
    );

    const view = session.view;
    const runningBeforeDestroy = view.sidecarRunning;
    await session.destroy();
    const passed = warningShown
      && trustPersisted
      && init.ok
      && reopenedWithoutWarning
      && home.listCount > 0
      && category.listCount > 0
      && search.listCount > 0
      && detail.vodId === search.firstVodId
      && view.playback.available === false
      && view.sidecarRunning;

    return {
      probe: "desktop-jvm-csp-douban-session",
      status: passed ? ("passed" as const) : ("failed" as const),
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      config: { source, api: "csp_Douban", route: "DesktopSpiderClient" },
      importTrust: { warningShown, trustPersisted, reopenedWithoutWarning },
      calls: { init, home, category, search, detail },
      playback: view.playback,
      sidecar: { runningBeforeDestroy, stopped: !session.view.sidecarRunning },
    };
  } catch (error) {
    return {
      probe: "desktop-jvm-csp-douban-session",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      config: { source, api: "csp_Douban", route: "DesktopSpiderClient" },
      importTrust: { warningShown, trustPersisted },
      sidecar: { runningBeforeDestroy: session?.view.sidecarRunning ?? false },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (session) await session.destroy();
    } finally {
      try {
        if (artifacts) await removeJvmArtifacts(artifacts);
      } finally {
        rmSync(trustDirectory, { recursive: true, force: true });
      }
    }
  }
}

function requireJsonResult(response: SpiderResponse, method: string): SpiderResponse {
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "unknown error"}`);
  }
  return response;
}

function summarizeList(response: SpiderResponse): { listCount: number; firstVodId: unknown } {
  if (!isRecord(response.result)) throw new Error("Spider result is not an object");
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const first = list.find(isRecord);
  return { listCount: list.length, firstVodId: first?.vod_id };
}

function summarizeSearch(response: SpiderResponse): {
  listCount: number;
  firstVodId: string;
  total: unknown;
} {
  if (!isRecord(response.result)) throw new Error("searchContent result is not an object");
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const first = list.find(isRecord);
  if (!first || typeof first.vod_id !== "string") {
    throw new Error("searchContent returned no msearch id");
  }
  return { listCount: list.length, firstVodId: first.vod_id, total: response.result.total };
}

function summarizeDetail(response: SpiderResponse, expectedVodId: string): {
  vodId: unknown;
  name: unknown;
  contentLength: number;
} {
  if (!isRecord(response.result)) throw new Error("detailContent result is not an object");
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const first = list.find(isRecord);
  if (!first) throw new Error("detailContent returned no item");
  if (first.vod_id !== expectedVodId) {
    throw new Error(`detailContent returned unexpected vod_id: ${String(first.vod_id)}`);
  }
  return {
    vodId: first.vod_id,
    name: first.vod_name,
    contentLength: typeof first.vod_content === "string" ? first.vod_content.length : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-desktop-session-probe.ts")) {
  runDoubanDesktopSessionProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
