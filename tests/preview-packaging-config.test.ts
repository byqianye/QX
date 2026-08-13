import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Windows Preview packaging configuration", () => {
  it("ships the Android Host outside app.asar with Preview artifact names", () => {
    const config = readFileSync(new URL("../electron-builder.preview.yml", import.meta.url), "utf8");
    expect(config).toContain("output: release/preview");
    expect(config).toContain("asar: true");
    expect(config).toContain("android-spider-host/app/build/outputs/apk/debug/app-debug.apk");
    expect(config).toContain("to: android-host/android-spider-host.apk");
    expect(config).toContain("build/android-runtime-manifest.json");
    expect(config).toContain("QX影视-Preview-Setup-${version}-${arch}.${ext}");
    expect(config).toContain("QX影视-Preview-Portable-${version}-${arch}.${ext}");
    expect(config).toContain("oneClick: false");
    expect(config).toContain("perMachine: false");
  });
});
