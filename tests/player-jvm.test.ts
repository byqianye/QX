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
      const direct = requestUrl.searchParams.get("id") === "direct-mp4";
      response.end(JSON.stringify({
        parse: 0,
        url: direct
          ? endpoint.replace("/player", "/media/fixture.mp4")
          : "https://media.example.invalid/fixture.m3u8",
        header: direct ? {} : {
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

  it("covers the full controlled VOD flow and serializes the selected line", async () => {
    const sidecar = createSidecar();
    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(sidecar.homeContent(false)).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "fixture:movie-1" }] },
      });
      await expect(sidecar.categoryContent("fixture", 2, false, {})).resolves.toMatchObject({
        ok: true,
        result: { page: 2, list: [{ vod_name: "Category Fixture" }] },
      });
      await expect(sidecar.searchContent("demo", false, 1)).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_name: "Search Fixture: demo" }] },
      });
      await expect(sidecar.detailContent(["fixture:movie-1"])).resolves.toMatchObject({
        ok: true,
        result: {
          list: [{
            vod_play_from: "主线$$$备用线",
            vod_play_url: "第一集$direct-hls#第二集$headered$$$电影$direct-mp4",
          }],
        },
      });

      await expect(sidecar.playerContent("备用线", "direct-mp4", ["vip", "e2e"])).resolves.toMatchObject({
        ok: true,
        result: { parse: 0, url: expect.stringContaining("/media/fixture.mp4") },
      });
      const requestUrl = new URL(requests.at(-1) ?? "/", endpoint);
      expect(requestUrl.searchParams.get("flag")).toBe("备用线");
      expect(requestUrl.searchParams.get("id")).toBe("direct-mp4");
      expect(requestUrl.searchParams.get("vipFlags")).toBe("vip,e2e");
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

  it("keeps headered playback available for the controlled LocalProxy", async () => {
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
          header: {
            Referer: "https://source.example.invalid/",
          },
        },
      });
      expect(session.view.playback).toMatchObject({
        available: true,
        parse: 0,
        url: "https://media.example.invalid/fixture.m3u8",
        headers: {
          Referer: "https://source.example.invalid/",
        },
      });
    } finally {
      await session.destroy();
    }
  });

  it("maps a header-free HTTP media result for the embedded player", async () => {
    const source = "inline:spike-19-direct";
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
      await session.open("playable", endpoint);
      await expect(session.playerContent("default", "direct-mp4", [])).resolves.toMatchObject({
        ok: true,
        result: { parse: 0, url: expect.stringContaining("/media/fixture.mp4") },
      });
      expect(session.view.playback).toMatchObject({
        available: true,
        parse: 0,
        url: expect.stringContaining("/media/fixture.mp4"),
        headers: {},
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
