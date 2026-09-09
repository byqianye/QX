import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version?: string };
const version = packageJson.version ?? "";
const oldInstaller = resolve(process.env.QX_RC_OLD_INSTALLER_PATH ?? join(projectRoot, "release", "QX影视-Setup-0.1.0-x64.exe"));
const rcInstaller = resolve(process.env.QX_RC_INSTALLER_PATH ?? join(projectRoot, "release", "rc", `QX影视-RC-Setup-${version}-x64.exe`));
if (!existsSync(oldInstaller)) throw new Error(`Old installer is missing: ${oldInstaller}`);
if (!existsSync(rcInstaller)) throw new Error(`RC installer is missing: ${rcInstaller}`);

const work = mkdtempSync(join(tmpdir(), "qx-rc-upgrade-"));
const installDirectory = join(work, "安装目录");
const userData = join(work, "user-data");
const marker = join(userData, "upgrade-marker.txt");
const installedExecutable = join(installDirectory, "QX影视.exe");
const desktop = join(process.env.USERPROFILE ?? "", "Desktop", "QX影视.lnk");
const startMenu = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "QX影视", "QX影视.lnk");
const backups = [desktop, startMenu].filter((path) => existsSync(path)).map((source) => ({ source, backup: join(work, `${source.includes("Desktop") ? "desktop" : "start-menu"}.lnk`) }));

try {
  for (const entry of backups) renameSync(entry.source, entry.backup);
  mkdirSync(userData, { recursive: true });
  writeFileSync(marker, "preserve-me\n", "utf8");
  const firstInstall = await run(oldInstaller, ["/S", `/D=${installDirectory}`], {});
  assertCode("RC1 install", firstInstall, 0);
  const before = await runPackagedSmoke();
  assertCode("RC1 packaged smoke", before, 0);
  const upgrade = await run(rcInstaller, ["/S", `/D=${installDirectory}`], {});
  assertCode("RC upgrade install", upgrade, 0);
  const after = await runPackagedSmoke();
  assertCode("RC2 packaged smoke", after, 0);
  if (!existsSync(marker)) throw new Error("Upgrade removed user data marker");
  const uninstaller = (await import("node:fs")).readdirSync(installDirectory).map((name) => join(installDirectory, name)).find((path) => /uninstall.*\.exe$/iu.test(path));
  if (!uninstaller) throw new Error("RC uninstaller missing after upgrade");
  const uninstall = await run(uninstaller, ["/S"], {});
  assertCode("post-upgrade uninstall", uninstall, 0);
  writeFileSync(join(projectRoot, "docs/reports/testing/WINDOWS-RC-UPGRADE-TEST.md"), [
    "# Windows RC Upgrade E2E",
    "",
    `RC1 installer: ${oldInstaller}`,
    `RC2 installer: ${rcInstaller}`,
    "",
    "User data marker survived the installer upgrade and the post-upgrade packaged smoke.",
    "",
    "```text",
    `RC1 install: ${firstInstall.code}`,
    `RC1 smoke: ${before.code}`,
    `RC2 install: ${upgrade.code}`,
    `RC2 smoke: ${after.code}`,
    `Uninstall: ${uninstall.code}`,
    "```",
    "",
    "UPGRADE = PASS",
    "",
  ].join("\n"), "utf8");
  console.log(JSON.stringify({ status: "PASS", markerPreserved: existsSync(marker), rc1: before.code, rc2: after.code, uninstall: uninstall.code }, null, 2));
} finally {
  for (const entry of backups) {
    if (!existsSync(entry.backup)) continue;
    if (existsSync(entry.source)) rmSync(entry.source, { force: true });
    mkdirSync(resolve(entry.source, ".."), { recursive: true });
    renameSync(entry.backup, entry.source);
  }
  await removeWorkDirectory(work);
}

async function runPackagedSmoke(): Promise<ProcessResult> {
  return run(installedExecutable, [], { QX_ELECTRON_SMOKE: "1", QX_E2E_USER_DATA: userData });
}

interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function run(executable: string, args: string[], variables: Record<string, string>): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, env: { ...process.env, ...variables }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

function assertCode(name: string, result: ProcessResult, expected: number): void {
  if (result.code !== expected) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
}

async function removeWorkDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  if (existsSync(path)) console.error(`RC upgrade temp cleanup deferred: ${path}`);
}
