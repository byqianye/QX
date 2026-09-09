import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows Release Candidate V1", () => {
  it("pins the RC semver and dedicated artifact names", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    const builder = readFileSync(new URL("../electron-builder.rc.yml", import.meta.url), "utf8");
    expect(packageJson.version).toBe("0.9.0-rc.1");
    expect(builder).toContain("output: release/rc");
    expect(builder).toContain("QX影视-RC-Setup-${version}-${arch}.${ext}");
    expect(builder).toContain("QX影视-RC-Portable-${version}-${arch}.${ext}");
  });

  it("keeps the Tauri and QuickJS package versions aligned with the RC", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    const tauri = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version?: string };
    const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
    const sidecarCargo = readFileSync(new URL("../src-tauri/quickjs-sidecar/Cargo.toml", import.meta.url), "utf8");
    const cargoVersion = cargo.match(/^version = "([^"]+)"/mu)?.[1];
    const sidecarVersion = sidecarCargo.match(/^version = "([^"]+)"/mu)?.[1];
    expect(tauri.version).toBe(packageJson.version);
    expect(cargoVersion).toBe(packageJson.version);
    expect(sidecarVersion).toBe(packageJson.version);
  });

  it("documents unsigned RC and removed legacy runtime behavior", () => {
    const notes = readFileSync(new URL("../docs/reports/release/RELEASE-NOTES-RC.md", import.meta.url), "utf8");
    expect(notes).toContain("0.9.0-rc.1");
    expect(notes).toContain("No Android/ADB/AVD component is shipped");
    expect(notes).toContain("csp_Jianpian");
    expect(notes).toContain("unsigned");
  });

});
