import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveJvmSpiderDefinition } from "../src/spider/jvm-spiders.js";
import { DesktopSpiderClient } from "../src/spider/desktop-client.js";
import { validateJvmSpiderArtifact } from "../src/spider/jvm-artifact.js";
import { JvmSidecar } from "../src/spider/jvm-sidecar.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "../src/spikes/jvm-build.js";
import { resolveJavaExecutable } from "../src/spikes/java-probe.js";

describe("formal JVM engine boundaries", () => {
  it("rejects bare and archived Android DEX artifacts before URLClassLoader startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-jvm-artifact-test-"));
    try {
      const bareDex = join(directory, "classes.dex");
      writeFileSync(bareDex, Buffer.concat([Buffer.from("dex\n035\0", "ascii"), Buffer.alloc(32)]));
      expectJvmError(() => validateJvmSpiderArtifact(bareDex), "ANDROID_DEX_UNSUPPORTED");

      const archivedDex = join(directory, "android-spider.jar");
      writeFileSync(archivedDex, zipWithEntry("classes.dex"));
      expectJvmError(() => validateJvmSpiderArtifact(archivedDex), "ANDROID_DEX_UNSUPPORTED");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid JVM artifacts with a stable error code", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-jvm-artifact-test-"));
    try {
      const invalid = join(directory, "not-a-jar.bin");
      writeFileSync(invalid, "fixture");
      expectJvmError(() => validateJvmSpiderArtifact(invalid), "JVM_ARTIFACT_INVALID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts explicit class bindings without claiming universal csp_* compatibility", () => {
    expect(resolveJvmSpiderDefinition("csp_Custom", {
      api: "csp_Custom",
      spiderClass: "com.example.CustomSpider",
    })).toMatchObject({
      api: "csp_Custom",
      className: "com.example.CustomSpider",
      capabilities: { engine: "jvm", playback: false },
    });
    expect(resolveJvmSpiderDefinition("csp_Custom")).toBeUndefined();
  });
});

const javaExecutable = resolveJavaExecutable();
// Intentional environment guard: lifecycle coverage requires a real local Java executable;
// missing-host-runtime behavior is covered by the packaged negative probe.
const jvmDescribe = javaExecutable ? describe : describe.skip;

jvmDescribe("formal JVM engine lifecycle", () => {
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>>;
  let endpoint: string;

  beforeAll(async () => {
    artifacts = await buildJvmArtifacts();
    endpoint = "http://127.0.0.1:1/fixture-endpoint";
  });

  afterAll(async () => {
    if (artifacts) await removeJvmArtifacts(artifacts);
  });

  it("deduplicates concurrent sidecar starts and makes destroy idempotent", async () => {
    const sidecar = createSidecar();
    try {
      await Promise.all([sidecar.start(), sidecar.start(), sidecar.start()]);
      expect(sidecar.isRunning).toBe(true);
      expect(sidecar.pid).not.toBeNull();
    } finally {
      await Promise.all([sidecar.destroy(), sidecar.destroy(), sidecar.destroy()]);
      await sidecar.destroy();
    }
    expect(sidecar.isRunning).toBe(false);
    expect(sidecar.status).toBe("stopped");
  });

  it("deduplicates concurrent client initialization for one bound session", async () => {
    const client = new DesktopSpiderClient({
      api: "csp_Custom",
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.HttpSpider",
      binding: {
        configSource: "inline:fixture",
        siteKey: "custom",
        sessionId: "session-1",
        api: "csp_Custom",
        spiderJar: artifacts.spiderJar,
        spiderClass: "com.qx.spike.fixture.HttpSpider",
      },
    });
    try {
      const responses = await Promise.all([
        client.init(endpoint),
        client.init(endpoint),
        client.init(endpoint),
      ]);
      expect(responses.every((response) => response.ok)).toBe(true);
      expect(client.binding).toMatchObject({ siteKey: "custom", sessionId: "session-1" });
      await expect(client.init(endpoint)).resolves.toMatchObject({ ok: true });
    } finally {
      await client.destroy();
    }
    expect(client.isRunning).toBe(false);
  });

  it("maps a JVM host crash to a stable engine error", async () => {
    const sidecar = new JvmSidecar({
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.DoesNotExist",
      startupTimeoutMs: 1_000,
    });
    await expect(sidecar.start()).rejects.toMatchObject({ code: "JVM_SIDECAR_CRASHED" });
    expect(sidecar.lastError?.code).toBe("JVM_SIDECAR_CRASHED");
    await sidecar.destroy();
  });

  it("does not spawn Java when the Spider artifact is DEX", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-jvm-dex-test-"));
    const dexPath = join(directory, "classes.dex");
    writeFileSync(dexPath, Buffer.from("dex\n035\0", "ascii"));
    const sidecar = new JvmSidecar({
      javaExecutable: "missing-java-executable",
      hostJar: "missing-host.jar",
      spiderJar: dexPath,
      spiderClass: "com.example.AndroidSpider",
    });
    try {
      await expect(sidecar.start()).rejects.toMatchObject({ code: "ANDROID_DEX_UNSUPPORTED" });
      expect(sidecar.pid).toBeNull();
      expect(sidecar.status).toBe("new");
    } finally {
      await sidecar.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createSidecar(): JvmSidecar {
    return new JvmSidecar({
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.HttpSpider",
    });
  }
});

function expectJvmError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected JVM error: ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function zipWithEntry(name: string): Buffer {
  const entryName = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + entryName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(entryName.length, 26);
  entryName.copy(local, 30);

  const central = Buffer.alloc(46 + entryName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(entryName.length, 28);
  entryName.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}
