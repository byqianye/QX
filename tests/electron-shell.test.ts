import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveElectronRuntime,
  type ElectronRuntime,
} from "../src/electron/runtime.js";
import {
  DesktopShellRuntime,
  type DesktopShellServerPort,
} from "../src/electron/shell-runtime.js";

describe("Electron desktop shell runtime", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a clear Java runtime error before creating the UI server", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-electron-no-jdk-"));
    directories.push(directory);
    const shell = new DesktopShellRuntime({
      resolveRuntime: () => resolveElectronRuntime(directory, () => null),
      createServer: () => {
        throw new Error("server must not be created");
      },
    });

    await expect(shell.start()).resolves.toMatchObject({
      status: "error",
      error: { code: "JAVA_RUNTIME_NOT_FOUND" },
    });
    expect(shell.state.status).toBe("error");
  });

  it("prefers the bundled JRE over external Java", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-electron-runtime-"));
    directories.push(directory);
    const hostJar = join(directory, "jvm-spider-host.jar");
    const spiderJar = join(directory, "jvm-spiders.jar");
    const bundledJava = join(directory, "jre", "bin", "java.exe");
    writeFileSync(hostJar, "fixture");
    writeFileSync(spiderJar, "fixture");
    mkdirSync(join(directory, "jre", "bin"), { recursive: true });
    writeFileSync(bundledJava, "fixture");

    expect(resolveElectronRuntime(directory, () => {
      throw new Error("external Java should not be inspected when bundled JRE exists");
    })).toEqual({
      status: "ready",
      runtime: {
        javaExecutable: bundledJava,
        hostJar,
        spiderJar,
        spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
        runtimeSource: "bundled-jre",
      },
    });
  });

  it("falls back to external Java when the bundled JRE is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-electron-external-java-"));
    directories.push(directory);
    const hostJar = join(directory, "jvm-spider-host.jar");
    const spiderJar = join(directory, "jvm-spiders.jar");
    writeFileSync(hostJar, "fixture");
    writeFileSync(spiderJar, "fixture");

    expect(resolveElectronRuntime(directory, () => "C:\\Java\\bin\\java.exe")).toEqual({
      status: "ready",
      runtime: {
        javaExecutable: "C:\\Java\\bin\\java.exe",
        hostJar,
        spiderJar,
        spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
        runtimeSource: "external-java",
      },
    });
  });

  it("can diagnose a missing bundled JRE without allowing external fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-electron-missing-jre-"));
    directories.push(directory);

    expect(resolveElectronRuntime(directory, () => null, { allowExternalJava: false })).toEqual({
      status: "error",
      code: "JAVA_RUNTIME_NOT_FOUND",
      message: expect.stringContaining("包内精简 JRE"),
    });
  });

  it("reuses a running server and closes it exactly once", async () => {
    const runtime: ElectronRuntime = {
      javaExecutable: "java",
      hostJar: "host.jar",
      spiderJar: "spider.jar",
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      runtimeSource: "external-java",
    };
    const server = new ServerFixture();
    let createCount = 0;
    const shell = new DesktopShellRuntime({
      resolveRuntime: () => ({ status: "ready", runtime }),
      createServer: () => {
        createCount += 1;
        return server;
      },
    });

    await expect(shell.start()).resolves.toMatchObject({
      status: "running",
      url: "http://127.0.0.1:43123/",
    });
    await expect(shell.start()).resolves.toMatchObject({ status: "running" });
    expect(createCount).toBe(1);
    expect(server.startCount).toBe(1);

    await shell.close();
    await shell.close();
    expect(server.closeCount).toBe(1);
    expect(shell.state).toMatchObject({ status: "closed", url: null });
  });
});

class ServerFixture implements DesktopShellServerPort {
  public readonly url = "http://127.0.0.1:43123/";
  public startCount = 0;
  public closeCount = 0;

  public async start(): Promise<void> {
    this.startCount += 1;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}
