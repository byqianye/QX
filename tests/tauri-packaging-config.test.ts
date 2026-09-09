import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Tauri packaging", () => {
  it("builds the Windows executable as a GUI application without a console window", () => {
    const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
    expect(main).toContain('#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]');
  });

  it("does not ship external Android Runtime resources", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
      build?: { beforeBuildCommand?: string };
      bundle?: { resources?: Record<string, string> };
    };

    expect(config.build?.beforeBuildCommand).not.toContain("android-host");
    expect(config.bundle?.resources).toEqual({});
  });

  it("keeps the test package on the Rust Tauri path without optional sidecars", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
      build?: { beforeBuildCommand?: string };
      bundle?: { resources?: unknown; windows?: { nsis?: { installerHooks?: string } } };
    };
    const hook = readFileSync(new URL("../build/tauri-installer.nsh", import.meta.url), "utf8");

    expect(config.build?.beforeBuildCommand).toBe("npm run renderer:build");
    expect(config.bundle?.resources).toEqual({});
    expect(config.bundle?.windows?.nsis?.installerHooks).toBe("../build/tauri-installer.nsh");
    expect(hook).toContain('卸载旧版本（保留用户数据）');
    expect(hook).toContain("Page custom QxUninstallOldPage QxUninstallOldPageLeave");
    expect(hook).toContain('ExecWait \'$QxOldUninstaller /S\'');
  });

  it("exposes a minimal Tauri package path that compiles Rust into the app", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = readFileSync(new URL("../scripts/tauri-minimal-package.ts", import.meta.url), "utf8");

    expect(packageJson.scripts?.["build:windows:minimal"]).toBe("tsx scripts/tauri-minimal-package.ts");
    expect(script).toContain('const target = "x86_64-pc-windows-msvc"');
    expect(script).toContain('"--bundles", "nsis"');
    expect(script).toContain('"--target", target');
    expect(script).toContain("staticallyLinked: true");
    expect(script).toContain("bundleResources");
    expect(script).toContain("TAURI_MINIMAL_MISSING_ENV");
  });

  it("runs the signed release gate on the dedicated clean Win11 runner and refreshes all installer evidence", () => {
    const workflow = readFileSync(new URL("../.github/workflows/tauri-signed-release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("build-and-sign:");
    expect(workflow).toContain("runs-on: [self-hosted, windows, x64, qx-clean-win11]");
    expect(workflow).toContain("publish:");
    expect(workflow).toContain("name: qx-release-candidate");
    expect(workflow).toContain("name: qx-win11-evidence");
    expect(workflow).toContain("Run real Jianpian HLS 20-second E2E");
    expect(workflow).toContain("Run fresh-user upgrade E2E");
    expect(workflow).toContain("artifacts/tauri-hls-20s-e2e.json");
    expect(workflow).toContain("npm run tauri:e2e:upgrade-win11");
  });
});
