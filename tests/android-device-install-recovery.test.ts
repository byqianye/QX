import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { AndroidDeviceManager } = await import("../src/spider/android-device-manager.js");

describe("Android Host install recovery", () => {
  const directories: string[] = [];

  afterEach(() => {
    execFileMock.mockReset();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uninstalls a retained signature-mismatched Host before reinstalling", async () => {
    const root = mkdtempSync(join(tmpdir(), "qx-android-device-install-"));
    directories.push(root);
    const adbPath = join(root, "adb.exe");
    const apkPath = join(root, "android-spider-host.apk");
    writeFileSync(adbPath, "fixture");
    writeFileSync(apkPath, "fixture");
    let installAttempts = 0;
    execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "devices") {
        callback(null, { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" });
        return;
      }
      if (args[0] === "-s" && args[2] === "shell" && args[3] === "getprop") {
        callback(null, { stdout: "", stderr: "" });
        return;
      }
      if (args[0] === "-s" && args[2] === "install") {
        installAttempts += 1;
        if (installAttempts === 1) {
          const error = Object.assign(new Error("adb install failed"), {
            stderr: "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]",
            stdout: "",
          });
          callback(error);
        } else {
          callback(null, { stdout: "Success\n", stderr: "" });
        }
        return;
      }
      if (args[0] === "-s" && args[2] === "uninstall") {
        callback(null, { stdout: "Success\n", stderr: "" });
        return;
      }
      if (args[0] === "-s" && args[2] === "shell" && args[3] === "pm") {
        callback(null, { stdout: "package:/data/app/com.qx.yingshi.androidhost/base.apk\n", stderr: "" });
        return;
      }
      callback(new Error(`unexpected adb call: ${args.join(" ")}`));
    });

    const manager = new AndroidDeviceManager({
      adbPath,
      hostPackage: "com.qx.yingshi.androidhost",
      env: { ADB: adbPath, ANDROID_ADB_SERVER_PORT: "5038" },
    });

    await manager.install(apkPath);

    const calls = execFileMock.mock.calls.map((call) => (call[1] as string[]).join(" "));
    expect(installAttempts).toBe(2);
    expect(calls).toContain("-s emulator-5554 uninstall com.qx.yingshi.androidhost");
  });
});
