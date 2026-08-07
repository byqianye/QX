import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRuntimeManifest,
  validateBundledRuntime,
} from "../src/electron/runtime-manifest.js";
import { resolveElectronRuntime } from "../src/electron/runtime.js";

describe("bundled runtime manifest", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records fixed runtime identities and validates executable hashes", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-manifest-"));
    directories.push(directory);
    for (const [id, executable] of [
      ["jre", "jre/bin/java.exe"],
      ["python", "python/python.exe"],
      ["mpv", "mpv/mpv.exe"],
      ["aria2", "aria2/aria2c.exe"],
    ] as const) {
      const path = join(directory, executable);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${id}-fixture`);
    }

    const manifest = buildRuntimeManifest(directory);
    writeFileSync(join(directory, "runtime-manifest.json"), JSON.stringify(manifest));
    expect(manifest.target).toBe("windows-x64");
    expect(manifest.runtimes.python.version).toContain("3.12.10");
    expect(validateBundledRuntime(directory, "jre")).toBe("ready");

    writeFileSync(join(directory, "mpv/mpv.exe"), "tampered");
    expect(validateBundledRuntime(directory, "mpv")).toBe("integrity-failed");
  });

  it("requires every bundled runtime in packaged mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-required-"));
    directories.push(directory);
    for (const executable of [
      "jre/bin/java.exe",
      "python/python.exe",
      "mpv/mpv.exe",
      "aria2/aria2c.exe",
    ]) {
      const path = join(directory, executable);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "fixture");
    }
    writeFileSync(join(directory, "runtime-manifest.json"), JSON.stringify(buildRuntimeManifest(directory)));
    writeFileSync(join(directory, "jvm-spider-host.jar"), "fixture");
    writeFileSync(join(directory, "jvm-spiders.jar"), "fixture");

    const result = resolveElectronRuntime(directory, () => null, { requireBundledRuntimeManifest: true });
    expect(result).toMatchObject({ status: "ready", runtime: {
      runtimeSource: "bundled-jre",
      pythonExecutable: join(directory, "python/python.exe"),
      mpvExecutable: join(directory, "mpv/mpv.exe"),
      aria2Executable: join(directory, "aria2/aria2c.exe"),
    } });
  });
});
