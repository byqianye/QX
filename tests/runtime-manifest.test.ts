import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRuntimeManifest,
  hasExpectedArchiveHash,
  validateBundledRuntime,
} from "../src/electron/runtime-manifest.js";
import { resolveElectronRuntime, sanitizedPackagedPythonEnvironment } from "../src/electron/runtime.js";

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
    expect(manifest.runtimes.jre.vendor).toBe("Eclipse Adoptium");
    expect(manifest.runtimes.mpv.source).toContain("zhongfly/mpv-winbuild");
    expect(manifest.runtimes.python.version).toContain("3.12.10");
    expect(validateBundledRuntime(directory, "jre")).toBe("ready");

    writeFileSync(join(directory, "mpv/mpv.exe"), "tampered");
    expect(validateBundledRuntime(directory, "mpv")).toBe("integrity-failed");
    expect(hasExpectedArchiveHash("python", join(directory, "mpv/mpv.exe"))).toBe(false);
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

  it("fails packaged resolution when one fixed runtime is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-runtime-missing-python-"));
    directories.push(directory);
    for (const executable of ["jre/bin/java.exe", "mpv/mpv.exe", "aria2/aria2c.exe"]) {
      const path = join(directory, executable);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "fixture");
    }
    writeFileSync(join(directory, "runtime-manifest.json"), JSON.stringify(buildRuntimeManifest(directory)));
    writeFileSync(join(directory, "jvm-spider-host.jar"), "fixture");
    writeFileSync(join(directory, "jvm-spiders.jar"), "fixture");
    expect(resolveElectronRuntime(directory, () => null, { requireBundledRuntimeManifest: true })).toMatchObject({
      status: "error",
      code: "RUNTIME_INTEGRITY_FAILED",
    });
  });

  it("removes host Python path overrides from packaged sidecar environment", () => {
    expect(sanitizedPackagedPythonEnvironment({
      PYTHONHOME: "C:\\evil",
      PYTHONPATH: "C:\\evil\\site-packages",
      PYTHONUSERBASE: "C:\\evil\\user",
      VIRTUAL_ENV: "C:\\evil\\venv",
      PATH: "C:\\Windows\\System32",
    })).toEqual({
      PYTHONNOUSERSITE: "1",
      PATH: "C:\\Windows\\System32",
    });
  });
});
