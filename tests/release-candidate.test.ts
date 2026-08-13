import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { RuntimePathResolver } from "../src/electron/runtime-paths.js";
import {
  ANDROID_RUNTIME_MINIMUM_QX_VERSION,
  ANDROID_RUNTIME_SDK_COMPONENT_LOCKS,
  buildAndroidRuntimeManifest,
  isAndroidRuntimeManifest,
} from "../src/spider/android-runtime-manifest.js";

describe("Windows Release Candidate V1", () => {
  it("pins the RC semver and dedicated artifact names", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    const builder = readFileSync(new URL("../electron-builder.rc.yml", import.meta.url), "utf8");
    expect(packageJson.version).toBe("0.9.0-rc.1");
    expect(builder).toContain("output: release/rc");
    expect(builder).toContain("QX影视-RC-Setup-${version}-${arch}.${ext}");
    expect(builder).toContain("QX影视-RC-Portable-${version}-${arch}.${ext}");
    expect(ANDROID_RUNTIME_MINIMUM_QX_VERSION).toBe("0.9.0-rc.1");
  });

  it("exposes every QX Android Runtime path from one resolver", () => {
    const resolver = new RuntimePathResolver({
      appPath: "C:\\Program Files\\QX影视\\resources\\app.asar",
      resourcesPath: "C:\\Program Files\\QX影视\\resources",
      userDataPath: "C:\\Users\\user\\AppData\\Roaming\\QX影视",
      localAppDataPath: "C:\\Users\\user\\AppData\\Local",
      isPackaged: true,
    });
    const paths = resolver.getQxRuntimePaths();
    expect(paths.runtimeRoot).toBe("C:\\Users\\user\\AppData\\Local\\QXMovie\\android-runtime");
    expect(paths.sdkRoot).toContain("android-runtime\\sdk");
    expect(paths.adbPath).toContain("android-runtime\\sdk\\platform-tools\\adb.exe");
    expect(paths.emulatorPath).toContain("android-runtime\\sdk\\emulator\\emulator.exe");
    expect(paths.avdHome).toContain("android-runtime\\avd");
    expect(paths.androidUserHome).toContain("android-runtime\\state\\android-user");
    expect(paths.hostApkPath).toContain("android-runtime\\host\\android-spider-host.apk");
    expect(paths.runtimeStatePath).toContain("android-runtime\\state");
    expect(paths.spiderCachePath).toContain("QX影视\\spider-cache");
  });

  it("documents unsigned RC and runtime first-use behavior", () => {
    const notes = readFileSync(new URL("../RELEASE-NOTES-RC.md", import.meta.url), "utf8");
    expect(notes).toContain("0.9.0-rc.1");
    expect(notes).toContain("not downloaded on first application launch");
    expect(notes).toContain("csp_Jianpian");
    expect(notes).toContain("unsigned");
  });

  it("locks the official Android SDK component versions and hashes", () => {
    const manifest = buildAndroidRuntimeManifest("a".repeat(64));
    expect(isAndroidRuntimeManifest(manifest)).toBe(true);
    expect(manifest.sdkComponents.platformTools.version).toBe("37.0.1");
    expect(manifest.sdkComponents.emulator.version).toBe("37.1.11");
    expect(manifest.sdkComponents.platform.version).toBe("2");
    expect(manifest.sdkComponents.systemImage.version).toBe("9");
    for (const component of Object.values(ANDROID_RUNTIME_SDK_COMPONENT_LOCKS)) {
      expect(component.sha256).toMatch(/^[A-F0-9]{64}$/u);
    }
  });
});
