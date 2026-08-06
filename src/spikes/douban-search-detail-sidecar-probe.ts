import { basename } from "node:path";

import { DesktopSpiderClient } from "../spider/desktop-client.js";
import type { SpiderResponse } from "../spider/rpc.js";
import { defaultDoubanEndpoint } from "./douban-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runDoubanSearchDetailSidecarProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "jvm-native-douban-search-detail",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  const endpoint = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;
  const keyword = process.env.QX_DOUBAN_SEARCH_KEY ?? "蜘蛛侠";
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let client: DesktopSpiderClient | undefined;
  let pid: number | null = null;
  let stopped = false;

  try {
    artifacts = await buildJvmArtifacts();
    client = new DesktopSpiderClient({
      api: "csp_Douban",
      javaExecutable,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      requestTimeoutMs: 30_000,
    });

    let search: SearchSummary;
    let detail: DetailSummary;
    try {
      requireJsonResult(await client.init(endpoint, 1_000), "init");
      pid = client.pid;
      search = summarizeSearch(
        requireJsonResult(
          await client.searchContent(keyword, false, 1),
          "searchContent",
        ),
      );
      detail = summarizeDetail(
        requireJsonResult(
          await client.detailContent([search.firstVodId]),
          "detailContent",
        ),
        search.firstVodId,
      );
    } finally {
      await client.destroy();
      stopped = !client.isRunning;
    }

    const passed = stopped
      && search.listCount > 0
      && isMsearchId(search.firstVodId)
      && detail.vodId === search.firstVodId
      && Boolean(
        detail.name
        && detail.cover
        && detail.rating
        && detail.year
        && detail.area
        && detail.class
        && detail.contentLength > 0,
      );
    return {
      probe: "jvm-native-douban-search-detail",
      status: passed ? "passed" as const : "failed" as const,
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      transport: "NDJSON",
      contract: {
        api: "csp_Douban",
        desktopClient: "DesktopSpiderClient",
        search: "String searchContent(String key, boolean quick, int page)",
        detail: "String detailContent(List<String> ids)",
        chain: "search result vod_id -> detail ids",
        detailRouting: "movie/<id> first, tv/<id> on failure",
      },
      endpoint,
      keyword,
      search,
      detail,
      sidecar: { pid, stopped },
    };
  } catch (error) {
    return {
      probe: "jvm-native-douban-search-detail",
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

interface SearchSummary {
  page: number;
  pagecount: number;
  limit: number;
  total: number;
  listCount: number;
  firstVodId: string;
  firstName: string;
  firstRating: unknown;
}

interface DetailSummary {
  vodId: unknown;
  name: string;
  cover: string;
  rating: unknown;
  contentLength: number;
  year: unknown;
  area: unknown;
  class: unknown;
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

function summarizeSearch(response: SpiderResponse): SearchSummary {
  if (!isRecord(response.result)) throw new Error("searchContent did not return an object");
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const first = list.find(isRecord);
  if (!first || typeof first.vod_id !== "string" || typeof first.vod_name !== "string") {
    throw new Error("searchContent returned no usable first result");
  }
  return {
    page: requiredNumber(response.result.page, "page"),
    pagecount: requiredNumber(response.result.pagecount, "pagecount"),
    limit: requiredNumber(response.result.limit, "limit"),
    total: requiredNumber(response.result.total, "total"),
    listCount: list.length,
    firstVodId: first.vod_id,
    firstName: first.vod_name,
    firstRating: first.vod_remarks,
  };
}

function summarizeDetail(response: SpiderResponse, expectedId: string): DetailSummary {
  if (!isRecord(response.result)) throw new Error("detailContent did not return an object");
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const first = list.find(isRecord);
  if (!first) throw new Error("detailContent returned no result");
  if (first.vod_id !== expectedId) {
    throw new Error(`detailContent returned unexpected vod_id: ${String(first.vod_id)}`);
  }
  return {
    vodId: first.vod_id,
    name: typeof first.vod_name === "string" ? first.vod_name : "",
    cover: typeof first.vod_pic === "string" ? first.vod_pic : "",
    rating: first.vod_remarks,
    contentLength: typeof first.vod_content === "string" ? first.vod_content.length : 0,
    year: first.vod_year,
    area: first.vod_area,
    class: first.vod_class,
  };
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  throw new Error(`searchContent result is missing numeric ${field}`);
}

function isMsearchId(value: string): boolean {
  return value.startsWith("msearch:") && value.length > "msearch:".length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-search-detail-sidecar-probe.ts")) {
  runDoubanSearchDetailSidecarProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
