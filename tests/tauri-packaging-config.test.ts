import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Tauri Android Spider Runtime packaging", () => {
  it("builds the Android Host and ships its runtime manifest as external resources", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
      build?: { beforeBuildCommand?: string };
      bundle?: { resources?: Record<string, string> };
    };

    expect(config.build?.beforeBuildCommand).toContain("npm run android-host:build");
    expect(config.bundle?.resources).toEqual({
      "../android-spider-host/app/build/outputs/apk/debug/app-debug.apk": "android-host/android-spider-host.apk",
      "../build/android-runtime-manifest.json": "android-host/android-runtime-manifest.json",
    });
  });
});
