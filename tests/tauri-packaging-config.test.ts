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

  it("runs the signed release gate on the dedicated clean Win11 runner and refreshes all installer evidence", () => {
    const workflow = readFileSync(new URL("../.github/workflows/tauri-signed-release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("runs-on: [self-hosted, windows, x64, qx-clean-win11]");
    expect(workflow).toContain("Run real Jianpian HLS 20-second E2E");
    expect(workflow).toContain("Run fresh-user upgrade E2E");
    expect(workflow).toContain("artifacts/tauri-hls-20s-e2e.json");
    expect(workflow).toContain("npm run tauri:e2e:upgrade-win11");
  });
});
