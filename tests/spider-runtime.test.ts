import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { SpiderArtifactCache } from "../src/spider/spider-artifact-cache.js";
import { JarInspector } from "../src/spider/jar-inspector.js";
import { NativeSpiderRegistry } from "../src/spider/native-spider-registry.js";
import { SpiderRuntimeDetector } from "../src/spider/spider-runtime-detector.js";
import { SpiderRuntimeManager } from "../src/spider/spider-runtime.js";

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

  it("classifies an unknown csp site backed by classes.dex as unsupported Android DEX", async () => {
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
        supported: false,
        reason: "android_dex_runtime_not_available",
        artifact: { hasClassesDex: true, runtimeRequirement: "android-dex" },
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
