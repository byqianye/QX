import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";

import { JvmSidecar } from "../spider/jvm-sidecar.js";
import type { SpiderResponse } from "../spider/rpc.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "./jvm-build.js";
import { resolveJavaExecutable } from "./java-probe.js";

export async function runPlayablePlayerProbe() {
  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    return {
      probe: "jvm-native-playable-player",
      status: "blocked" as const,
      reason: "JDK_NOT_FOUND",
      javaAvailable: false,
    };
  }

  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>> | undefined;
  let server: Server | undefined;
  const sidecars: JvmSidecar[] = [];
  let endpoint = "";
  try {
    server = createPlayerFixtureServer();
    await listen(server);
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/player`;
    artifacts = await buildJvmArtifacts();

    const normal = createSidecar(artifacts, javaExecutable, 1_000);
    sidecars.push(normal);
    await normal.start();
    const normalPid = normal.pid;
    const init = requireSuccess(await normal.init(endpoint, 2_000), "init");
    const player = requireSuccess(
      await normal.playerContent("default", "movie-1", ["vip"]),
      "playerContent",
    );
    const upstreamError = await normal.playerContent("default", "error", []);

    const timeout = createSidecar(artifacts, javaExecutable, 100);
    sidecars.push(timeout);
    await timeout.start();
    const timeoutPid = timeout.pid;
    await timeout.init(endpoint, 2_000);
    let timeoutError: { name: string; message: string } | null = null;
    try {
      await timeout.playerContent("default", "timeout", []);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      timeoutError = { name: normalized.name, message: normalized.message };
    }

    const playerResult = isRecord(player.result) ? player.result : {};
    const passed = init.ok
      && typeof playerResult.url === "string"
      && playerResult.url.startsWith("http")
      && playerResult.parse === 0
      && isRecord(playerResult.header)
      && playerResult.header["User-Agent"] === "Spike19"
      && !upstreamError.ok
      && upstreamError.error?.code === "JVM_SPIDER_ERROR"
      && normal.isRunning
      && timeoutError?.name === "JvmSidecarTimeoutError"
      && !timeout.isRunning
      && normalPid !== null
      && timeoutPid !== null
      && normalPid !== timeoutPid;

    return {
      probe: "jvm-native-playable-player",
      status: passed ? ("passed" as const) : ("failed" as const),
      javaAvailable: true,
      javaExecutable,
      hostJar: basename(artifacts.hostJar),
      spiderJar: basename(artifacts.spiderJar),
      spiderClass: "com.qx.spike.fixture.PlayableJvmSpider",
      source: "csp_PlayableFixture",
      sourceKind: "JVM-native HTTP-backed fixture",
      transport: "NDJSON",
      contract: {
        player: "String playerContent(String flag, String id, List<String> vipFlags)",
        result: "{parse, url, header}",
      },
      endpoint,
      player: summarizeResponse(player),
      upstreamError: summarizeResponse(upstreamError),
      timeout: {
        normalPid,
        timeoutPid,
        error: timeoutError,
        normalSidecarAlive: normal.isRunning,
        sidecarStopped: !timeout.isRunning,
        processIsolated: normalPid !== null && timeoutPid !== null && normalPid !== timeoutPid,
      },
      cspDouban: {
        playback: "disabled",
        reason: "metadata/detail source; no full-content URL",
      },
      dexDecision: {
        candidate: "csp_YGP",
        status: "separate-emulator-route",
        reason: "public artifact is Android DEX, not JVM-loadable",
      },
    };
  } catch (error) {
    return {
      probe: "jvm-native-playable-player",
      status: "failed" as const,
      javaAvailable: true,
      javaExecutable,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const sidecar of sidecars.reverse()) await sidecar.destroy();
    if (server) await close(server);
    if (artifacts) await removeJvmArtifacts(artifacts);
  }
}

function createSidecar(
  artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>>,
  javaExecutable: string,
  requestTimeoutMs: number,
): JvmSidecar {
  return new JvmSidecar({
    javaExecutable,
    hostJar: artifacts.hostJar,
    spiderJar: artifacts.spiderJar,
    spiderClass: "com.qx.spike.fixture.PlayableJvmSpider",
    requestTimeoutMs,
    startupTimeoutMs: 5_000,
  });
}

function createPlayerFixtureServer(): Server {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/player") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (requestUrl.searchParams.get("id") === "error") {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "player upstream unavailable" }));
      return;
    }
    if (requestUrl.searchParams.get("id") === "timeout") {
      setTimeout(() => response.end(), 500);
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      parse: 0,
      url: "https://media.example.invalid/fixture.m3u8",
      header: {
        "User-Agent": "Spike19",
        Referer: "https://source.example.invalid/",
      },
    }));
  });
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function requireSuccess(response: SpiderResponse, method: string): SpiderResponse {
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "unknown error"}`);
  }
  return response;
}

function summarizeResponse(response: SpiderResponse): unknown {
  if (!response.ok) return response;
  return { id: response.id, ok: true, result: response.result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("playable-player-probe.ts")) {
  runPlayablePlayerProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
