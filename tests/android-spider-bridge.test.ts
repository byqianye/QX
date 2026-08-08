import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { AndroidSpiderBridge } from "../src/spider/android-spider-bridge.js";
import { SpiderRuntimeManager } from "../src/spider/spider-runtime.js";

describe("AndroidSpiderBridge", () => {
  it("normalizes a missing host executable with root-cause fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-bridge-missing-"));
    const missing = join(directory, "android-spider-host.exe");
    try {
      const bridge = new AndroidSpiderBridge({
        hostExecutable: missing,
        siteKey: "flash",
        sourceName: "Flash source",
        artifactUrl: "https://example.test/spider.jar",
        artifactPath: join(directory, "artifact.jar"),
      });
      await expect(bridge.start()).rejects.toMatchObject({
        code: "runtime_host_missing",
        details: {
          syscall: "spawn",
          missingPath: missing,
          siteKey: "flash",
          runtime: "android-dex",
          artifactUrl: "https://example.test/spider.jar",
        },
      });
      await bridge.destroy();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs the JSON-RPC lifecycle against an isolated protocol fixture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-bridge-fixture-"));
    const host = join(directory, "host.mjs");
    const artifact = join(directory, "spider.jar");
    writeFileSync(artifact, "fixture");
    writeFileSync(host, fixtureHostSource(), "utf8");
    const bridge = new AndroidSpiderBridge({
      hostExecutable: process.execPath,
      hostArgs: [host],
      siteKey: "fixture",
      requestTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });
    try {
      await bridge.start();
      await expect(bridge.health()).resolves.toMatchObject({ ok: true, result: { status: "online" } });
      await expect(bridge.loadJar(artifact, "https://example.test/spider.jar")).resolves.toMatchObject({ ok: true });
      await expect(bridge.createSpider("csp_Flash", "flash", "com.github.catvod.spider.Flash"))
        .resolves.toMatchObject({ ok: true, result: { expectedClass: "com.github.catvod.spider.Flash" } });
      await expect(bridge.init("{}"))
        .resolves.toMatchObject({ ok: true, result: { initialized: true } });
      await expect(bridge.searchContent("测试", false, 1))
        .resolves.toMatchObject({ ok: true, result: { list: [{ vod_id: "fixture-1" }] } });
      await expect(bridge.detailContent(["fixture-1"]))
        .resolves.toMatchObject({ ok: true, result: { list: [{ vod_id: "fixture-1", vod_name: "Fixture" }] } });
    } finally {
      await bridge.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(bridge.state).toBe("stopped");
  });

  it("terminates an unresponsive host on request timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-bridge-timeout-"));
    const host = join(directory, "host.mjs");
    writeFileSync(host, timeoutHostSource(), "utf8");
    const bridge = new AndroidSpiderBridge({
      hostExecutable: process.execPath,
      hostArgs: [host],
      requestTimeoutMs: 50,
      startupTimeoutMs: 1_000,
    });
    try {
      await bridge.start();
      await expect(bridge.searchContent("timeout", false, 1)).rejects.toMatchObject({ code: "ANDROID_BRIDGE_TIMEOUT" });
    } finally {
      await bridge.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(bridge.state).toBe("stopped");
  });

  it("preserves class-resolution diagnostics from the Host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-bridge-class-"));
    const host = join(directory, "host.mjs");
    writeFileSync(host, classNotFoundHostSource(), "utf8");
    const bridge = new AndroidSpiderBridge({
      hostExecutable: process.execPath,
      hostArgs: [host],
      requestTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });
    try {
      await bridge.start();
      await expect(bridge.createSpider("csp_Flash", "flash", "com.github.catvod.spider.Flash"))
        .resolves.toMatchObject({
          ok: false,
          error: {
            code: "SPIDER_CLASS_NOT_FOUND",
            diagnostics: {
              api: "csp_Flash",
              expectedClass: "com.github.catvod.spider.Flash",
              jarPath: "C:\\cache\\flash.jar",
            },
          },
        });
    } finally {
      await bridge.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes a DEX site through the manager when a Bridge factory is supplied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-bridge-manager-"));
    const host = join(directory, "host.mjs");
    const artifact = join(directory, "spider.jar");
    writeFileSync(artifact, zipFile(["classes.dex"]));
    writeFileSync(host, fixtureHostSource(), "utf8");
    const site = { key: "flash", type: 3, api: "csp_Flash", jar: artifact };
    const manager = new SpiderRuntimeManager({
      config: { sites: [site] },
      androidBridgeFactory: (_site, support) => new AndroidSpiderBridge({
        hostExecutable: process.execPath,
        hostArgs: [host],
        siteKey: "flash",
        ...(support.artifactUrl ? { artifactUrl: support.artifactUrl } : {}),
        ...(support.artifactPath ? { artifactPath: support.artifactPath } : {}),
      }),
    });
    try {
      const runtime = await manager.getRuntime(site);
      await runtime.init(site, { sourceId: "bridge-test", siteKey: "flash", ext: "{}" });
      await expect(runtime.search({ key: "test", page: 1 })).resolves.toMatchObject({ items: [{ id: "fixture-1", name: "Fixture" }] });
      await expect(runtime.detail(["fixture-1"])).resolves.toMatchObject([{ id: "fixture-1", name: "Fixture" }]);
    } finally {
      await manager.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fixtureHostSource(): string {
  return `import readline from "node:readline";
process.stdout.write(JSON.stringify({ type: "ready", protocol: "android-spider-rpc/1" }) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "health") result = { status: "online" };
  if (request.method === "loadJar") result = { loaded: true };
  if (request.method === "createSpider") result = request.params;
  if (request.method === "init") result = { initialized: true };
  if (request.method === "searchContent") result = { list: [{ vod_id: "fixture-1", vod_name: "Fixture" }] };
  if (request.method === "detailContent") result = { list: [{ vod_id: "fixture-1", vod_name: "Fixture" }] };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
  if (request.method === "destroy") process.exit(0);
});`;
}

function timeoutHostSource(): string {
  return `import readline from "node:readline";
process.stdout.write(JSON.stringify({ type: "ready", protocol: "android-spider-rpc/1" }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "destroy") process.exit(0);
});`;
}

function classNotFoundHostSource(): string {
  return `import readline from "node:readline";
process.stdout.write(JSON.stringify({ type: "ready", protocol: "android-spider-rpc/1" }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "destroy") process.exit(0);
  const response = request.method === "createSpider"
    ? { id: request.id, ok: false, error: { code: "SPIDER_CLASS_NOT_FOUND", message: "Spider class was not found", diagnostics: { api: request.params.api, expectedClass: request.params.expectedClass, jarPath: "C:\\\\cache\\\\flash.jar" } } }
    : { id: request.id, ok: true, result: {} };
  process.stdout.write(JSON.stringify(response) + "\\n");
});`;
}

function zipFile(names: readonly string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30);
    locals.push(local);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
