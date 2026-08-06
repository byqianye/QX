import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ImportTrustStore } from "../src/config/trust.js";
import { DesktopSpiderSession } from "../src/desktop/spider-session.js";
import { DesktopSpiderClient } from "../src/spider/desktop-client.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "../src/spikes/jvm-build.js";
import { resolveJavaExecutable } from "../src/spikes/java-probe.js";
import { JvmSidecar } from "../src/spider/jvm-sidecar.js";

const javaExecutable = resolveJavaExecutable();
const jvmDescribe = javaExecutable ? describe : describe.skip;

jvmDescribe("JVM-native playerContent vertical slice", () => {
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>>;
  let server: Server;
  let endpoint: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(request.url ?? "/");
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
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        parse: 0,
        url: "https://media.example.invalid/fixture.m3u8",
        header: {
          "User-Agent": "Spike19",
          Referer: "https://source.example.invalid/",
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/player`;
    artifacts = await buildJvmArtifacts();
  });

  afterAll(async () => {
    if (artifacts) await removeJvmArtifacts(artifacts);
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("returns direct URL, parse flag and request headers through player RPC", async () => {
    const sidecar = createSidecar();
    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      const response = await sidecar.playerContent("default", "movie-1", ["vip"]);

      expect(response).toMatchObject({
        ok: true,
        result: {
          parse: 0,
          url: "https://media.example.invalid/fixture.m3u8",
          header: {
            "User-Agent": "Spike19",
            Referer: "https://source.example.invalid/",
          },
        },
      });
      expect(requests.at(-1)).toContain("flag=default");
      expect(requests.at(-1)).toContain("id=movie-1");
    } finally {
      await sidecar.destroy();
    }
  });

  it("keeps the sidecar alive when the player upstream returns an error", async () => {
    const sidecar = createSidecar();
    try {
      await sidecar.start();
      await sidecar.init(endpoint);
      const response = await sidecar.playerContent("default", "error", []);

      expect(response).toMatchObject({ ok: false, error: { code: "JVM_SPIDER_ERROR" } });
      expect(sidecar.isRunning).toBe(true);
    } finally {
      await sidecar.destroy();
    }
  });

  it("terminates the sidecar when playerContent exceeds its timeout", async () => {
    const sidecar = createSidecar(100);
    await sidecar.start();
    await sidecar.init(endpoint, 1_000);

    await expect(sidecar.playerContent("default", "timeout", [])).rejects.toMatchObject({
      name: "JvmSidecarTimeoutError",
    });
    expect(sidecar.isRunning).toBe(false);
    await sidecar.destroy();
  });

  it("maps a playable response through the desktop session and preserves headers", async () => {
    const source = "inline:spike-19-playable";
    const trustStore = new ImportTrustStore();
    const session = new DesktopSpiderSession({
      source,
      config: {
        spider: "csp_PlayableFixture.jvm.jar",
        sites: [{ key: "playable", api: "csp_PlayableFixture", ext: endpoint }],
      },
      trustStore,
      createClient: (site) => new DesktopSpiderClient({
        api: site.api ?? "",
        javaExecutable: javaExecutable as string,
        hostJar: artifacts.hostJar,
        spiderJar: artifacts.spiderJar,
        spiderClass: "com.qx.spike.fixture.PlayableJvmSpider",
        requestTimeoutMs: 1_000,
      }),
      requestTimeoutMs: 1_000,
    });

    session.confirmImport();
    try {
      await expect(session.open("playable", endpoint)).resolves.toMatchObject({ ok: true });
      await expect(session.playerContent("default", "movie-1", ["vip"])).resolves.toMatchObject({
        ok: true,
        result: {
          parse: 0,
          url: "https://media.example.invalid/fixture.m3u8",
        },
      });
      expect(session.view.playback).toMatchObject({
        available: true,
        parse: 0,
        url: "https://media.example.invalid/fixture.m3u8",
        headers: {
          "User-Agent": "Spike19",
          Referer: "https://source.example.invalid/",
        },
      });
    } finally {
      await session.destroy();
    }
  });

  function createSidecar(requestTimeoutMs = 1_000): JvmSidecar {
    return new JvmSidecar({
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.PlayableJvmSpider",
      requestTimeoutMs,
      startupTimeoutMs: 5_000,
    });
  }
});
