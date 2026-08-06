import { basename } from "node:path";

import { JvmSidecar } from "../spider/jvm-sidecar.js";
import type { SpiderResponse } from "../spider/rpc.js";
import { defaultDoubanEndpoint } from "./douban-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runDoubanSearchSidecarProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "jvm-native-douban-search",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  const endpoint = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;
  const keyword = process.env.QX_DOUBAN_SEARCH_KEY ?? "蜘蛛侠";
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let sidecar: JvmSidecar | undefined;
  let pid: number | null = null;
  let stopped = false;

  try {
    artifacts = await buildJvmArtifacts();
    sidecar = new JvmSidecar({
      javaExecutable,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      requestTimeoutMs: 30_000,
    });

    let pageOne: SpiderResponse;
    let pageTwo: SpiderResponse;
    try {
      await sidecar.start();
      pid = sidecar.pid;
      requireJsonResult(await sidecar.init(endpoint, 1_000), "init");
      pageOne = requireJsonResult(
        await sidecar.searchContent(keyword, false, 1),
        "searchContent(page=1)",
      );
      pageTwo = requireJsonResult(
        await sidecar.searchContent(keyword, false, 2),
        "searchContent(page=2)",
      );
    } finally {
      await sidecar.destroy();
      stopped = !sidecar.isRunning;
    }

    const first = summarizePage(pageOne);
    const second = summarizePage(pageTwo);
    const passed = stopped
      && first.listCount > 0
      && second.listCount > 0
      && first.page === 1
      && second.page === 2
      && first.pagecount >= 2
      && isMsearchId(first.firstVodId)
      && isMsearchId(second.firstVodId)
      && first.firstVodId !== second.firstVodId;
    return {
      probe: "jvm-native-douban-search",
      status: passed ? "passed" as const : "failed" as const,
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      transport: "NDJSON",
      contract: {
        init: "init(String ext)",
        search: "String searchContent(String key, boolean quick, int page)",
        pageSize: 15,
        idRule: "msearch:<id>",
      },
      endpoint,
      keyword,
      pageOne: first,
      pageTwo: second,
      sidecar: { pid, stopped },
    };
  } catch (error) {
    return {
      probe: "jvm-native-douban-search",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      endpoint,
      keyword,
      sidecar: { pid, stopped },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (artifacts) await removeJvmArtifacts(artifacts);
  }
}

function requireJsonResult(response: SpiderResponse, method: string): SpiderResponse {
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "unknown error"}`);
  }
  if (!Object.prototype.hasOwnProperty.call(response, "result")) {
    throw new Error(`${method} returned no JSON result`);
  }
  return response;
}

function summarizePage(response: SpiderResponse) {
  if (!isRecord(response.result)) {
    throw new Error("searchContent did not return a JSON object");
  }
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const items = list.filter(isRecord).map((item) => ({
    vodId: item.vod_id,
    name: item.vod_name,
    rating: item.vod_remarks,
    cover: item.vod_pic,
  }));
  return {
    page: requiredNumber(response.result.page, "page"),
    pagecount: requiredNumber(response.result.pagecount, "pagecount"),
    limit: requiredNumber(response.result.limit, "limit"),
    total: requiredNumber(response.result.total, "total"),
    listCount: items.length,
    firstVodId: items[0]?.vodId,
    sample: items.slice(0, 3),
  };
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  throw new Error(`searchContent result is missing numeric ${field}`);
}

function isMsearchId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("msearch:");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-search-sidecar-probe.ts")) {
  runDoubanSearchSidecarProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
