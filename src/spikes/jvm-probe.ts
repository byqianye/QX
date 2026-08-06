import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";

import { resolveJavaExecutable } from "./java-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { JvmSidecar } from "../spider/jvm-sidecar.js";
import type { SpiderResponse } from "../spider/rpc.js";

export const defaultJvmHttpSpiderUrl = "https://api.tvmaze.com/search/shows?q=girls";

export async function runJvmProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "jvm-native-http-spider",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let delayServer: DelayServer | undefined;
  try {
    artifacts = await buildJvmArtifacts();
    delayServer = await startDelayServer();
    const sourceUrl = process.env.QX_JVM_SPIDER_URL ?? defaultJvmHttpSpiderUrl;

    const normal = createSidecar(artifacts, javaExecutable, 30_000);
    let normalPid: number | null = null;
    let normalStopped = false;
    let initResponse: SpiderResponse;
    let homeResponse: SpiderResponse;
    try {
      await normal.start();
      normalPid = normal.pid;
      initResponse = requireJsonResult(await normal.init(sourceUrl, 1_000), "init");
      homeResponse = requireJsonResult(
        await normal.homeContent(false),
        "home",
      );
    } finally {
      await normal.destroy();
      normalStopped = !normal.isRunning;
    }

    const timeoutSidecar = createSidecar(artifacts, javaExecutable, 75);
    const delayedUrl = `${delayServer.url}?delayMs=250`;
    let timeoutPid: number | null = null;
    let timeoutError: { name: string; message: string } | null = null;
    try {
      await timeoutSidecar.start();
      timeoutPid = timeoutSidecar.pid;
      requireJsonResult(await timeoutSidecar.init(delayedUrl, 1_000), "timeout init");
      await timeoutSidecar.homeContent(false);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      timeoutError = { name: normalized.name, message: normalized.message };
    } finally {
      await timeoutSidecar.destroy();
    }

    const timeoutIsolated = timeoutError?.name === "JvmSidecarTimeoutError"
      && !timeoutSidecar.isRunning;
    const processIsolated = normalPid !== null && timeoutPid !== null && normalPid !== timeoutPid;

    return {
      probe: "jvm-native-http-spider",
      status: normalStopped && timeoutIsolated && processIsolated
        ? "passed" as const
        : "failed" as const,
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      contract: {
        init: "init(String ext)",
        home: "String homeContent(boolean filter)",
        destroy: "destroy()",
      },
      transport: "NDJSON",
      classLoading: "URLClassLoader + reflection",
      httpClient: "java.net.http.HttpClient",
      sourceUrl,
      initResponse: summarizeResponse(initResponse),
      homeResponse: summarizeResponse(homeResponse),
      normalPid,
      normalStopped,
      timeout: {
        pid: timeoutPid,
        error: timeoutError,
        sidecarStopped: !timeoutSidecar.isRunning,
      },
      processIsolated,
    };
  } catch (error) {
    return {
      probe: "jvm-native-http-spider",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (delayServer) await delayServer.close();
    if (artifacts) await removeJvmArtifacts(artifacts);
  }
}

function createSidecar(
  artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>>,
  javaExecutable: string,
  requestTimeoutMs = 1_000,
): JvmSidecar {
  return new JvmSidecar({
    javaExecutable,
    hostJar: artifacts.hostJar,
    spiderJar: artifacts.spiderJar,
    spiderClass: "com.qx.spike.fixture.HttpSpider",
    requestTimeoutMs,
  });
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
  const result = response.result;
  return {
    id: response.id,
    ok: true,
    resultType: Array.isArray(result) ? "array" : typeof result,
    itemCount: Array.isArray(result) ? result.length : null,
    resultSample: Array.isArray(result) ? result.slice(0, 1) : result,
  };
}

interface DelayServer {
  url: string;
  close: () => Promise<void>;
}

async function startDelayServer(): Promise<DelayServer> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const parsedDelay = Number(requestUrl.searchParams.get("delayMs") ?? "0");
    const delayMs = Number.isFinite(parsedDelay) && parsedDelay > 0 ? parsedDelay : 0;
    const body = JSON.stringify({
      source: "timeout-http-fixture",
      class: [{ type_id: "movie", type_name: "movie" }],
      list: [{ vod_id: "spike-4-timeout", vod_name: "Timeout fixture" }],
    });
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
    }, delayMs);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/catalog`;

  return {
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

if (process.argv[1]?.endsWith("jvm-probe.ts")) {
  runJvmProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
