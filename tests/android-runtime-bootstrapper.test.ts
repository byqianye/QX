import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AndroidRuntimeBootstrapper } from "../src/spider/android-runtime-bootstrapper.js";
import type { AndroidRuntimeCommandRunner } from "../src/spider/android-runtime-process.js";
import { ANDROID_RUNTIME_AVD_NAME, ANDROID_RUNTIME_COMPACT_AVD_NAME } from "../src/spider/android-runtime-types.js";
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

  it("does not shrink an existing AVD userdata config", async () => {
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
    expect(config).toContain("disk.dataPartition.size = 6442450944");
    expect(config).not.toContain("disk.dataPartition.size=1G");
    expect(config.match(/disk\.dataPartition\.size/gu)).toHaveLength(1);
  });

  it("creates a compact AVD profile without shrinking an existing AVD", async () => {
    const fixture = createFixture(ANDROID_RUNTIME_COMPACT_AVD_NAME);
    rmSync(join(fixture.paths.avd, `${ANDROID_RUNTIME_COMPACT_AVD_NAME}.avd`), { recursive: true, force: true });
    const runner = fakeRunner({
      avdListOutput: "",
      onRun: (args, file) => {
        if (file?.includes("mke2fs")) {
          const partial = args[args.length - 2];
          if (!partial) throw new Error("missing compact userdata image path");
          const descriptor = openSync(partial, "w");
          try {
            ftruncateSync(descriptor, 1024 * 1024 * 1024);
          } finally {
            closeSync(descriptor);
          }
          return;
        }
        if (args[0] !== "create") return;
        const avdPath = join(fixture.paths.avd, `${ANDROID_RUNTIME_COMPACT_AVD_NAME}.avd`);
        mkdirSync(avdPath, { recursive: true });
        writeFileSync(join(avdPath, "config.ini"), "disk.dataPartition.size=4G\nhw.ramSize=2G\n");
      },
    });
    const bootstrapper = new AndroidRuntimeBootstrapper({
      paths: fixture.paths,
      hostApkPath: fixture.hostApkPath,
      avdName: ANDROID_RUNTIME_COMPACT_AVD_NAME,
      commandRunner: runner,
      platform: "win32",
      diskSpaceProbe: () => Number.MAX_SAFE_INTEGER,
    });

    await bootstrapper.ensureProvisioned({ consent: true });

    const config = readFileSync(join(fixture.paths.avd, `${ANDROID_RUNTIME_COMPACT_AVD_NAME}.avd`, "config.ini"), "utf8");
    expect((await bootstrapper.manifest()).android.avdName).toBe(ANDROID_RUNTIME_COMPACT_AVD_NAME);
    expect(config).toContain("disk.dataPartition.size=1073741824");
    expect(config).toContain("hw.ramSize=1024M");
    expect(config).toContain("hw.audioInput=no");
    expect(config).toContain("hw.audioOutput=no");
    expect(config).toContain("hw.camera.back=none");
    expect(config).toContain("hw.camera.front=none");
    expect(config).toContain("hw.sdCard=no");
    expect(config).toContain("firstboot.saveToLocalSnapshot=no");
    expect(config).not.toContain("disk.dataPartition.size=4G");
  });

  it("creates a real one-gigabyte userdata image for Compact mode", async () => {
    const fixture = createFixture(ANDROID_RUNTIME_COMPACT_AVD_NAME);
    const runner = fakeRunner({
      onRun: (args, file) => {
        if (!file?.includes("mke2fs")) return;
        const partial = args[args.length - 2];
        if (!partial) throw new Error("missing compact userdata image path");
        const descriptor = openSync(partial, "w");
        try {
          ftruncateSync(descriptor, 1024 * 1024 * 1024);
        } finally {
          closeSync(descriptor);
        }
      },
    });
    const bootstrapper = new AndroidRuntimeBootstrapper({
      paths: fixture.paths,
      hostApkPath: fixture.hostApkPath,
      avdName: ANDROID_RUNTIME_COMPACT_AVD_NAME,
      commandRunner: runner,
      platform: "win32",
      diskSpaceProbe: () => Number.MAX_SAFE_INTEGER,
    });

    await bootstrapper.ensureProvisioned({ consent: true });

    const imagePath = bootstrapper.userdataImagePath();
    expect(imagePath).toBeDefined();
    expect(statSync(imagePath!).size).toBe(1024 * 1024 * 1024);
    expect(runner.calls.some((call) => call[0]?.includes("mke2fs") && call.includes("ext4"))).toBe(true);
  });

  it("creates the Compact AVD before reporting an unavailable WHPX", async () => {
    const fixture = createFixture(ANDROID_RUNTIME_COMPACT_AVD_NAME);
    rmSync(join(fixture.paths.avd, `${ANDROID_RUNTIME_COMPACT_AVD_NAME}.avd`), { recursive: true, force: true });
    const runner = fakeRunner({
      avdListOutput: "",
      whpxReady: false,
      onRun: (args, file) => {
        if (file?.includes("mke2fs")) {
          const partial = args[args.length - 2];
          if (!partial) throw new Error("missing compact userdata image path");
          const descriptor = openSync(partial, "w");
          try {
            ftruncateSync(descriptor, 1024 * 1024 * 1024);
          } finally {
            closeSync(descriptor);
          }
          return;
        }
        if (args[0] !== "create") return;
        const avdPath = join(fixture.paths.avd, `${ANDROID_RUNTIME_COMPACT_AVD_NAME}.avd`);
        mkdirSync(avdPath, { recursive: true });
        writeFileSync(join(avdPath, "config.ini"), "disk.dataPartition.size=10G\nhw.ramSize=2G\n");
      },
    });
    const bootstrapper = new AndroidRuntimeBootstrapper({
      paths: fixture.paths,
      hostApkPath: fixture.hostApkPath,
      avdName: ANDROID_RUNTIME_COMPACT_AVD_NAME,
      commandRunner: runner,
      platform: "win32",
      diskSpaceProbe: () => Number.MAX_SAFE_INTEGER,
    });

    const state = await bootstrapper.ensureProvisioned({ consent: true });

    expect(state.bootstrapState).toBe("REPAIR_AVAILABLE");
    expect(state.diagnostics).toContain("WHPX_NOT_READY");
    expect(readFileSync(join(fixture.paths.avd, `${ANDROID_RUNTIME_COMPACT_AVD_NAME}.avd`, "config.ini"), "utf8"))
      .toContain("disk.dataPartition.size=1073741824");
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

function createFixture(avdName = ANDROID_RUNTIME_AVD_NAME): { paths: AndroidRuntimePaths; hostApkPath: string } {
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
  mkdirSync(join(paths.sdk, "platform-tools"), { recursive: true });
 mkdirSync(join(paths.sdk, "emulator"), { recursive: true });
  mkdirSync(join(paths.avd, `${avdName}.avd`), { recursive: true });
 writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "sdkmanager.bat"), "fixture");
 writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "avdmanager.bat"), "fixture");
  writeFileSync(join(paths.sdk, "platform-tools", "mke2fs.exe"), "fixture");
 writeFileSync(join(paths.sdk, "emulator", "emulator.exe"), "fixture");
  writeFileSync(join(paths.avd, `${avdName}.avd`, "config.ini"), "disk.dataPartition.size=12G\n");
  const hostApkPath = join(root, "source-host.apk");
  writeFileSync(hostApkPath, "host");
  return { paths, hostApkPath };
}

function fakeRunner(options: { avdListOutput?: string; whpxReady?: boolean; onRun?: (args: readonly string[], file?: string) => void } = {}): AndroidRuntimeCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args]);
      options.onRun?.(args, file);
      if (args.includes("-accel-check")) return options.whpxReady === false
        ? { exitCode: 1, stdout: "", stderr: "WHPX is not installed" }
        : { exitCode: 0, stdout: "WHPX(10.0.22631) is installed and usable.", stderr: "" };
      if (args.includes("list") && args.includes("avd")) return { exitCode: 0, stdout: options.avdListOutput ?? "QXSpiderRuntime", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    start() { throw new Error("not used"); },
  };
}
