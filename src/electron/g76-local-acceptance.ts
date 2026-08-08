import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const projectRoot = resolve(process.cwd());
const reportPath = resolve(process.env.QX_G76_LOCAL_REPORT ?? join(projectRoot, "verification", "G76", "G76-local-report.json"));
const installerDirectory = join(projectRoot, "dist", "installer");
const installer = readdirSync(installerDirectory).map((name) => join(installerDirectory, name)).find((path) => /-setup\.exe$/iu.test(path));
if (!installer || !existsSync(installer)) {
  throw new Error("Current NSIS installer is missing; run npm run electron:installer:win first");
}

const workDirectory = mkdtempSync(join(tmpdir(), "qx-g76-local-"));
const installDirectory = join(workDirectory, "安装目录");
const userData = join(workDirectory, "user-data");
const postUpgradeUserData = join(workDirectory, "post-upgrade-user-data");
const tempDirectory = join(workDirectory, "temp");
const desktopShortcut = join(process.env.USERPROFILE ?? "", "Desktop", "QX影视.lnk");
const startMenuShortcut = join(
  process.env.APPDATA ?? "",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "QX影视",
  "QX影视.lnk",
);
const marker = join(userData, "g76-local-marker.txt");
const installedExecutable = join(installDirectory, "QX影视.exe");
const runtimeDirectory = join(installDirectory, "resources", "electron-runtime");
const runner = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const report: Record<string, unknown> = {
  probe: "local_windows_clean_room",
  status: "started",
  installer: installer,
  installerBytes: statSync(installer).size,
  installerSha256: createHash("sha256").update(readFileSync(installer)).digest("hex").toUpperCase(),
  installDirectory,
  userData,
  phases: [],
};

const sanitizedEnvironment = createLocalCleanRoomEnvironment(workDirectory);

try {
  refuseExistingShortcuts();
  mkdirSync(userData, { recursive: true });
  mkdirSync(tempDirectory, { recursive: true });
  writeFileSync(marker, "preserve-me\n", "utf8");

  const firstInstall = await run(installer, ["/S", `/D=${installDirectory}`], sanitizedEnvironment);
  assertProcess("first install", firstInstall, 0);
  assertInstalledPackage();
  addPhase("first_install", { exitCode: firstInstall.code, shortcuts: shortcutState() });

  const firstE2e = await runInstalledE2e();
  assertProcess("installed packaged E2E", firstE2e, 0);
  assertExists(marker, "user-data marker after first E2E");
  addPhase("installed_packaged_e2e", { exitCode: firstE2e.code, userDataMarker: true });

  const runtimeSmokes = [] as Array<Record<string, unknown>>;
  for (const [name, script] of [
    ["python", "src/electron/python-smoke.ts"],
    ["mpv", "src/electron/mpv-smoke.ts"],
    ["aria2", "src/electron/aria2-smoke.ts"],
  ] as const) {
    const result = await run(process.execPath, [runner, join(projectRoot, script)], {
      ...sanitizedEnvironment,
      QX_RUNTIME_DIRECTORY: runtimeDirectory,
    });
    assertProcess(`${name} bundled runtime smoke`, result, 0);
    runtimeSmokes.push({ name, exitCode: result.code, stdout: result.stdout.trim() });
  }
  addPhase("real_bundled_runtime_smokes", { runtimeDirectory, smokes: runtimeSmokes });

  const reinstall = await run(installer, ["/S", `/D=${installDirectory}`], sanitizedEnvironment);
  assertProcess("same-version reinstall", reinstall, 0);
  assertInstalledPackage();
  assertExists(marker, "user-data marker after reinstall");
  addPhase("same_version_reinstall", { exitCode: reinstall.code, markerPreserved: true, shortcuts: shortcutState() });

  const secondE2e = await runInstalledE2e(postUpgradeUserData);
  assertProcess("post-upgrade installed packaged E2E", secondE2e, 0);
  assertExists(marker, "user-data marker after restarted E2E");
  addPhase("post_upgrade_installed_packaged_e2e", { exitCode: secondE2e.code, oldUserDataMarkerPreserved: true, freshUserData: postUpgradeUserData });

  const uninstaller = readdirSync(installDirectory).map((name) => join(installDirectory, name)).find((path) => /uninstall.*\.exe$/iu.test(path));
  if (!uninstaller) throw new Error("Installed uninstaller was not found");
  const uninstall = await run(uninstaller, ["/S"], sanitizedEnvironment);
  assertProcess("silent uninstall", uninstall, 0);
  const removed = await waitForRemoval([installDirectory, desktopShortcut, startMenuShortcut]);
  if (!removed) throw new Error("Uninstall left the install directory or shortcut behind");
  assertExists(marker, "user-data marker after default uninstall");
  const cleanup = cleanupProbe();
  if (cleanup.processes.length > 0 || cleanup.ports.length > 0) {
    throw new Error(`Local G76 cleanup probe found residue: ${JSON.stringify(cleanup)}`);
  }
  addPhase("silent_uninstall", { exitCode: uninstall.code, installAndShortcutsRemoved: true, userDataRetained: true, cleanup });

  report.status = "passed";
  report.evidenceScope = "physical_windows_local_clean_room_not_pristine_clean_vm";
  report.environmentPolicy = {
    path: sanitizedEnvironment.PATH,
    clearedExternalRuntimeVariables: true,
    forceNoExternalJava: true,
  };
  writeReport();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  writeReport();
  throw error;
} finally {
  await removeDirectory(workDirectory);
}

function createLocalCleanRoomEnvironment(root: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  for (const name of [
    "JAVA_HOME", "JDK_HOME", "JRE_HOME", "PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE", "VIRTUAL_ENV", "NODE_PATH",
    "QX_TEMURIN_JDK", "QX_PYTHON", "QX_MPV_PATH", "QX_ARIA2_PATH", "QX_RUNTIME_DIRECTORY",
  ]) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (/^QX_.*_PATH$/iu.test(name)) delete environment[name];
  }
  const systemRoot = environment.SystemRoot ?? "C:\\Windows";
  environment.PATH = [join(systemRoot, "System32"), systemRoot, join(systemRoot, "System32", "Wbem")].join(";");
  environment.TEMP = join(root, "temp");
  environment.TMP = environment.TEMP;
  environment.QX_ELECTRON_FORCE_NO_EXTERNAL_JAVA = "1";
  environment.QX_E2E_LOCAL_WINDOWS_CLEAN_ROOM = "1";
  environment.QX_E2E_USER_DATA = join(root, "user-data");
  return environment;
}

function refuseExistingShortcuts(): void {
  for (const path of [desktopShortcut, startMenuShortcut]) cleanStaleGeneratedShortcut(path);
  const existing = [desktopShortcut, startMenuShortcut].filter((path) => path && existsSync(path));
  if (existing.length > 0) throw new Error(`Refusing local G76 run because shortcuts already exist: ${existing.join(", ")}`);
}

function cleanStaleGeneratedShortcut(path: string): void {
  if (!existsSync(path)) return;
  const escapedPath = path.replace(/'/g, "''");
  const target = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `$shell=New-Object -ComObject WScript.Shell; $shell.CreateShortcut('${escapedPath}').TargetPath`],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const generatedRoot = join(tmpdir(), "qx-g76-local-").toLowerCase();
  if (target.toLowerCase().startsWith(generatedRoot) && !existsSync(target)) unlinkSync(path);
}

function cleanupProbe(): { processes: Array<Record<string, unknown>>; ports: Array<Record<string, unknown>> } {
  const escapedRoot = workDirectory.replace(/'/g, "''");
  const script = [
    `$root='${escapedRoot}'`,
    "$processes=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.ExecutablePath -and $_.ExecutablePath -like ($root + '*')) -or ($_.CommandLine -and $_.CommandLine -like ('*' + $root + '*'))) } | Select-Object ProcessId,Name,ExecutablePath,CommandLine)",
    "$ids=@($processes | ForEach-Object { $_.ProcessId })",
    "$ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess)",
    "[pscustomobject]@{processes=$processes;ports=$ports} | ConvertTo-Json -Depth 4",
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  if (!output) return { processes: [], ports: [] };
  const parsed = JSON.parse(output) as { processes?: Record<string, unknown> | Array<Record<string, unknown>>; ports?: Record<string, unknown> | Array<Record<string, unknown>> };
  return {
    processes: normalizeProbeList(parsed.processes),
    ports: normalizeProbeList(parsed.ports),
  };
}

function normalizeProbeList(value: Record<string, unknown> | Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function assertInstalledPackage(): void {
  assertExists(installedExecutable, "installed executable");
  assertExists(join(runtimeDirectory, "runtime-manifest.json"), "installed runtime manifest");
  const manifest = JSON.parse(readFileSync(join(runtimeDirectory, "runtime-manifest.json"), "utf8")) as { runtimes?: Record<string, { bundled?: boolean }> };
  const runtimes = manifest.runtimes ?? {};
  for (const name of ["jre", "python", "mpv", "aria2"]) {
    if (runtimes[name]?.bundled !== true) throw new Error(`Installed runtime manifest does not mark ${name} bundled`);
  }
}

function shortcutState(): Record<string, boolean> {
  return { desktop: existsSync(desktopShortcut), startMenu: existsSync(startMenuShortcut) };
}

async function runInstalledE2e(dataRoot = userData): Promise<ProcessResult> {
  return run(process.execPath, [runner, join(projectRoot, "src", "electron", "e2e-launch.ts")], {
    ...sanitizedEnvironment,
    QX_PACKAGED_EXECUTABLE: installedExecutable,
    QX_E2E_USER_DATA: dataRoot,
    QX_E2E_REAL_ARIA2: "1",
  });
}

function addPhase(name: string, details: Record<string, unknown>): void {
  (report.phases as Array<Record<string, unknown>>).push({ name, ...details });
}

function writeReport(): void {
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function assertProcess(name: string, result: ProcessResult, expectedCode: number): void {
  if (result.code !== expectedCode) {
    throw new Error(`${name} failed: ${JSON.stringify({ code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr })}`);
  }
}

function assertExists(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

async function waitForRemoval(paths: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (paths.every((path) => !existsSync(path))) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return paths.every((path) => !existsSync(path));
}

async function removeDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  if (existsSync(path)) throw new Error(`Temporary G76 directory could not be removed: ${path}`);
}

function run(executable: string, args: string[], environment: Record<string, string>): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}
