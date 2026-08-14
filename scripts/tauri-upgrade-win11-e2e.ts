import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(projectRoot, "artifacts", "tauri-upgrade-win11-e2e.json");
const oldInstaller = process.env.QX_TAURI_OLD_NSIS?.trim() ? resolve(process.env.QX_TAURI_OLD_NSIS) : "";
const newInstaller = process.env.QX_TAURI_NEW_NSIS?.trim() ? resolve(process.env.QX_TAURI_NEW_NSIS) : "";
const oldVersion = process.env.QX_TAURI_OLD_VERSION?.trim() || "0.8.0";
const newVersion = process.env.QX_TAURI_NEW_VERSION?.trim() || "0.9.0";
const runtimeImages = [
  "qx-yingshi.exe",
  "qx-quickjs-sidecar.exe",
  "mpv.exe",
  "msedgewebview2.exe",
  "electron.exe",
  "node.exe",
  "java.exe",
  "javaw.exe",
  "python.exe",
  "pythonw.exe",
  "aria2c.exe",
  "adb.exe",
  "qjs.exe",
];

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("TAURI_UPGRADE_WIN11_E2E_REQUIRES_WIN32_X64");
if (process.env.QX_TAURI_UPGRADE_E2E !== "1") throw new Error("TAURI_UPGRADE_WIN11_E2E_REQUIRES_QX_TAURI_UPGRADE_E2E=1");
if (!oldInstaller || !existsSync(oldInstaller)) throw new Error(`TAURI_UPGRADE_OLD_INSTALLER_MISSING: ${oldInstaller || "set QX_TAURI_OLD_NSIS"}`);
if (!newInstaller || !existsSync(newInstaller)) throw new Error(`TAURI_UPGRADE_NEW_INSTALLER_MISSING: ${newInstaller || "set QX_TAURI_NEW_NSIS"}`);

const workDirectory = mkdtempSync(join(tmpdir(), "qx-tauri-upgrade-win11-"));
const installDirectory = join(workDirectory, "installed");
const dataDirectory = join(workDirectory, "data");
const markerPath = join(dataDirectory, "upgrade-marker.txt");
const databasePath = join(dataDirectory, "qx-v1.sqlite3");
const beforeProcesses = processSnapshot();
let cleanupError: unknown;
let report: UpgradeReport | undefined;

try {
  const oldInstall = await runProcess(oldInstaller, ["/S", `/D=${installDirectory}`], {}, 120_000);
  const oldExecutable = findExecutable(installDirectory);
  const oldLaunch = oldExecutable
    ? await launchTauri(oldExecutable, dataDirectory, join(workDirectory, "webview2-old"))
    : emptyProcessResult("old installer did not produce the Tauri executable");
  const oldDatabaseCreated = await waitFor(() => existsSync(databasePath), 10_000);
  writeFileSync(markerPath, `created-by-tauri-${oldVersion}\n`, "utf8");
  const markerBeforeUpgrade = readFileSync(markerPath, "utf8");
  const processesAfterOld = await waitForNoNewProcesses(beforeProcesses, 8_000);

  const newInstall = await runProcess(newInstaller, ["/S", `/D=${installDirectory}`], {}, 120_000);
  const newExecutable = findExecutable(installDirectory);
  const newLaunch = newExecutable
    ? await launchTauri(newExecutable, dataDirectory, join(workDirectory, "webview2-new"))
    : emptyProcessResult("new installer did not produce the Tauri executable");
  const newDatabasePresent = await waitFor(() => existsSync(databasePath), 10_000);
  const markerPreserved = existsSync(markerPath) && readFileSync(markerPath, "utf8") === markerBeforeUpgrade;
  const processesAfterUpgrade = await waitForNoNewProcesses(beforeProcesses, 8_000);
  const uninstaller = findUninstaller(installDirectory);
  const uninstall = uninstaller
    ? await runProcess(uninstaller, ["/S"], {}, 120_000)
    : emptyProcessResult("upgraded installer did not produce an uninstaller");
  const installRemoved = await waitFor(() => !existsSync(installDirectory), 10_000);
  const processesAfterUninstall = await waitForNoNewProcesses(beforeProcesses, 8_000);

  const verified = oldInstall.code === 0
    && !oldInstall.timedOut
    && oldExecutable !== undefined
    && oldLaunch.code === 0
    && !oldLaunch.timedOut
    && oldDatabaseCreated
    && processesAfterOld
    && newInstall.code === 0
    && !newInstall.timedOut
    && newExecutable !== undefined
    && newLaunch.code === 0
    && !newLaunch.timedOut
    && newDatabasePresent
    && markerPreserved
    && processesAfterUpgrade
    && uninstall.code === 0
    && !uninstall.timedOut
    && installRemoved
    && processesAfterUninstall;

  report = {
    schemaVersion: "v1",
    evidenceType: "tauri-upgrade-win11-e2e",
    verified,
    cleanInstall: verified,
    platform: "win32-x64",
    generatedBy: "scripts/tauri-upgrade-win11-e2e.ts",
    oldVersion,
    newVersion,
    oldInstaller,
    newInstaller,
    installDirectory,
    dataDirectory,
    observations: {
      oldInstallerExitCode: oldInstall.code,
      oldExecutable: oldExecutable ?? null,
      oldLaunchExitCode: oldLaunch.code,
      oldDatabaseCreated,
      markerBeforeUpgrade,
      newInstallerExitCode: newInstall.code,
      newExecutable: newExecutable ?? null,
      newLaunchExitCode: newLaunch.code,
      newDatabasePresent,
      markerPreserved,
      noNewRuntimeProcessesAfterOld: processesAfterOld,
      noNewRuntimeProcessesAfterUpgrade: processesAfterUpgrade,
      uninstaller: uninstaller ?? null,
      uninstallExitCode: uninstall.code,
      installDirectoryRemoved: installRemoved,
      noNewRuntimeProcessesAfterUninstall: processesAfterUninstall,
    },
    hashes: {
      oldInstallerSha256: sha256File(oldInstaller),
      newInstallerSha256: sha256File(newInstaller),
    },
    process: { oldInstall, oldLaunch, newInstall, newLaunch, uninstall },
    notes: "Generated only by installing a real older Tauri NSIS package, writing a marker through the Tauri data-root override, upgrading in place with the newer Tauri NSIS package, verifying the marker/database, then uninstalling. The runner tracks Tauri, WebView2, QuickJS, mpv, Electron, Node, Java, Python, aria2, and Android/ADB process images and writes evidence only after its workspace is removed.",
  };
  if (!verified) throw new Error(`TAURI_UPGRADE_WIN11_E2E_FAILED: ${JSON.stringify(report)}`);
} finally {
  try {
    await rm(workDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (error) {
    cleanupError = error;
  }
}

if (!report) throw new Error("TAURI_UPGRADE_WIN11_E2E_REPORT_NOT_CREATED");
const runnerWorkspaceRemoved = cleanupError === undefined && !existsSync(workDirectory);
report.observations.runnerWorkspaceRemoved = runnerWorkspaceRemoved;
report.observations.runnerWorkspaceCleanupFailed = cleanupError !== undefined;
report.verified = report.verified && runnerWorkspaceRemoved;
report.cleanInstall = report.verified;
if (!report.verified) throw new Error(`TAURI_UPGRADE_WIN11_E2E_FAILED: ${JSON.stringify(report)}`);
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`TAURI_UPGRADE_WIN11_E2E_REPORT: ${outputPath}`);

interface UpgradeReport {
  verified: boolean;
  cleanInstall: boolean;
  observations: Record<string, unknown>;
  [key: string]: unknown;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function launchTauri(executablePath: string, dataRoot: string, webviewRoot: string): Promise<ProcessResult> {
  return runProcess(executablePath, [], {
    QX_TAURI_E2E: "1",
    QX_TAURI_E2E_DATA_ROOT: dataRoot,
    QX_TAURI_E2E_EXIT_AFTER_MS: "2500",
    WEBVIEW2_USER_DATA_FOLDER: webviewRoot,
  }, 30_000);
}

function runProcess(executablePath: string, args: string[], variables: Record<string, string>, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      cwd: projectRoot,
      env: { ...process.env, ...variables },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function emptyProcessResult(stderr: string): ProcessResult {
  return { code: null, signal: null, timedOut: false, stdout: "", stderr };
}

function findExecutable(directory: string): string | undefined {
  return findFile(directory, (name) => name.toLowerCase().endsWith(".exe") && name.toLowerCase() !== "uninstall.exe");
}

function findUninstaller(directory: string): string | undefined {
  return findFile(directory, (name) => name.toLowerCase() === "uninstall.exe");
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

function processSnapshot(): Map<string, Set<number>> {
  const snapshot = new Map<string, Set<number>>();
  const result = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return snapshot;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^"([^"]+)","(\d+)"/u.exec(line.trim());
    if (!match) continue;
    const image = match[1]?.toLowerCase();
    const pid = Number(match[2]);
    if (!image || !Number.isInteger(pid) || !runtimeImages.includes(image)) continue;
    const ids = snapshot.get(image) ?? new Set<number>();
    ids.add(pid);
    snapshot.set(image, ids);
  }
  return snapshot;
}

async function waitForNoNewProcesses(before: Map<string, Set<number>>, timeoutMs: number): Promise<boolean> {
  return waitFor(() => {
    const current = processSnapshot();
    for (const [image, ids] of current) {
      const oldIds = before.get(image) ?? new Set<number>();
      for (const pid of ids) if (!oldIds.has(pid)) return false;
    }
    return true;
  }, timeoutMs);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return predicate();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
