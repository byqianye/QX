import { basename } from "node:path";

import { resolveJavaExecutable } from "./java-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { JvmSidecar } from "../spider/jvm-sidecar.js";
import type { SpiderResponse } from "../spider/rpc.js";

export const sourceDoubanHomeEndpoint =
  "http://api.douban.com/api/v2/subject_collection/subject_real_time_hotest/items"
  + "?apikey=0ac44ae016490db2204ce0a042db2916";
export const defaultDoubanEndpoint =
  "https://frodo.douban.com/api/v2/subject_collection/subject_real_time_hotest/items"
  + "?apikey=0ac44ae016490db2204ce0a042db2916";

const categoryCases: Array<{
  typeId: string;
  page: number;
  extend: Record<string, string>;
}> = [
  { typeId: "hot_gaia", page: 1, extend: { sort: "recommend", area: "全部" } },
  { typeId: "tv_hot", page: 1, extend: { type: "tv_hot" } },
  { typeId: "show_hot", page: 1, extend: { type: "show_hot" } },
  { typeId: "movie", page: 1, extend: { sort: "T", 类型: "" } },
  { typeId: "tv", page: 1, extend: { sort: "T", 类型: "" } },
  { typeId: "rank_list_movie", page: 1, extend: { 榜单: "movie_real_time_hotest" } },
  { typeId: "rank_list_tv", page: 1, extend: { 榜单: "tv_real_time_hotest" } },
];

export async function runDoubanProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "jvm-native-csp-douban",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  const sourceUrl = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;

  try {
    artifacts = await buildJvmArtifacts();
    const configuredSidecar = new JvmSidecar({
      javaExecutable,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      requestTimeoutMs: 30_000,
    });
    let pid: number | null = null;
    let stopped = false;
    let initResponse: SpiderResponse;
    let homeResponse: SpiderResponse;
    let categoryResults: CategoryProbeResult[] = [];
    try {
      await configuredSidecar.start();
      pid = configuredSidecar.pid;
      initResponse = requireJsonResult(await configuredSidecar.init(sourceUrl, 1_000), "init");
      homeResponse = requireJsonResult(
        await configuredSidecar.homeContent(false),
        "homeContent",
      );
      categoryResults = await probeCategories(configuredSidecar);
    } finally {
      await configuredSidecar.destroy();
      stopped = !configuredSidecar.isRunning;
    }

    const home = summarizeHome(homeResponse);
    const categoriesPassed = categoryResults.length === categoryCases.length
      && categoryResults.every((result) => result.status === "passed");
    const passed = stopped && home.classCount === 7 && home.listCount > 0 && categoriesPassed;
    return {
      probe: "jvm-native-csp-douban",
      status: passed ? "passed" as const : "failed" as const,
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      contract: {
        init: "init(String ext)",
        home: "String homeContent(boolean filter)",
        destroy: "destroy()",
      },
      transport: "NDJSON",
      classLoading: "URLClassLoader + reflection",
      httpClient: "java.net.http.HttpClient",
      sourceEndpointFromDex: sourceDoubanHomeEndpoint,
      sourceUrl,
      initResponse: summarizeResponse(initResponse),
      homeContent: home,
      categoryContent: categoryResults,
      sidecar: { pid, stopped },
      decision: {
        jvmNative: "viable for the extracted homeContent and categoryContent paths",
        androidDex: "not required for this minimum slice",
      },
    };
  } catch (error) {
    return {
      probe: "jvm-native-csp-douban",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      sourceEndpointFromDex: sourceDoubanHomeEndpoint,
      sourceUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (artifacts) await removeJvmArtifacts(artifacts);
  }
}

interface CategoryProbeResult {
  typeId: string;
  status: "passed" | "failed";
  page?: number;
  pagecount?: number;
  limit?: number;
  total?: number;
  listCount?: number;
  sample?: unknown[];
  error?: string;
}

async function probeCategories(sidecar: JvmSidecar): Promise<CategoryProbeResult[]> {
  const results: CategoryProbeResult[] = [];
  for (const current of categoryCases) {
    try {
      const response = requireJsonResult(
        await sidecar.categoryContent(
          current.typeId,
          current.page,
          true,
          current.extend,
        ),
        `categoryContent(${current.typeId})`,
      );
      if (!isRecord(response.result)) {
        throw new Error("categoryContent did not return a JSON object");
      }
      const list = Array.isArray(response.result.list) ? response.result.list : [];
      results.push({
        typeId: current.typeId,
        status: "passed",
        page: requiredNumber(response.result.page, "page"),
        pagecount: requiredNumber(response.result.pagecount, "pagecount"),
        limit: requiredNumber(response.result.limit, "limit"),
        total: requiredNumber(response.result.total, "total"),
        listCount: list.length,
        sample: list.slice(0, 1),
      });
    } catch (error) {
      results.push({
        typeId: current.typeId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
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

function summarizeResponse(response: SpiderResponse) {
  if (!response.ok) return response;
  return { id: response.id, ok: true, result: response.result };
}

function summarizeHome(response: SpiderResponse) {
  if (!response.ok || !isRecord(response.result)) {
    throw new Error("homeContent did not return a JSON object");
  }
  const classes = Array.isArray(response.result.class) ? response.result.class : [];
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  return {
    classCount: classes.length,
    categories: classes,
    listCount: list.length,
    sample: list.slice(0, 1),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  throw new Error(`categoryContent result is missing numeric ${field}`);
}

if (process.argv[1]?.endsWith("douban-probe.ts")) {
  runDoubanProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
