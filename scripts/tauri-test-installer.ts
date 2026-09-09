import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { DEFAULT_TEST_PRESET_URL } from "../renderer/src/test-preset.js";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version?: unknown };
const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const tauriCommand = join(projectRoot, "scripts", "tauri-command.ts");
const target = "x86_64-pc-windows-msvc";
const profile = "release";
const nsisDirectory = join(projectRoot, "src-tauri", "target", target, profile, "bundle", "nsis");
const outputDirectory = resolve(projectRoot, process.env.QX_TAURI_TEST_OUTPUT_DIR?.trim() || "release/test");
const outputPath = resolve(
  projectRoot,
  process.env.QX_TAURI_TEST_INSTALLER_PATH?.trim() || join("release/test", `QX影视-Test-Setup-${version}-x64.exe`),
);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("TAURI_TEST_INSTALLER_REQUIRES_WIN32_X64");
}
if (!existsSync(tsx)) throw new Error(`TAURI_TEST_INSTALLER_TSX_MISSING: ${tsx}`);

const result = spawnSync(process.execPath, [tsx, tauriCommand, "build", "--bundles", "nsis", "--target", target], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    QX_COMPONENT_PUBLIC_KEY_BASE64: process.env.QX_COMPONENT_PUBLIC_KEY_BASE64
      ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    QX_COMPONENT_MANIFEST_URL: process.env.QX_COMPONENT_MANIFEST_URL
      ?? "https://example.invalid/qx/components-v1.json",
    QX_COMPONENT_SIGNATURE_URL: process.env.QX_COMPONENT_SIGNATURE_URL
      ?? "https://example.invalid/qx/components-v1.sig.b64",
    VITE_QX_TEST_PRESET_URL: DEFAULT_TEST_PRESET_URL,
    VITE_QX_TEST_PRESET_AUTO_LOAD: "1",
    VITE_QX_TEST_PRESET_AUTO_CONFIRM: "1",
  },
  windowsHide: false,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`TAURI_TEST_INSTALLER_BUILD_FAILED:${result.status ?? "unknown"}`);

const installer = readdirSync(nsisDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe") && entry.name.toLowerCase() !== "uninstall.exe")
  .map((entry) => join(nsisDirectory, entry.name))
  .sort()[0];
if (!installer) throw new Error(`TAURI_TEST_INSTALLER_OUTPUT_MISSING: ${nsisDirectory}`);

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(installer, outputPath);
console.log(`TAURI_TEST_INSTALLER: ${outputPath}`);
console.log(`TAURI_TEST_PRESET_URL: ${DEFAULT_TEST_PRESET_URL}`);
