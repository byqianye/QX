import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AndroidRuntimeDiagnostics } from "../src/spider/android-runtime-diagnostics.js";
import type { AndroidEnvironmentSnapshot, AndroidDeviceManagerPort } from "../src/spider/android-device-manager.js";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const path = cleanups.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("Android runtime startup diagnostics", () => {
  it("reports an offline runtime without throwing when no adb/device exists", async () => {
    const manager = fakeManager({
      adbFound: false,
      deviceFound: false,
      diagnostics: ["ADB_NOT_FOUND", "ANDROID_DEVICE_NOT_FOUND"],
    });
    const status = await new AndroidRuntimeDiagnostics({
      deviceManager: manager,
      hostApkPath: "C:\\missing\\android-spider-host.apk",
    }).refresh();
    expect(status.androidHostOnline).toBe(false);
    expect(status.deviceStatus).toBe("missing");
    expect(status.message).toContain("未连接");
    expect(status.diagnostics).toEqual(expect.arrayContaining(["ADB_NOT_FOUND"]));
  });

  it("installs and checks the packaged Host before reporting online", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-android-runtime-"));
    cleanups.push(directory);
    const apkPath = join(directory, "android-spider-host.apk");
    writeFileSync(apkPath, "apk");
    const calls: string[] = [];
    const manager = fakeManager({ adbFound: true, deviceFound: true, diagnostics: [], hostInstalled: false, calls });
    const status = await new AndroidRuntimeDiagnostics({
      deviceManager: manager,
      hostApkPath: apkPath,
      probeHost: async (deviceManager) => {
        await deviceManager.startHost();
        calls.push("connect", "close");
        return true;
      },
    }).refresh();
    expect(status.androidHostOnline).toBe(true);
    expect(status.hostInstalled).toBe(true);
    expect(calls).toEqual(expect.arrayContaining(["install", "start", "connect", "close"]));
  });
});

function fakeManager(options: {
  adbFound: boolean;
  deviceFound: boolean;
  diagnostics: string[];
  hostInstalled?: boolean;
  calls?: string[];
}): AndroidDeviceManagerPort & { check(): Promise<AndroidEnvironmentSnapshot>; isHostInstalled(): Promise<boolean> } {
  let installed = options.hostInstalled ?? true;
  const calls = options.calls ?? [];
  const snapshot: AndroidEnvironmentSnapshot = {
    sdkFound: options.adbFound,
    adbFound: options.adbFound,
    ...(options.adbFound ? { adbPath: "adb" } : {}),
    emulatorFound: false,
    avds: [],
    devices: options.deviceFound ? [{ serial: "device", state: "device" }] : [],
    ...(options.deviceFound ? { device: { serial: "device", state: "device" } } : {}),
    deviceFound: options.deviceFound,
    diagnostics: options.diagnostics,
  };
  return {
    async check() { return snapshot; },
    async requireDevice() { return snapshot.device as NonNullable<AndroidEnvironmentSnapshot["device"]>; },
    async forward() {},
    async removeForward() {},
    async install() { calls.push("install"); installed = true; },
    async startHost() { calls.push("start"); },
    async stopHost() {},
    async push() {},
    async shell() { return ""; },
    async isHostInstalled() { return installed; },
  } as unknown as AndroidDeviceManagerPort & { check(): Promise<AndroidEnvironmentSnapshot>; isHostInstalled(): Promise<boolean> };
}
