import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  configuredTestPresetUrl,
  normalizeConfigInput,
  testPresetAutoConfirmEnabled,
  testPresetAutoLoadEnabled,
} from "../renderer/src/test-preset.js";
import { DEFAULT_SOURCE_FALLBACK_CONFIG, DEFAULT_SOURCE_URL } from "../renderer/src/default-source.js";

describe("Tauri test installer preset", () => {
  it("normalizes the requested URL without changing its hostname", () => {
    expect(normalizeConfigInput(" http://xn--z7x900a.net/， ")).toBe("http://xn--z7x900a.net/");
    expect(normalizeConfigInput("http://xn--z7x900a.net/。" )).toBe("http://xn--z7x900a.net/");
  });

  it("only enables the automatic preset when the build injects both values", () => {
    expect(configuredTestPresetUrl({ VITE_QX_TEST_PRESET_URL: "http://xn--z7x900a.net/，" })).toBe("http://xn--z7x900a.net/");
    expect(testPresetAutoLoadEnabled({ VITE_QX_TEST_PRESET_URL: "http://xn--z7x900a.net/", VITE_QX_TEST_PRESET_AUTO_LOAD: "1" })).toBe(true);
    expect(testPresetAutoLoadEnabled({ VITE_QX_TEST_PRESET_URL: "http://xn--z7x900a.net/" })).toBe(false);
    expect(testPresetAutoConfirmEnabled({
      VITE_QX_TEST_PRESET_URL: "http://xn--z7x900a.net/",
      VITE_QX_TEST_PRESET_AUTO_LOAD: "1",
      VITE_QX_TEST_PRESET_AUTO_CONFIRM: "1",
    })).toBe(true);
    expect(testPresetAutoConfirmEnabled({
      VITE_QX_TEST_PRESET_URL: "http://xn--z7x900a.net/",
      VITE_QX_TEST_PRESET_AUTO_CONFIRM: "1",
    })).toBe(false);
  });

  it("keeps the test preset and Android exclusion checks in the build path", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
    const installerScript = readFileSync(new URL("../scripts/tauri-test-installer.ts", import.meta.url), "utf8");
    const e2eScript = readFileSync(new URL("../scripts/tauri-test-installer-e2e.ts", import.meta.url), "utf8");
    const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { bundle?: { resources?: unknown } };

    expect(packageJson.scripts?.["tauri:test-installer"]).toBe("tsx scripts/tauri-test-installer.ts");
    expect(packageJson.scripts?.["tauri:test-installer:e2e"]).toBe("tsx scripts/tauri-test-installer-e2e.ts");
    expect(installerScript).toContain("VITE_QX_TEST_PRESET_URL");
    expect(installerScript).toContain("VITE_QX_TEST_PRESET_AUTO_LOAD");
    expect(installerScript).toContain("VITE_QX_TEST_PRESET_AUTO_CONFIRM");
    expect(installerScript).toContain("x86_64-pc-windows-msvc");
    expect(installerScript).not.toContain('"--debug"');
    expect(installerScript).toContain('"build"');
    expect(installerScript).toContain("QX_COMPONENT_PUBLIC_KEY_BASE64");
    expect(e2eScript).toContain("scanForAndroidRuntime");
    expect(e2eScript).toContain("android-spider-host");
    expect(e2eScript).toContain(".apk");
    expect(tauriConfig.bundle?.resources).toEqual({});
  });

  it("guards auto-confirm behind the test-only preset flag", () => {
    const app = readFileSync(new URL("../renderer/src/App.vue", import.meta.url), "utf8");
    const importView = readFileSync(new URL("../renderer/src/ConfigImportView.vue", import.meta.url), "utf8");

    expect(app).toContain("testPresetAutoLoadEnabled");
    expect(app).toContain('importStatus !== "empty"');
    expect(importView).toContain("configuredTestPresetUrl");
    expect(importView).not.toContain('ref("http://xn--z7x900a.net/")');
    expect(app).toContain('"/api/import/load"');
    expect(app).toContain("testPresetAutoConfirmEnabled");
    expect(app).toContain('importStatus !== "confirmation_required"');
    expect(app).toContain('"/api/import/confirm"');
  });

  it("keeps the default desktop source usable when its remote catalog is temporarily unavailable", () => {
    expect(DEFAULT_SOURCE_URL).toBe("http://xn--z7x900a.net/");
    expect(DEFAULT_SOURCE_FALLBACK_CONFIG).toContain('"csp_Jianpian"');
    expect(DEFAULT_SOURCE_FALLBACK_CONFIG).toContain('"https://api.ztcgi.com"');
    const api = readFileSync(new URL("../renderer/src/tauri-renderer-api.ts", import.meta.url), "utf8");
    expect(api).toContain("DEFAULT_SOURCE_FALLBACK_CONFIG");
    expect(JSON.parse(DEFAULT_SOURCE_FALLBACK_CONFIG).sites).toHaveLength(39);
  });
});
