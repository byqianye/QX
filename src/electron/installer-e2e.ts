import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const releaseDirectory = join(process.cwd(), "release");
const setupName = existsSync(releaseDirectory)
  ? readdirSync(releaseDirectory).find((name) => /^QX影视-(?:RC-)?Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-x64\.exe$/u.test(name))
  : undefined;
const setup = process.env.QX_INSTALLER_PATH?.trim()
  ? resolve(process.env.QX_INSTALLER_PATH)
  : setupName ? join(releaseDirectory, setupName) : "";
if (!setup || !existsSync(setup)) {
  throw new Error("Installer artifact is missing; run npm run dist:win:installer first");
}

const workDirectory = mkdtempSync(join(tmpdir(), "qx-installer-e2e-"));
const installDirectory = join(workDirectory, "安装目录");
const e2eUserData = process.env.QX_INSTALLER_E2E_USER_DATA?.trim() || join(workDirectory, "user-data");
const installedExecutable = join(installDirectory, "QX影视.exe");
const startMenuDirectory = join(
  process.env.APPDATA ?? "",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  process.env.QX_INSTALLER_MENU_CATEGORY?.trim() || "QX影视",
);
const desktopShortcut = join(process.env.USERPROFILE ?? "", "Desktop", "QX影视.lnk");
const startMenuShortcut = join(startMenuDirectory, "QX影视.lnk");
const shortcutBackups = [
  { source: desktopShortcut, backup: join(workDirectory, "preexisting-desktop.lnk") },
  { source: startMenuShortcut, backup: join(workDirectory, "preexisting-start-menu.lnk") },
].filter(({ source }) => existsSync(source));
const preexistingStartMenuDirectory = existsSync(startMenuDirectory);

try {
  for (const { source, backup } of shortcutBackups) renameSync(source, backup);
  const install = await run(setup, ["/S", `/D=${installDirectory}`]);
  if (install.code !== 0 || !existsSync(installedExecutable)) {
    throw new Error(`Installer install failed: ${JSON.stringify(install)}`);
  }

  const installedEntries = readdirSync(installDirectory);
  const uninstallerName = installedEntries.find((name) => /uninstall.*\.exe$/iu.test(name));
  if (!uninstallerName) throw new Error("Installed uninstaller was not found");
  const uninstaller = join(installDirectory, uninstallerName);
  const shortcuts = {
    desktop: existsSync(desktopShortcut),
    startMenu: existsSync(startMenuShortcut),
  };
  if (!shortcuts.desktop || !shortcuts.startMenu) {
    throw new Error(`Installer shortcuts were not created: ${JSON.stringify(shortcuts)}`);
  }

  const runner = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const e2e = await run(process.execPath, [runner, join(process.cwd(), "src", "electron", "e2e-launch.ts")], {
    QX_PACKAGED_EXECUTABLE: installedExecutable,
    QX_E2E_USER_DATA: e2eUserData,
  });
  if (e2e.code !== 0) {
    throw new Error(`Installed packaged E2E failed: ${JSON.stringify(e2e)}`);
  }

  const uninstall = await run(uninstaller, ["/S"]);
  const removed = await waitForRemoval([
    installDirectory,
    desktopShortcut,
    startMenuShortcut,
    ...(preexistingStartMenuDirectory ? [] : [startMenuDirectory]),
  ]);
  if (uninstall.code !== 0 || !removed) {
    throw new Error(`Installer uninstall failed: ${JSON.stringify({
      uninstall,
      removed,
      remaining: [installDirectory, desktopShortcut, startMenuShortcut, startMenuDirectory].filter((path) => existsSync(path)),
    })}`);
  }
  const userDataRetained = existsSync(e2eUserData);
  if (!userDataRetained) throw new Error("Installer uninstall removed user data unexpectedly");

  console.log(JSON.stringify({
    probe: "nsis-installer-e2e",
    status: "passed",
    installedExecutable,
    uninstaller: uninstallerName,
    shortcuts,
    install: { code: install.code, signal: install.signal },
    packagedE2e: { code: e2e.code, signal: e2e.signal },
    uninstall: { code: uninstall.code, signal: uninstall.signal },
    removed,
    userDataRetained,
  }, null, 2));
} finally {
  for (const { source, backup } of shortcutBackups) {
    if (!existsSync(backup)) continue;
    if (existsSync(source)) rmSync(source, { force: true });
    mkdirSync(dirname(source), { recursive: true });
    renameSync(backup, source);
  }
  await removeDirectory(workDirectory);
}

async function removeDirectory(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  if (existsSync(path)) throw lastError;
}

async function waitForRemoval(paths: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (paths.every((path) => !existsSync(path))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return paths.every((path) => !existsSync(path));
}

function run(
  executable: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...environment },
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
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
