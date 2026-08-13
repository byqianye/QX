import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultConfigUrl } from "../src/spikes/config-probe.js";

const projectRoot = resolve(import.meta.dirname, "..");
const executable = resolve(projectRoot, process.argv[2] ?? "release/preview/win-unpacked/QX影视.exe");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("CLEAN_WINDOWS_ANDROID_E2E_REQUIRES_WINDOWS_X64");
}
if (!existsSync(executable)) throw new Error(`PREVIEW_EXECUTABLE_MISSING: ${executable}`);

clearHostAndroidEnvironment();
const preflight = assertCleanAndroidEnvironment();

const workDirectory = mkdtempSync(join(tmpdir(), "qx-clean-android-e2e-"));
const resultPath = join(workDirectory, "android-playback-result.json");
const runtimeRoot = join(requiredEnv("LOCALAPPDATA"), "QXMovie", "android-runtime");
const keepWorkDirectory = process.env.QX_ANDROID_E2E_KEEP_TEMP === "1";

try {
  const result = await run(executable, workDirectory, {
    QX_ANDROID_PACKAGED_PLAYBACK: "1",
    QX_ANDROID_E2E_CONFIG_URL: process.env.QX_ANDROID_E2E_CONFIG_URL?.trim() || defaultConfigUrl,
    QX_ANDROID_E2E_KEYWORD: process.env.QX_ANDROID_E2E_KEYWORD?.trim() || "庆余年",
    // This is a controlled test harness. The product flow still requires the native confirmation dialog.
    QX_ANDROID_E2E_CONSENT: "1",
    QX_E2E_RESULT_PATH: resultPath,
    QX_E2E_USER_DATA: join(workDirectory, "user-data"),
    // Keep the app process independent of host Android tooling. Runtime child
    // processes replace these values with the dedicated QX environment.
    PATH: "",
    Path: "",
    ANDROID_HOME: "",
    ANDROID_SDK_ROOT: "",
    ANDROID_AVD_HOME: "",
    ANDROID_USER_HOME: "",
    ANDROID_EMULATOR_HOME: "",
    ANDROID_SDK_HOME: "",
  });
  const report = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown> : undefined;
  const statePath = join(runtimeRoot, "state", "bootstrap-state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown> : undefined;
  const runtimeAudit = readRuntimeAudit(join(workDirectory, "user-data", "logs", "runtime.log"), runtimeRoot);
  const status = report?.status === "PASS"
    && state?.bootstrapState === "READY"
    && !runtimeAudit.systemAdbParticipated
    && !runtimeAudit.existingAndroidUserDirUsed
    && !runtimeAudit.androidStudioUsed
    ? "PASS"
    : "FAIL";
  const output = {
    status,
    cleanMachine: preflight.existingPaths.length === 0 && preflight.commands.length === 0,
    ...runtimeAudit,
    preflight,
    executable,
    runtimeRoot,
    bootstrapState: state?.bootstrapState ?? null,
    playback: report ?? null,
    process: { code: result.code, signal: result.signal },
  };
  console.log(JSON.stringify(output, null, 2));
  if (status !== "PASS") throw new Error(`CLEAN_WINDOWS_ANDROID_E2E_FAILED: ${JSON.stringify(output)}`);
} finally {
  if (keepWorkDirectory) {
    console.error(`CLEAN_WINDOWS_ANDROID_E2E_TEMP_RETAINED: ${workDirectory}`);
  } else {
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(workDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 });
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
    }
    if (cleanupError) {
      console.error(`CLEAN_WINDOWS_ANDROID_E2E_CLEANUP_FAILED: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

function clearHostAndroidEnvironment(): void {
  process.env.PATH = "";
  process.env.Path = "";
  for (const name of [
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_AVD_HOME",
    "ANDROID_USER_HOME",
    "ANDROID_EMULATOR_HOME",
    "ANDROID_SDK_HOME",
  ]) {
    process.env[name] = "";
  }
}

interface RuntimeAudit {
  runtimeLogPresent: boolean;
  systemAdbParticipated: boolean;
  existingAndroidUserDirUsed: boolean;
  androidStudioUsed: boolean;
}

function readRuntimeAudit(logPath: string, runtimeRoot: string): RuntimeAudit {
  const failure = {
    runtimeLogPresent: false,
    systemAdbParticipated: true,
    existingAndroidUserDirUsed: true,
    androidStudioUsed: true,
  } satisfies RuntimeAudit;
  if (!existsSync(logPath)) return failure;

  const qxAdbPath = normalizePath(join(runtimeRoot, "sdk", "platform-tools", "adb.exe"));
  const qxAndroidUserHome = normalizePath(join(runtimeRoot, "state", "android-user"));
  let parsed = 0;
  let systemAdbParticipated = false;
  let existingAndroidUserDirUsed = false;
  let androidStudioUsed = false;
  for (const line of readFileSync(logPath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      parsed += 1;
      for (const value of Object.values(entry)) {
        if (typeof value !== "string") continue;
        const normalized = normalizePath(value);
        if (normalized.includes("android studio") || normalized.includes("studio64.exe")) androidStudioUsed = true;
        if (normalized.includes("\\.android\\") || normalized.endsWith("\\.android")) existingAndroidUserDirUsed = true;
      }
      if (typeof entry.adbPath === "string" && normalizePath(entry.adbPath) !== qxAdbPath) systemAdbParticipated = true;
      if (typeof entry.androidUserHome === "string" && normalizePath(entry.androidUserHome) !== qxAndroidUserHome) existingAndroidUserDirUsed = true;
      if (typeof entry.serial === "string" && !entry.serial.startsWith("emulator-5554")) systemAdbParticipated = true;
      if (typeof entry.selectedSerial === "string" && !entry.selectedSerial.startsWith("emulator-5554")) systemAdbParticipated = true;
    } catch {
      return failure;
    }
  }
  if (parsed === 0) return failure;
  return { runtimeLogPresent: true, systemAdbParticipated, existingAndroidUserDirUsed, androidStudioUsed };
}

function normalizePath(value: string): string {
  return value.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
}

function assertCleanAndroidEnvironment(): { existingPaths: string[]; commands: string[]; runtimeRootExists: boolean } {
  const forbiddenPaths = [
    join(requiredEnv("ProgramFiles"), "Android", "Android Studio"),
    ...(process.env["ProgramFiles(x86)"] ? [join(process.env["ProgramFiles(x86)"], "Android", "Android Studio")] : []),
    join(requiredEnv("LOCALAPPDATA"), "Android", "Sdk"),
    join(homedir(), "Android", "Sdk"),
    join(homedir(), ".android"),
  ];
  const existingPaths = forbiddenPaths.filter((path) => existsSync(path));
  const commands = ["adb", "emulator", "sdkmanager", "avdmanager"]
    .filter((command) => commandOnPath(command));
  const runtimeRoot = join(requiredEnv("LOCALAPPDATA"), "QXMovie", "android-runtime");
  const result = { existingPaths, commands, runtimeRootExists: existsSync(runtimeRoot) };
  const allowExistingHost = process.env.QX_ANDROID_CLEAN_E2E_ALLOW_EXISTING_HOST === "1";
  if (!allowExistingHost && (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || existingPaths.length > 0 || commands.length > 0 || result.runtimeRootExists)) {
    throw new Error(`CLEAN_WINDOWS_ANDROID_E2E_PREFLIGHT_FAILED: ${JSON.stringify({ existingPaths, commands, runtimeRootExists: existsSync(runtimeRoot) })}`);
  }
  return result;
}

function commandOnPath(command: string): boolean {
  const result = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CLEAN_WINDOWS_ANDROID_E2E_ENV_MISSING: ${name}`);
  return value;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(file: string, cwd: string, variables: Record<string, string>): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [], {
      cwd,
      env: { ...process.env, ...variables },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}
