import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveJavaExecutable } from "../src/spikes/java-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "../src/spikes/jvm-build.js";
import { JvmSidecar } from "../src/spider/jvm-sidecar.js";

const javaExecutable = resolveJavaExecutable();
// Intentional environment guard: this suite starts a JVM sidecar and needs a real local Java executable.
const jvmDescribe = javaExecutable ? describe : describe.skip;
const movieLabel = "\u7535\u5f71";

jvmDescribe("JVM-native HTTP Spider Host", () => {
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>>;
  let server: Server;
  let endpoint: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(requestUrl.search);
      const delayMs = Number(requestUrl.searchParams.get("delayMs") ?? "0");
      const body = JSON.stringify({
        source: "local-http",
        class: [{ type_id: "movie", type_name: movieLabel }],
        list: [{
          vod_id: "spike-4-1",
          vod_name: "Spike 4 Movie",
          vod_pic: "https://example.invalid/poster.jpg",
          vod_remarks: "JVM HTTP",
        }],
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
    endpoint = `http://127.0.0.1:${address.port}/catalog`;
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

  it("passes ext and filter through the CatVod-like contract and returns HTTP JSON", async () => {
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({
        ok: true,
        result: { initialized: true },
      });
      await expect(sidecar.homeContent(false)).resolves.toMatchObject({
        ok: true,
        result: {
          source: "local-http",
          class: [{ type_id: "movie", type_name: movieLabel }],
          list: [{
            vod_id: "spike-4-1",
            vod_name: "Spike 4 Movie",
          }],
        },
      });
      await expect(sidecar.request("destroy", {})).resolves.toMatchObject({
        ok: true,
        result: { destroyed: true },
      });
    } finally {
      await sidecar.destroy();
    }

    expect(requests).toContain("?filter=false");
    expect(sidecar.isRunning).toBe(false);
  });

  it("terminates the isolated sidecar when the HTTP request exceeds its timeout", async () => {
    const sidecar = createSidecar(50);
    const delayedEndpoint = `${endpoint}?delayMs=250`;

    try {
      await sidecar.start();
      await expect(sidecar.init(delayedEndpoint, 1_000)).resolves.toMatchObject({
        ok: true,
      });
      await expect(sidecar.homeContent(false)).rejects.toThrow(/timeout/i);
    } finally {
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  function createSidecar(requestTimeoutMs = 1_000): JvmSidecar {
    return new JvmSidecar({
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.HttpSpider",
      requestTimeoutMs,
    });
  }
});
