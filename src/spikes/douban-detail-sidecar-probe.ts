import { basename } from "node:path";

import { JvmSidecar } from "../spider/jvm-sidecar.js";
import type { SpiderResponse } from "../spider/rpc.js";
import { defaultDoubanEndpoint } from "./douban-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runDoubanDetailSidecarProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "jvm-native-douban-detail",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  const endpoint = process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint;
  const movieId = process.env.QX_DOUBAN_MOVIE_ID ?? "36246195";
  const tvId = process.env.QX_DOUBAN_TV_ID ?? "36721173";
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

    let detailResponse: SpiderResponse;
    try {
      await sidecar.start();
      pid = sidecar.pid;
      requireJsonResult(await sidecar.init(endpoint, 1_000), "init");
      detailResponse = requireJsonResult(
        await sidecar.detailContent([`msearch:${movieId}`, `msearch:${tvId}`]),
        "detailContent",
      );
    } finally {
      await sidecar.destroy();
      stopped = !sidecar.isRunning;
    }

    const detail = summarizeDetail(detailResponse, [movieId, tvId]);
    return {
      probe: "jvm-native-douban-detail",
      status: stopped && detail.moviePassed && detail.tvPassed
        ? ("passed" as const)
        : ("failed" as const),
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      transport: "NDJSON",
      contract: {
        init: "init(String ext)",
        detail: "String detailContent(List<String> ids)",
        idRule: "msearch:<id>; movie endpoint first, tv endpoint on failure",
      },
      endpoint,
      detail,
      sidecar: { pid, stopped },
    };
  } catch (error) {
    return {
      probe: "jvm-native-douban-detail",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      endpoint,
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

function summarizeDetail(response: SpiderResponse, ids: string[]) {
  if (!isRecord(response.result)) {
    throw new Error("detailContent did not return a JSON object");
  }
  const list = Array.isArray(response.result.list) ? response.result.list : [];
  const items = list.filter(isRecord).map((item) => ({
    vodId: item.vod_id,
    name: item.vod_name,
    year: item.vod_year,
    rating: item.vod_remarks,
    area: item.vod_area,
    class: item.vod_class,
    director: item.vod_director,
    actor: item.vod_actor,
    contentLength: typeof item.vod_content === "string" ? item.vod_content.length : 0,
    total: item.vod_total,
  }));
  const movie = items.find((item) => item.vodId === `msearch:${ids[0]}`);
  const tv = items.find((item) => item.vodId === `msearch:${ids[1]}`);
  return {
    count: items.length,
    items,
    moviePassed: Boolean(movie?.name && movie.contentLength > 0),
    tvPassed: Boolean(tv?.name && tv.contentLength > 0 && tv.total),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-detail-sidecar-probe.ts")) {
  runDoubanDetailSidecarProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
