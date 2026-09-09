import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SOURCE_SITE_KEY } from "../renderer/src/default-source.js";
import { DEFAULT_SOURCE_CATALOG } from "../renderer/src/default-source-catalog.js";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version?: unknown };
const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
const installer = resolve(projectRoot, process.env.QX_TAURI_TEST_INSTALLER_PATH?.trim() || join("release/test", `QX影视-Test-Setup-${version}-x64.exe`));
const outputPath = resolve(projectRoot, process.env.QX_TAURI_TEST_E2E_OUTPUT?.trim() || "artifacts/tauri-test-installer-e2e.json");
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cdpCanary = join(projectRoot, "scripts", "tauri-cdp-canary.ts");

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("TAURI_TEST_E2E_REQUIRES_WIN32_X64");
if (process.env.QX_TAURI_TEST_E2E !== "1") throw new Error("TAURI_TEST_E2E_REQUIRES_QX_TAURI_TEST_E2E=1");
if (!existsSync(installer)) throw new Error(`TAURI_TEST_E2E_INSTALLER_MISSING: ${installer}`);
if (!existsSync(tsx) || !existsSync(cdpCanary)) throw new Error("TAURI_TEST_E2E_TOOLING_MISSING");

const workDirectory = mkdtempSync(join(tmpdir(), "qx-tauri-test-installer-"));
const installDirectory = join(workDirectory, "installed");
const installerBytes = readFileSync(installer);
const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
let report: Record<string, unknown> | undefined;

try {
  const install = run(installer, ["/S", `/D=${installDirectory}`], {});
  const executable = findExecutable(installDirectory);
  const forbiddenPaths = scanForAndroidRuntime(installDirectory);
  const cdp = executable
    ? run(process.execPath, [tsx, cdpCanary, "--exe", executable, "--config-url", "http://xn--z7x900a.net/", "--expect-source-key", DEFAULT_SOURCE_SITE_KEY, "--expect-source-count", String(DEFAULT_SOURCE_CATALOG.sites.length), "--expect-preset", "--expect-direct-home", "--screenshot-dir", "artifacts/g129-installed"], {
        QX_TAURI_TEST_E2E: "1",
      })
    : emptyResult("installed executable missing");
  const uninstaller = findFile(installDirectory, (name) => name.toLowerCase() === "uninstall.exe");
  const uninstall = uninstaller ? run(uninstaller, ["/S"], {}) : emptyResult("uninstaller missing");
  const installRemoved = await waitFor(() => !existsSync(installDirectory), 10_000);
  const verified = install.code === 0
    && executable !== undefined
    && forbiddenPaths.length === 0
    && cdp.code === 0
    && uninstall.code === 0
    && installRemoved;
  report = {
    schemaVersion: "v1",
    evidenceType: "tauri-test-installer-e2e",
    verified,
    installer,
    installerSha256,
    installerBytes: installerBytes.length,
    installDirectory,
    observations: {
      executable: executable ?? null,
      autoPresetUrl: "http://xn--z7x900a.net/",
      preferredSiteKey: DEFAULT_SOURCE_SITE_KEY,
      androidRuntimePaths: forbiddenPaths,
      forbiddenRuntimePaths: forbiddenPaths,
      installExitCode: install.code,
      cdpExitCode: cdp.code,
      cdpOutput: `${cdp.stdout}\n${cdp.stderr}`.slice(-12_000),
      uninstallExitCode: uninstall.code,
      installRemoved,
    },
  };
  if (!verified) throw new Error(`TAURI_TEST_E2E_FAILED: ${JSON.stringify(report)}`);
} finally {
  await rm(workDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => undefined);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return predicate();
}

if (!report) throw new Error("TAURI_TEST_E2E_REPORT_MISSING");
const outputDirectory = resolve(outputPath, "..");
await (await import("node:fs/promises")).mkdir(outputDirectory, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`TAURI_TEST_E2E_REPORT: ${outputPath}`);

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], variables: Record<string, string>): ProcessResult {
  const child = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...variables },
    encoding: "utf8",
    windowsHide: false,
  });
  return {
    code: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? child.error?.message ?? "",
  };
}

function emptyResult(stderr: string): ProcessResult {
  return { code: null, stdout: "", stderr };
}

function findExecutable(directory: string): string | undefined {
  return findFile(directory, (name) => name.toLowerCase().endsWith(".exe") && name.toLowerCase() !== "uninstall.exe");
}

function findFile(directory: string, predicate: (name: string) => boolean): string | undefined {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && predicate(entry.name)) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, predicate);
      if (nested) return nested;
    }
  }
  return undefined;
}

function scanForAndroidRuntime(directory: string): string[] {
  const forbidden: string[] = [];
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (/android-runtime|android-spider-host|\.apk$|\.dex$|\.jar$|app\.asar$|(?:^|[\\/])(?:adb|electron|node|java|javaw|python[\d.]*|mpv|aria2c|qx-quickjs-sidecar)(?:\.exe)?$/iu.test(path)) forbidden.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(directory);
  return forbidden;
}
