import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("G72 Windows installer configuration", () => {
  it("defines a per-user NSIS installer without file associations", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      build?: unknown;
    };
    const builderConfig = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(packageJson.build).toBeUndefined();
    expect(builderConfig).toContain("appId: com.qx.yingshi");
    expect(builderConfig).toContain("productName: QX影视");
    expect(builderConfig).toContain("output: release");
    expect(builderConfig).toContain("asar: true");
    expect(builderConfig).toContain("target: nsis");
    expect(builderConfig).toContain("target: portable");
    expect(builderConfig).toContain("artifactName: QX影视-Setup-${version}-${arch}.${ext}");
    expect(builderConfig).toContain("artifactName: QX影视-Portable-${version}-${arch}.${ext}");
    expect(builderConfig).toContain("oneClick: false");
    expect(builderConfig).toContain("perMachine: false");
    expect(builderConfig).toContain("createDesktopShortcut: true");
    expect(builderConfig).toContain("createStartMenuShortcut: true");
    expect(builderConfig).toContain("deleteAppDataOnUninstall: false");
    expect(builderConfig).not.toContain("android-spider-host");
    expect(builderConfig).not.toContain("android-runtime");
  });

  it("keeps user data by default and exposes an explicit uninstall component", () => {
    const script = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
    expect(script).toContain("customUnInstallSection");
    expect(script).toContain("Section /o");
    expect(script).toContain("DELETE_QX_USER_DATA");
    expect(script).toContain("$APPDATA\\QX影视");
  });
});
