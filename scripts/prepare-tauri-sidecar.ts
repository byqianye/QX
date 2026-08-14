import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";
const manifest = join(projectRoot, "src-tauri", "quickjs-sidecar", "Cargo.toml");
const targetDir = join(projectRoot, "src-tauri", "quickjs-sidecar", "target");
const cargo = process.env.CARGO
  ?? (process.platform === "win32"
    ? join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe")
    : "cargo");

execFileSync(cargo, [
  "build",
  "--manifest-path",
  manifest,
  "--target-dir",
  targetDir,
  "--bin",
  "qx-quickjs-sidecar",
  ...(release ? ["--release"] : []),
], { cwd: projectRoot, stdio: "inherit" });

const binary = join(targetDir, profile, `qx-quickjs-sidecar${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(binary)) {
  throw new Error(`QuickJS sidecar build did not produce ${binary}`);
}
console.log(`QuickJS sidecar ready: ${binary}`);
