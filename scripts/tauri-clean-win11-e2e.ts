import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(projectRoot, "artifacts", "tauri-clean-win11-e2e.json");
const installerValue = process.env.QX_TAURI_NSIS?.trim();
const installer = installerValue ? resolve(projectRoot, installerValue) : "";
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

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("TAURI_CLEAN_WIN11_E2E_REQUIRES_WIN32_X64");
}
if (process.env.QX_TAURI_CLEAN_E2E !== "1") {
  throw new Error("TAURI_CLEAN_WIN11_E2E_REQUIRES_QX_TAURI_CLEAN_E2E=1");
}
if (!installer || !existsSync(installer)) {
  throw new Error(`TAURI_CLEAN_WIN11_E2E_INSTALLER_MISSING: ${installer || "set QX_TAURI_NSIS"}`);
}

const hostPreflight = inspectHost();
if (!hostPreflight.verified) {
  throw new Error(`TAURI_CLEAN_WIN11_E2E_HOST_NOT_CLEAN: ${JSON.stringify(hostPreflight)}`);
}

const workDirectory = mkdtempSync(join(tmpdir(), "qx-tauri-clean-win11-"));
const installDirectory = join(workDirectory, "installed");
const dataDirectory = join(workDirectory, "data");
const isolatedDataDirectory = join(workDirectory, "isolated-data");
const webviewDataDirectory = join(workDirectory, "webview2");
const beforeProcesses = processSnapshot();
let cleanupError: unknown;
let report: CleanWin11Report | undefined;

try {
  const install = await runProcess(installer, ["/S", `/D=${installDirectory}`], {}, 120_000);
  const executable = findExecutable(installDirectory);
  const dataPath = join(dataDirectory, "qx-v1.sqlite3");
  const launch = executable ? await launchTauri(executable, dataDirectory, webviewDataDirectory) : emptyProcessResult("installer did not produce the Tauri executable");
  const dataReady = await waitFor(() => existsSync(dataPath), 10_000);
  const processesAfterLaunch = await waitForNoNewProcesses(beforeProcesses, 8_000);
  const restart = executable ? await launchTauri(executable, dataDirectory, join(workDirectory, "webview2-restart")) : emptyProcessResult("installer did not produce the Tauri executable");
  const restartDataReady = await waitFor(() => existsSync(dataPath), 10_000);
  const processesAfterRestart = await waitForNoNewProcesses(beforeProcesses, 8_000);
  const isolatedDataPath = join(isolatedDataDirectory, "qx-v1.sqlite3");
  const isolatedLaunch = executable ? await launchTauri(executable, isolatedDataDirectory, join(workDirectory, "webview2-isolated")) : emptyProcessResult("installer did not produce the Tauri executable");
  const isolatedDataReady = await waitFor(() => existsSync(isolatedDataPath), 10_000);
  const processesAfterIsolation = await waitForNoNewProcesses(beforeProcesses, 8_000);
  const dataRootIsolation = dataPath !== isolatedDataPath
    && restartDataReady
    && isolatedDataReady
    && onlyDatabaseFile(dataDirectory)
    && onlyDatabaseFile(isolatedDataDirectory);
  let webviewProfileRemoved = false;
  try {
    await rm(webviewDataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    webviewProfileRemoved = !existsSync(webviewDataDirectory);
  } catch {
    webviewProfileRemoved = false;
  }
  const uninstaller = findUninstaller(installDirectory);
  const uninstall = uninstaller
    ? await runProcess(uninstaller, ["/S"], {}, 120_000)
    : emptyProcessResult("installer did not produce an uninstaller");
  const installRemoved = await waitFor(() => !existsSync(installDirectory), 10_000);
  const processesAfterUninstall = await waitForNoNewProcesses(beforeProcesses, 8_000);
  const verified = install.code === 0
    && !install.timedOut
    && executable !== undefined
    && dataReady
    && launch.code === 0
    && !launch.timedOut
    && processesAfterLaunch
    && restart.code === 0
    && !restart.timedOut
    && processesAfterRestart
    && isolatedLaunch.code === 0
    && !isolatedLaunch.timedOut
    && processesAfterIsolation
    && dataRootIsolation
    && webviewProfileRemoved
    && uninstall.code === 0
    && !uninstall.timedOut
    && installRemoved
    && processesAfterUninstall;
  report = {
    schemaVersion: "v1",
    evidenceType: "tauri-clean-win11-e2e",
    verified,
    cleanInstall: verified,
    platform: "win32-x64",
    generatedBy: "scripts/tauri-clean-win11-e2e.ts",
    installer,
    installDirectory,
    dataDirectory,
    observations: {
      hostPreflight,
      installerExitCode: install.code,
      executable: executable ?? null,
      dataDirectoryUsed: dataDirectory,
      databaseCreated: dataReady,
      restartExitCode: restart.code,
      restartDatabasePresent: restartDataReady,
      restartExitedGracefully: restart.code === 0 && !restart.timedOut,
      noNewRuntimeProcessesAfterRestart: processesAfterRestart,
      isolatedDataDirectory,
      isolatedDatabaseCreated: isolatedDataReady,
      isolatedLaunchExitCode: isolatedLaunch.code,
      isolatedLaunchExitedGracefully: isolatedLaunch.code === 0 && !isolatedLaunch.timedOut,
      noNewRuntimeProcessesAfterIsolation: processesAfterIsolation,
      dataRootIsolation,
      appExitCode: launch.code,
      appExitedGracefully: launch.code === 0 && !launch.timedOut,
      noNewRuntimeProcessesAfterLaunch: processesAfterLaunch,
      webviewProfileRemoved,
      uninstaller: uninstaller ?? null,
      uninstallExitCode: uninstall.code,
      installDirectoryRemoved: installRemoved,
      noNewRuntimeProcessesAfterUninstall: processesAfterUninstall,
    },
    process: {
      installer,
      launch,
      restart,
      isolatedLaunch,
      uninstall,
    },
    notes: "Generated only by a real per-user Tauri NSIS install and uninstall using isolated application/data roots on an interactive Win11 x64 host. The runner tracks Tauri, WebView2, QuickJS, mpv, Electron, Node, Java, Python, aria2, and Android/ADB process images and refuses to write evidence unless every check passes.",
  };
  if (!verified) throw new Error(`TAURI_CLEAN_WIN11_E2E_FAILED: ${JSON.stringify(report)}`);
} finally {
  try {
    await rm(workDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    console.error(`TAURI_CLEAN_WIN11_E2E_CLEANUP_FAILED: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
}

if (!report) throw new Error("TAURI_CLEAN_WIN11_E2E_REPORT_NOT_CREATED");
const runnerWorkspaceRemoved = cleanupError === undefined && !existsSync(workDirectory);
report.observations.runnerWorkspaceRemoved = runnerWorkspaceRemoved;
report.observations.runnerWorkspaceCleanupFailed = cleanupError !== undefined;
report.verified = report.verified && runnerWorkspaceRemoved;
report.cleanInstall = report.verified;
console.log(JSON.stringify(report, null, 2));
if (!report.verified) throw new Error(`TAURI_CLEAN_WIN11_E2E_FAILED: ${JSON.stringify(report)}`);
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`TAURI_CLEAN_WIN11_E2E_REPORT: ${outputPath}`);

interface CleanWin11Report {
  verified: boolean;
  cleanInstall: boolean;
  observations: Record<string, unknown>;
  [key: string]: unknown;
}

function inspectHost(): {
  verified: boolean;
  windowsCaption: string | null;
  windowsBuild: number | null;
  existingQxPaths: string[];
  uninstallRegistryMatches: string[];
  existingQxProcesses: string[];
} {
  const os = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,BuildNumber | ConvertTo-Json -Compress)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  let windowsCaption: string | null = null;
  let windowsBuild: number | null = null;
  try {
    const value = JSON.parse(os.stdout.trim()) as { Caption?: unknown; BuildNumber?: unknown };
    windowsCaption = typeof value.Caption === "string" ? value.Caption : null;
    windowsBuild = typeof value.BuildNumber === "string" ? Number(value.BuildNumber) : null;
  } catch {
    // Keep the preflight failed when Windows cannot attest its version.
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  const appData = process.env.APPDATA?.trim();
  const programFiles = process.env.ProgramFiles?.trim();
  const candidatePaths = [
    ...(localAppData ? [join(localAppData, "com.qx.yingshi.desktop"), join(localAppData, "QXMovie"), join(localAppData, "Programs", "qx-yingshi")] : []),
    ...(appData ? [join(appData, "com.qx.yingshi.desktop"), join(appData, "QXMovie")] : []),
    ...(programFiles ? [join(programFiles, "qx-yingshi"), join(programFiles, "QXMovie")] : []),
  ];
  const existingQxPaths = candidatePaths.filter((path) => existsSync(path));
  const uninstallRegistryMatches = readUninstallRegistry();
  const existingQxProcesses = [...processSnapshot().entries()]
    .filter(([image, ids]) => ids.size > 0 && image !== "msedgewebview2.exe" && image !== "node.exe")
    .map(([image]) => image);
  const verified = os.status === 0
    && windowsCaption?.toLowerCase().includes("windows 11") === true
    && windowsBuild !== null
    && windowsBuild >= 22000
    && existingQxPaths.length === 0
    && uninstallRegistryMatches.length === 0
    && existingQxProcesses.length === 0;
  return { verified, windowsCaption, windowsBuild, existingQxPaths, uninstallRegistryMatches, existingQxProcesses };
}

function readUninstallRegistry(): string[] {
  const matches: string[] = [];
  const result = spawnSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "com.qx.yingshi.desktop"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) {
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (/com\.qx\.yingshi\.desktop/iu.test(line)) matches.push(line.trim());
    }
  }
  return matches;
}

function findExecutable(directory: string): string | undefined {
  return findFile(directory, (name) => name.toLowerCase().endsWith(".exe") && name.toLowerCase() !== "uninstall.exe");
}

function findUninstaller(directory: string): string | undefined {
  return findFile(directory, (name) => name.toLowerCase() === "uninstall.exe");
}

function onlyDatabaseFile(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.length === 1
    && entries[0] !== undefined
    && entries[0].isFile()
    && entries[0].name.toLowerCase() === "qx-v1.sqlite3";
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
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return predicate();
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function emptyProcessResult(stderr: string): ProcessResult {
  return { code: null, signal: null, timedOut: false, stdout: "", stderr };
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
