import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AndroidRuntimeBootstrapper } from "../src/spider/android-runtime-bootstrapper.js";
import type { AndroidRuntimeCommandRunner } from "../src/spider/android-runtime-process.js";
import type { AndroidRuntimePaths, AndroidRuntimeProgress } from "../src/spider/android-runtime-types.js";

const directories: string[] = [];

describe("Android Runtime Bootstrapper", () => {
  afterEach(() => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an explicit first-use consent before downloading or installing", async () => {
    const fixture = createFixture();
    const runner = fakeRunner();
    const bootstrapper = new AndroidRuntimeBootstrapper({ paths: fixture.paths, hostApkPath: fixture.hostApkPath, commandRunner: runner, platform: "win32", diskSpaceProbe: () => Number.MAX_SAFE_INTEGER });
    const state = await bootstrapper.ensureProvisioned({ consent: false });
    expect(state.bootstrapState).toBe("REPAIR_AVAILABLE");
    expect(state.diagnostics).toContain("ANDROID_RUNTIME_CONSENT_REQUIRED");
    expect(runner.calls).toHaveLength(0);
  });

  it("uses the dedicated SDK/AVD directories and reaches READY with fixed packages", async () => {
    const fixture = createFixture();
    const runner = fakeRunner();
    const bootstrapper = new AndroidRuntimeBootstrapper({ paths: fixture.paths, hostApkPath: fixture.hostApkPath, commandRunner: runner, platform: "win32", diskSpaceProbe: () => Number.MAX_SAFE_INTEGER });
    const state = await bootstrapper.ensureProvisioned({ consent: true });
    expect(state.bootstrapState).toBe("READY");
    const manifest = await bootstrapper.manifest();
    expect(manifest.sdkComponents.platformTools.version).toBe("37.0.1");
    expect(manifest.sdkComponents.emulator.version).toBe("37.1.11");
    expect(manifest.sdkComponents.systemImage.sha256).toMatch(/^[A-F0-9]{64}$/u);
    expect(bootstrapper.hostApkPath()).toContain(join("host", "android-spider-host.apk"));
    expect(runner.calls.some((call) => call.includes("platform-tools"))).toBe(true);
    expect(runner.calls.some((call) => call.includes("system-images;android-35;google_apis;x86_64"))).toBe(true);
    const environment = bootstrapper.commandEnvironment();
    expect(environment.QX_ANDROID_HOME).toBe(fixture.paths.sdk);
    expect(environment.QX_ANDROID_AVD_HOME).toBe(fixture.paths.avd);
    expect(environment.ANDROID_USER_HOME).toBe(join(fixture.paths.state, "android-user"));
    expect(environment.ANDROID_SDK_HOME).toBeUndefined();
    expect(environment.Path).toBe(environment.PATH);
    expect(environment.Path).toContain("Windows\\System32");
    expect(environment.ADB).toBe(join(fixture.paths.sdk, "platform-tools", "adb.exe"));
    expect(environment.QX_ANDROID_EMULATOR_PATH).toBe(join(fixture.paths.sdk, "emulator", "emulator.exe"));
    expect(environment.ANDROID_ADB_SERVER_PORT).toBe("5038");
    expect(environment.ADB_SERVER_SOCKET).toBe("tcp:5038");
    expect(environment.TEMP).toBe(join(fixture.paths.state, "tmp"));
    expect(environment.TMP).toBe(join(fixture.paths.state, "tmp"));

    const callsAfterFirstProvision = runner.calls.length;
    writeFileSync(fixture.hostApkPath, "updated-host");
    const updated = await bootstrapper.ensureProvisioned({ consent: true });
    expect(updated.bootstrapState).toBe("READY");
    expect(runner.calls.length).toBeGreaterThan(callsAfterFirstProvision);
    expect(readFileSync(bootstrapper.hostApkPath(), "utf8")).toBe("updated-host");
  });

  it("normalizes avdmanager userdata config when the size assignment has spaces", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.paths.avd, "QXSpiderRuntime.avd", "config.ini"), "disk.dataPartition.size = 6442450944\n");
    const bootstrapper = new AndroidRuntimeBootstrapper({
      paths: fixture.paths,
      hostApkPath: fixture.hostApkPath,
      commandRunner: fakeRunner(),
      platform: "win32",
      diskSpaceProbe: () => Number.MAX_SAFE_INTEGER,
    });

    await bootstrapper.ensureProvisioned({ consent: true });

    const config = readFileSync(join(fixture.paths.avd, "QXSpiderRuntime.avd", "config.ini"), "utf8");
    expect(config).toContain("disk.dataPartition.size=4G");
    expect(config).not.toContain("6442450944");
    expect(config.match(/disk\.dataPartition\.size/gu)).toHaveLength(1);
  });

  it("keeps the persisted state valid when progress writes overlap state transitions", async () => {
    const fixture = createFixture();
    const bootstrapper = new AndroidRuntimeBootstrapper({
      paths: fixture.paths,
      hostApkPath: fixture.hostApkPath,
      commandRunner: fakeRunner(),
      platform: "win32",
      diskSpaceProbe: () => Number.MAX_SAFE_INTEGER,
    });
    await bootstrapper.ensureProvisioned({ consent: true });

    const privateBootstrapper = bootstrapper as unknown as {
      updateProgress(progress: AndroidRuntimeProgress): void;
    };
    // Enough queued writes to overlap a transition without turning this into
    // a disk-throughput benchmark when Vitest runs all workers together.
    for (let index = 0; index < 128; index += 1) {
      privateBootstrapper.updateProgress({
        stage: "installing",
        downloadedBytes: index,
        cancellable: true,
      });
    }
    const inFlightState = readFileSync(join(fixture.paths.state, "bootstrap-state.json"), "utf8");
    expect(() => JSON.parse(inFlightState)).not.toThrow();
    await bootstrapper.recordState("READY");

    const persisted = JSON.parse(readFileSync(join(fixture.paths.state, "bootstrap-state.json"), "utf8")) as { bootstrapState?: string };
    expect(persisted.bootstrapState).toBe("READY");
  });
});

function createFixture(): { paths: AndroidRuntimePaths; hostApkPath: string } {
  const root = mkdtempSync(join(tmpdir(), "qx-embedded-android-"));
  directories.push(root);
  const paths: AndroidRuntimePaths = {
    root,
    sdk: join(root, "sdk"),
    avd: join(root, "avd"),
    downloads: join(root, "downloads"),
    host: join(root, "host"),
    state: join(root, "state"),
  };
  mkdirSync(join(paths.sdk, "cmdline-tools", "latest", "bin"), { recursive: true });
  mkdirSync(join(paths.sdk, "emulator"), { recursive: true });
  mkdirSync(join(paths.avd, "QXSpiderRuntime.avd"), { recursive: true });
  writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "sdkmanager.bat"), "fixture");
  writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "avdmanager.bat"), "fixture");
  writeFileSync(join(paths.sdk, "emulator", "emulator.exe"), "fixture");
  writeFileSync(join(paths.avd, "QXSpiderRuntime.avd", "config.ini"), "disk.dataPartition.size=12G\n");
  const hostApkPath = join(root, "source-host.apk");
  writeFileSync(hostApkPath, "host");
  return { paths, hostApkPath };
}

function fakeRunner(): AndroidRuntimeCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args]);
      if (args.includes("-accel-check")) return { exitCode: 0, stdout: "WHPX(10.0.22631) is installed and usable.", stderr: "" };
      if (args.includes("list") && args.includes("avd")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    start() { throw new Error("not used"); },
  };
}
