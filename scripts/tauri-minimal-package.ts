import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const target = "x86_64-pc-windows-msvc";
const tauriCommand = join(projectRoot, "scripts", "tauri-command.ts");
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const outputDirectory = join(projectRoot, "release", "tauri-minimal");
const bundleDirectory = join(projectRoot, "src-tauri", "target", target, "release", "bundle", "nsis");
const configPath = join(projectRoot, "src-tauri", "tauri.conf.json");

if (process.platform !== "win32" || process.arch !== "x64") {
  fail("TAURI_MINIMAL_BUILD_REQUIRES_WIN32_X64");
}
if (!existsSync(tsx)) fail(`TAURI_MINIMAL_TSX_MISSING: ${tsx}`);

const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  bundle?: { resources?: unknown; targets?: unknown };
};
if (config.bundle?.resources && Object.keys(config.bundle.resources as object).length > 0) {
  fail("TAURI_MINIMAL_RESOURCES_MUST_BE_EMPTY");
}

for (const name of [
  "QX_COMPONENT_PUBLIC_KEY_BASE64",
  "QX_COMPONENT_MANIFEST_URL",
  "QX_COMPONENT_SIGNATURE_URL",
]) {
  if (!process.env[name]?.trim()) fail(`TAURI_MINIMAL_MISSING_ENV: ${name}`);
}

run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run typecheck"], "typecheck");
run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run renderer:build"], "renderer build");
run(
  process.execPath,
  [tsx, tauriCommand, "build", "--bundles", "nsis", "--target", target],
  "tauri release build",
);

const installer = readdirSync(bundleDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile()
    && entry.name.toLowerCase().endsWith(".exe")
    && entry.name.toLowerCase() !== "uninstall.exe")
  .map((entry) => join(bundleDirectory, entry.name))
  .sort((a, b) => a.localeCompare(b))[0];
if (!installer) fail(`TAURI_MINIMAL_INSTALLER_MISSING: ${bundleDirectory}`);

mkdirSync(outputDirectory, { recursive: true });
const installerCopy = join(outputDirectory, installer.split(/[\\/]/u).pop()!);
writeFileSync(installerCopy, readFileSync(installer));
const manifest = {
  format: "qx-tauri-minimal-build-v1",
  generatedAt: new Date().toISOString(),
  target,
  installer: relative(projectRoot, installerCopy),
  rustAdapter: {
    staticallyLinked: true,
    sourceRoot: "src-tauri/src",
    bundleResources: config.bundle?.resources ?? {},
  },
  changedFiles: {
    runtimeIncluded: changedFiles().filter((file) => isRuntimeFile(file)),
    buildInputs: changedFiles().filter((file) => isBuildInput(file)),
    repositoryOnly: changedFiles().filter((file) => !isRuntimeFile(file) && !isBuildInput(file) && !isGeneratedFile(file)),
    generatedEvidence: changedFiles().filter(isGeneratedFile),
  },
};
writeFileSync(join(outputDirectory, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`TAURI_MINIMAL_INSTALLER: ${installerCopy}`);
console.log(`TAURI_MINIMAL_MANIFEST: ${join(outputDirectory, "build-manifest.json")}`);

function run(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? "unknown"}`);
}

function changedFiles(): string[] {
  const tracked = git(["diff", "--name-only", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked].map(normalize).filter(Boolean))].sort();
}

function git(args: string[]): string[] {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/u).filter(Boolean) : [];
}

function normalize(file: string): string {
  return file.replaceAll("\\", "/");
}

function isRuntimeFile(file: string): boolean {
  return /^(renderer\/src|src\/|src-tauri\/src|src-tauri\/capabilities|src-tauri\/tauri\.conf\.json)/u.test(file);
}

function isBuildInput(file: string): boolean {
  return /^(vite\.config\.ts|tsconfig.*\.json|package\.json|scripts\/tauri-|build\/tauri-|build\/assets\/)/u.test(file);
}

function isGeneratedFile(file: string): boolean {
  return /^(artifacts\/|tmp\/|dist\/|release\/|src-tauri\/target\/)/u.test(file);
}

function fail(message: string): never {
  console.error(`TAURI_MINIMAL_BUILD_FAILED: ${message}`);
  process.exit(1);
}
