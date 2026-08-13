import { describe, expect, it } from "vitest";

import { AndroidEnvironmentDoctor, parseWhpxStatus, whpxEnableCommand } from "../src/spider/android-environment-doctor.js";
import type { AndroidRuntimeCommandRunner } from "../src/spider/android-runtime-process.js";

describe("Android Environment Doctor", () => {
  it("recognizes the official WHPX accel-check result", () => {
    expect(parseWhpxStatus("accel:\n0\nWHPX(10.0.22631) is installed and usable.", 0)).toBe("ready");
    expect(parseWhpxStatus("WHPX is not installed", 1)).toBe("missing");
  });

  it("does not offer a Windows feature mutation without an explicit action", async () => {
    const calls: string[][] = [];
    const runner: AndroidRuntimeCommandRunner = {
      async run(file, args) {
        calls.push([file, ...args]);
        return { exitCode: 0, stdout: "accel:\n0\nWHPX(10.0.22631) is installed and usable.", stderr: "" };
      },
      start() { throw new Error("not used"); },
    };
    const result = await new AndroidEnvironmentDoctor({ emulatorPath: "emulator.exe", commandRunner: runner }).check();
    expect(result.whpx).toBe("ready");
    expect(calls).toEqual([["emulator.exe", "-accel-check"]]);
    expect(whpxEnableCommand()).toEqual(["/Online", "/Enable-Feature", "/FeatureName:HypervisorPlatform", "/All", "/NoRestart"]);
  });
});
