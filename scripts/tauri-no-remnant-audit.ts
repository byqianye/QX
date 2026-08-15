import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const files = [
  "renderer/src/api.ts",
  "renderer/src/tauri-rpc.ts",
  "renderer/src/tauri-renderer-api.ts",
  "renderer/src/contracts.ts",
  "src-tauri/src/lib.rs",
  "src-tauri/src/source_session.rs",
  "src-tauri/src/native_sources.rs",
  "src-tauri/src/runtime_capability.rs",
  "src-tauri/src/jianpian.rs",
  "src-tauri/src/live_core.rs",
  "src-tauri/src/epg_core.rs",
  "src-tauri/src/desktop_services.rs",
  "src-tauri/src/component_manager.rs",
  "src-tauri/src/quickjs_bridge.rs",
  "src-tauri/src/quickjs_sidecar.rs",
  "src-tauri/src/mpv_bridge.rs",
];
const forbidden = [
  { label: "Android/JVM/DEX execution", pattern: /DexClassLoader|dalvik|JNIEnv|android\.app|java\.lang|jvm-native/iu },
  { label: "legacy Electron import", pattern: /src[\\/]electron[\\/]|from ['"]electron/iu },
  { label: "Node QuickJS runtime in Tauri", pattern: /quickjs-emscripten|node:child_process|node:fs|process\.env/iu },
];
const failures: string[] = [];

for (const relative of files) {
  const path = join(root, relative);
  if (!existsSync(path)) {
    failures.push(`missing boundary file: ${relative}`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push(`${rule.label}: ${relative}`);
  }
}

const rendererApi = readFileSync(join(root, "renderer/src/api.ts"), "utf8");
if (!rendererApi.includes("isTauriRuntime() ? new TauriRendererApi() : null")) {
  failures.push("renderer API does not keep an explicit Tauri boundary");
}
const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
  identifier?: string;
  bundle?: { resources?: string[] | Record<string, string> };
};
const coreCargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
if (coreCargo.includes('name = "qx-quickjs-sidecar"')) {
  failures.push("QuickJS sidecar must use its separate Cargo package, not the core Tauri package");
}
if (!existsSync(join(root, "src-tauri/quickjs-sidecar/Cargo.toml"))) {
  failures.push("separate QuickJS sidecar Cargo package is missing");
}
if (tauriConfig.identifier !== "com.qx.yingshi.desktop") failures.push("Tauri identifier drifted");
const configuredResources = tauriConfig.bundle?.resources;
const resourcePaths = Array.isArray(configuredResources)
  ? configuredResources
  : configuredResources && typeof configuredResources === "object"
    ? [...Object.keys(configuredResources), ...Object.values(configuredResources)]
    : [];
if (resourcePaths.includes("target/release/qx-quickjs-sidecar.exe")) {
  failures.push("optional QuickJS sidecar must not be declared as a core Tauri resource");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`tauri-no-remnant-audit: FAIL ${failure}`);
  process.exit(1);
}

console.log("tauri-no-remnant-audit: PASS Tauri execution boundary has no Android/JVM/DEX/Electron/Node QuickJS remnant and optional sidecar is excluded from core resources");
console.log("tauri-no-remnant-audit: informational DEX artifact classification is retained; no artifact is loaded or executed");
console.log("tauri-no-remnant-audit: legacy Electron files remain intentionally preserved outside the Tauri boundary");
