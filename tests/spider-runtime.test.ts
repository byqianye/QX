import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { SpiderArtifactCache } from "../src/spider/spider-artifact-cache.js";
import { JarInspector } from "../src/spider/jar-inspector.js";
import { NativeSpiderRegistry } from "../src/spider/native-spider-registry.js";
import { SpiderRuntimeDetector } from "../src/spider/spider-runtime-detector.js";
import { SpiderRuntimeManager } from "../src/spider/spider-runtime.js";
import type { AndroidSpiderBridgeClient } from "../src/spider/android-spider-bridge-client.js";
import { MemorySpiderCredentialProvider } from "../src/spider/spider-credential-provider.js";

describe("Spider Runtime detection and artifacts", () => {
  it("prefers a registered native adapter for csp_Douban", async () => {
    const registry = new NativeSpiderRegistry();
    registry.register({ api: "csp_Douban", factory: () => undefined });
    const result = await new SpiderRuntimeDetector({ nativeRegistry: registry }).detect({
      key: "douban",
      type: 3,
      api: "csp_Douban",
    });

    expect(result).toMatchObject({ runtime: "native", supported: true, reason: "native_supported" });
  });

  it("classifies every csp site backed by classes.dex as dynamically supported Android DEX", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-dex-"));
    const jarPath = join(directory, "spider.jar");
    writeFileSync(jarPath, zipFile(["classes.dex", "assets/config.json"]));
    try {
      const result = await new SpiderRuntimeDetector().detect({
        key: "unknown",
        type: 3,
        api: "csp_Unknown",
        jar: jarPath,
      });
      expect(result).toMatchObject({
        runtime: "android-dex",
        supported: true,
        reason: "android_dex_artifact_ready",
        artifact: { hasClassesDex: true, runtimeRequirement: "android-dex" },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supports the real PoC Android DEX site through the same dynamic artifact path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-validated-dex-"));
    const jarPath = join(directory, "spider.jar");
    writeFileSync(jarPath, zipFile(["classes.dex"]));
    try {
      const result = await new SpiderRuntimeDetector().detect({
        key: "csp_FeiMaoUC",
        type: 3,
        api: "csp_Duopan",
        jar: jarPath,
      });
      expect(result).toMatchObject({
        runtime: "android-dex",
        supported: true,
        reason: "android_dex_artifact_ready",
        artifactPath: jarPath,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs the validated Android DEX site through the RuntimeManager client seam", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-validated-client-"));
    const jarPath = join(directory, "spider.jar");
    writeFileSync(jarPath, zipFile(["classes.dex"]));
    const calls: string[] = [];
    let initAttempts = 0;
    const client = {
      connect: async () => { calls.push("connect"); return {}; },
      health: async () => { calls.push("health"); return { status: "ok" }; },
      loadJar: async () => { calls.push("loadJar"); return { jarId: "jar-1" }; },
      createSpider: async (api: string, expectedClass: string, siteKey: string) => {
        calls.push(`createSpider:${api}:${expectedClass}:${siteKey}`);
        return { spiderId: "spider-1" };
      },
      destroySpider: async () => { calls.push("destroySpider"); },
      init: async () => {
        initAttempts += 1;
        calls.push("init");
        if (initAttempts === 1) throw Object.assign(new Error("transient Spider init failure"), { code: "SPIDER_METHOD_FAILED" });
        return {};
      },
      searchContent: async () => { calls.push("searchContent"); return { list: [{ vod_id: "poc-1", vod_name: "真实 PoC" }] }; },
      homeContent: async () => ({ list: [] }),
      categoryContent: async () => ({ list: [] }),
      detailContent: async () => ({ list: [{ vod_id: "poc-1", vod_name: "真实 PoC" }] }),
      playerContent: async () => ({ parse: 0, url: "https://example.test/video.m3u8" }),
      destroy: async () => { calls.push("destroy"); },
    } as unknown as AndroidSpiderBridgeClient;
    const site = { key: "csp_FeiMaoUC", type: 3, api: "csp_Duopan", jar: jarPath };
    const manager = new SpiderRuntimeManager({
      config: { sites: [site] },
      androidBridgeClientFactory: () => client,
    });
    try {
      const runtime = await manager.getRuntime(site);
      expect(runtime.kind).toBe("android-dex");
      expect(runtime.capabilities.search).toBe(true);
      await runtime.init(site, { sourceId: "android-poc", siteKey: site.key, ext: "{}" });
      await expect(runtime.search({ key: "庆余年" })).resolves.toMatchObject({ items: [{ id: "poc-1", name: "真实 PoC" }] });
      expect(calls).toEqual([
        "connect",
        "health",
        "loadJar",
        "createSpider:csp_Duopan:com.github.catvod.spider.Duopan:csp_FeiMaoUC",
        "init",
        "destroySpider",
        "connect",
        "health",
        "loadJar",
        "createSpider:csp_Duopan:com.github.catvod.spider.Duopan:csp_FeiMaoUC",
        "init",
        "searchContent",
      ]);
    } finally {
      await manager.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(calls.at(-1)).toBe("destroy");
  });

  it("prepares supported Android sources once and does not start the runtime for native-only sources", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-ready-gate-"));
    const jarPath = join(directory, "spider.jar");
    writeFileSync(jarPath, zipFile(["classes.dex"]));
    const androidSite = { key: "android", type: 3, api: "csp_Android", jar: jarPath };
    const nativeSite = { key: "douban", type: 3, api: "csp_Douban" };
    let prepareCount = 0;
    const manager = new SpiderRuntimeManager({
      config: { sites: [androidSite, nativeSite] },
      androidRuntimePreparer: async () => {
        prepareCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    try {
      await manager.prepareForSources([nativeSite]);
      expect(prepareCount).toBe(0);
      await Promise.all([
        manager.prepareForSources([androidSite]),
        manager.prepareForSources([androidSite]),
      ]);
      expect(prepareCount).toBe(1);
    } finally {
      await manager.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("destroys only the failed source runtime during source-local recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-source-destroy-"));
    const jarPath = join(directory, "spider.jar");
    writeFileSync(jarPath, zipFile(["classes.dex"]));
    const destroyed: string[] = [];
    const sourceA = { key: "source-a", type: 3, api: "csp_SourceA", jar: jarPath };
    const sourceB = { key: "source-b", type: 3, api: "csp_SourceB", jar: jarPath };
    const manager = new SpiderRuntimeManager({
      config: { sites: [sourceA, sourceB] },
      androidBridgeClientFactory: (site) => ({
        destroy: async () => destroyed.push(site.key ?? site.api ?? "unknown"),
      } as unknown as AndroidSpiderBridgeClient),
    });
    try {
      await manager.getRuntime(sourceA);
      await manager.getRuntime(sourceB);
      await manager.destroyRuntime(sourceA);
      expect(destroyed).toEqual(["source-a"]);
      await manager.destroy();
      expect(destroyed).toEqual(["source-a", "source-b"]);
    } finally {
      await manager.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refreshes the audited UC credential before Android playerContent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-uc-credential-"));
    const jarPath = join(directory, "spider.jar");
    writeFileSync(jarPath, zipFile(["classes.dex"]));
    const credentialPayloads: string[] = [];
    const client = {
      connect: async () => ({}),
      health: async () => ({ status: "ok" }),
      loadJar: async () => ({ jarId: "jar-uc" }),
      setSpiderCredential: async (_provider: "uc", payload: string) => {
        credentialPayloads.push(payload);
        return { configured: true };
      },
      createSpider: async () => ({ spiderId: "spider-uc" }),
      init: async () => ({}),
      playerContent: async () => ({ parse: 0, url: "https://example.test/video.m3u8" }),
      destroy: async () => {},
    } as unknown as AndroidSpiderBridgeClient;
    const site = { key: "uc", type: 3, api: "csp_Duopan", jar: jarPath };
    const manager = new SpiderRuntimeManager({
      config: { sites: [site] },
      androidBridgeClientFactory: () => client,
      spiderCredentialProvider: new MemorySpiderCredentialProvider("test-uc-token"),
    });
    try {
      const runtime = await manager.getRuntime(site);
      await runtime.init(site, { sourceId: "uc", siteKey: site.key, ext: "{}" });
      await expect(runtime.player({ flag: "线路", id: "episode-1" })).resolves.toMatchObject({
        status: "DIRECT",
        url: "https://example.test/video.m3u8",
      });
      expect(credentialPayloads).toEqual([
        JSON.stringify({ access_token: "test-uc-token" }),
        JSON.stringify({ access_token: "test-uc-token" }),
      ]);
    } finally {
      await manager.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves a local Spider declaration relative to a file config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-relative-artifact-"));
    const configPath = join(directory, "config.json");
    const jarPath = join(directory, "spider.jar");
    writeFileSync(configPath, "{}");
    writeFileSync(jarPath, zipFile(["classes.dex"]));
    try {
      const result = await new SpiderRuntimeDetector().detect(
        { key: "relative", type: 3, api: "csp_Relative" },
        { config: { spider: "./spider.jar" }, sourceUrl: pathToFileURL(configPath).toString() },
      );
      expect(result).toMatchObject({
        runtime: "android-dex",
        artifactPath: jarPath,
        artifactUrl: pathToFileURL(jarPath).toString(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes JavaScript Spider references from api and ext", async () => {
    const detector = new SpiderRuntimeDetector();
    await expect(detector.detect({ key: "js", type: 3, api: "js:https://example.test/spider.js" }))
      .resolves.toMatchObject({ runtime: "javascript", supported: true, reason: "js_supported" });
    await expect(detector.detect({ key: "js-ext", type: 3, api: "csp_js", ext: "https://example.test/spider.mjs" }))
      .resolves.toMatchObject({ runtime: "javascript", supported: true });
  });

  it("creates and executes the JavaScript runtime through the manager", async () => {
    const manager = new SpiderRuntimeManager({
      config: { sites: [{ key: "js", type: 3, api: "js:export default { init() {}, search(key) { return { list: [{ vod_id: key, vod_name: key }] }; } };" }] },
      jsWorker: { timeoutMs: 2_000 },
    });
    const site = { key: "js", type: 3, api: "js:export default { init() {}, search(key) { return { list: [{ vod_id: key, vod_name: key }] }; } };" };
    const runtime = await manager.getRuntime(site);
    try {
      expect(runtime.kind).toBe("javascript");
      await runtime.init(site, { sourceId: "manager-js", ext: "fixture" });
      await expect(runtime.search({ key: "movie" })).resolves.toMatchObject({ items: [{ id: "movie", name: "movie" }] });
    } finally {
      await manager.destroy();
    }
  });

  it("reports corrupted JARs as invalid_jar", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-invalid-"));
    const jarPath = join(directory, "broken.jar");
    writeFileSync(jarPath, Buffer.from("not-a-zip"));
    try {
      await expect(new JarInspector().inspectFile(jarPath)).rejects.toMatchObject({ code: "invalid_jar" });
      await expect(new SpiderRuntimeDetector().detect({ key: "broken", type: 3, api: "csp_Broken", jar: jarPath }))
        .resolves.toMatchObject({ runtime: "unsupported", supported: false, reason: "invalid_jar" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("downloads, hashes, caches and atomically reuses a JAR artifact", async () => {
    const bytes = zipFile(["classes.dex"]);
    const md5 = createHash("md5").update(bytes).digest("hex");
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-cache-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/java-archive", etag: "fixture-v1" });
      response.end(bytes);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("cache fixture did not expose a port");
    const url = `http://127.0.0.1:${address.port}/spider.jar`;
    try {
      const cache = new SpiderArtifactCache(directory, { maxBytes: 1024 * 1024 });
      const first = await cache.get({ url, md5 });
      const second = await cache.get({ url, md5 });
      expect(first).toMatchObject({ url, md5, size: bytes.length, fromCache: false });
      expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(second).toMatchObject({ fromCache: true, sha256: first.sha256 });
      expect(readFileSync(first.path)).toEqual(bytes);
      const metadataPath = readdirSync(directory).find((name) => name.endsWith(".json"));
      expect(metadataPath).toBeDefined();
      const metadata = JSON.parse(readFileSync(join(directory, metadataPath!), "utf8")) as Record<string, unknown>;
      expect(metadata).toMatchObject({ url, sha256: first.sha256, size: bytes.length, etag: "fixture-v1" });
      expect(metadata.downloadTime).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a declared MD5 mismatch without retaining the artifact", async () => {
    const bytes = zipFile(["classes.dex"]);
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-hash-"));
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end(bytes);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("hash fixture did not expose a port");
    try {
      const cache = new SpiderArtifactCache(directory);
      await expect(cache.get({ url: `http://127.0.0.1:${address.port}/spider.jar`, md5: "00000000000000000000000000000000" }))
        .rejects.toMatchObject({ code: "jar_hash_mismatch" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function zipFile(names: readonly string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    locals.push(local);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(0, 20);
    central.writeUInt32LE(0, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}
