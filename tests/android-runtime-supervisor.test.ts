import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AndroidRuntimeBootstrapper } from "../src/spider/android-runtime-bootstrapper.js";
import { AndroidRuntimeSupervisor, buildAndroidEmulatorArguments } from "../src/spider/android-runtime-supervisor.js";
import type { AndroidRuntimeCommandRunner, AndroidRuntimeRunningProcess } from "../src/spider/android-runtime-process.js";
import type { AndroidManagedDevice, AndroidRuntimePaths } from "../src/spider/android-runtime-types.js";

describe("Android Runtime Supervisor", () => {
  const directories: string[] = [];

  it("passes valid host DNS servers to the headless emulator", () => {
    expect(buildAndroidEmulatorArguments([" 192.0.2.53 ", "not-an-ip"])).toEqual(expect.arrayContaining([
      "-dns-server",
      "192.0.2.53",
    ]));
  });

  afterEach(() => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts a dedicated headless emulator, installs Host, and verifies RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "qx-runtime-supervisor-"));
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
    writeFileSync(join(paths.avd, "QXSpiderRuntime.avd", "config.ini"), "hw.ramSize=2G\n");
    writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "sdkmanager.bat"), "fixture");
    writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "avdmanager.bat"), "fixture");
    writeFileSync(join(paths.sdk, "emulator", "emulator.exe"), "fixture");
    const hostApkPath = join(root, "host.apk");
    writeFileSync(hostApkPath, "host");
    const runner = fakeRunner();
    const bootstrapper = new AndroidRuntimeBootstrapper({ paths, hostApkPath, commandRunner: runner, platform: "win32", diskSpaceProbe: () => Number.MAX_SAFE_INTEGER });
    const device = fakeDevice();
    const supervisor = new AndroidRuntimeSupervisor({
      paths,
      bootstrapper,
      commandRunner: runner,
      deviceManagerFactory: () => device,
      bridgeFactory: () => ({
        async connect() { return { status: "ok" }; },
        async health() { return { status: "ok" }; },
        async close() {},
      }),
    });
    const status = await supervisor.ensureReady({ consent: true });
    expect(status.supervisorState).toBe("READY");
    expect(status.hostOnline).toBe(true);
    expect(status.hostVersion).toBe("1.0.0");
    expect(status.diskUsageBytes).toBeGreaterThan(0);
    expect(device.installs).toBe(1);
    expect(device.networkWaits).toBe(1);
    const emulatorStart = runner.calls.find((call) => call.includes("-no-window"));
    expect(emulatorStart).toEqual(expect.arrayContaining(["-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect"]));
    expect(emulatorStart).not.toContain("-snapshot");
    expect(emulatorStart).not.toContain("qx-runtime");
    expect(runner.calls.some((call) => call.includes("kill-server"))).toBe(true);
    expect(runner.calls.some((call) => call.includes("start-server"))).toBe(true);
    await supervisor.setMode("disabled");
    expect(supervisor.status().mode).toBe("disabled");
    await expect(supervisor.ensureReady({ consent: true })).rejects.toMatchObject({ code: "ANDROID_RUNTIME_DISABLED" });
    expect(readFileSync(join(paths.avd, "QXSpiderRuntime.avd", "config.ini"), "utf8"))
      .toContain("disk.dataPartition.size=4G");
  });

  it("bounds automatic recovery to one emulator restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "qx-runtime-recovery-"));
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
    writeFileSync(join(paths.avd, "QXSpiderRuntime.avd", "config.ini"), "hw.ramSize=2G\n");
    writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "sdkmanager.bat"), "fixture");
    writeFileSync(join(paths.sdk, "cmdline-tools", "latest", "bin", "avdmanager.bat"), "fixture");
    writeFileSync(join(paths.sdk, "emulator", "emulator.exe"), "fixture");
    const hostApkPath = join(root, "host.apk");
    writeFileSync(hostApkPath, "host");
    const runner = fakeRunner();
    const device = fakeDevice();
    let healthCalls = 0;
    const supervisor = new AndroidRuntimeSupervisor({
      paths,
      bootstrapper: new AndroidRuntimeBootstrapper({ paths, hostApkPath, commandRunner: runner, platform: "win32", diskSpaceProbe: () => Number.MAX_SAFE_INTEGER }),
      commandRunner: runner,
      deviceManagerFactory: () => device,
      bridgeFactory: () => ({
        async connect() { return { status: "ok" }; },
        async health() {
          healthCalls += 1;
          if (healthCalls > 1) throw new Error("host crashed");
          return { status: "ok" };
        },
        async close() {},
      }),
    });

    await supervisor.ensureReady({ consent: true });
    await expect(supervisor.ensureReady({ consent: true })).rejects.toMatchObject({ code: "ANDROID_RUNTIME_DEGRADED" });
    const startsAfterRecovery = runner.startCount;
    await expect(supervisor.ensureReady({ consent: true })).rejects.toMatchObject({ code: "ANDROID_RUNTIME_DEGRADED" });
    expect(runner.startCount).toBe(startsAfterRecovery);
    expect(supervisor.status().bootstrapState).toBe("REPAIR_AVAILABLE");
  });
});

function fakeRunner(): AndroidRuntimeCommandRunner & { calls: string[][]; startCount: number } {
  const calls: string[][] = [];
  let startCount = 0;
  const process: AndroidRuntimeRunningProcess = {
    pid: 123,
    exited: new Promise<number>(() => undefined),
    isRunning: () => true,
    async stop() {},
  };
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args]);
      if (args.includes("-accel-check")) return { exitCode: 0, stdout: "WHPX(10.0.22631) is installed and usable.", stderr: "" };
      if (args.includes("list") && args.includes("avd")) return { exitCode: 0, stdout: "QXSpiderRuntime", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    start(file, args) {
      startCount += 1;
      calls.push([file, ...args]);
      return process;
    },
    get startCount() { return startCount; },
  };
}

function fakeDevice(): AndroidManagedDevice & { installs: number; networkWaits: number } {
  let installed = false;
  const device = {
    installs: 0,
    networkWaits: 0,
    async requireDevice() { return { serial: "emulator-5554", state: "device" } as const; },
    async waitForBoot() { return { serial: "emulator-5554", state: "device", bootCompleted: true } as const; },
    async waitForNetwork() { device.networkWaits += 1; },
    async check() { return { sdkFound: true, adbFound: true, emulatorFound: true, avds: ["QXSpiderRuntime"], devices: [], deviceFound: true, diagnostics: [] }; },
    async isHostInstalled() { return installed; },
    async install() { device.installs += 1; installed = true; },
    async startHost() {},
    async stopHost() {},
    async forward() {},
    async removeForward() {},
    async push() {},
    async shell() { return ""; },
  };
  return device;
}
