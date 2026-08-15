import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AndroidDeviceManager } from "../src/spider/android-device-manager.js";
import { AndroidSpiderBridgeClient } from "../src/spider/android-spider-bridge-client.js";
import { buildAndroidRuntimeManifest } from "../src/spider/android-runtime-manifest.js";

const projectRoot = resolve(import.meta.dirname, "..");
const apkPath = process.env.QX_ANDROID_HOST_APK?.trim()
  || join(projectRoot, "android-spider-host", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const qxRuntimeRoot = process.env.QX_ANDROID_RUNTIME_ROOT?.trim()
  || join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "QXMovie", "android-runtime");
const qxSdkPath = join(qxRuntimeRoot, "sdk");
const qxAdbPath = join(qxSdkPath, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const qxEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  QX_ANDROID_HOME: qxSdkPath,
  QX_ANDROID_AVD_HOME: join(qxRuntimeRoot, "avd"),
  ANDROID_HOME: qxSdkPath,
  ANDROID_SDK_ROOT: qxSdkPath,
  ANDROID_AVD_HOME: join(qxRuntimeRoot, "avd"),
  ANDROID_USER_HOME: join(qxRuntimeRoot, "state", "android-user"),
  ANDROID_EMULATOR_HOME: join(qxRuntimeRoot, "state", "android-user"),
  ANDROID_ADB_SERVER_PORT: "5038",
  ADB_SERVER_SOCKET: "tcp:5038",
  ADB: qxAdbPath,
  Path: [join(qxSdkPath, "platform-tools"), join(qxSdkPath, "emulator"), join(qxSdkPath, "cmdline-tools", "latest", "bin"), process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32"].join(";"),
};

async function main(): Promise<void> {
  const command = process.argv[2] ?? "check";
  if (command === "build") {
    buildAndroidHost();
    return;
  }

  const manager = new AndroidDeviceManager({
    sdkPath: process.env.QX_ANDROID_SDK_PATH?.trim() || qxSdkPath,
    adbPath: process.env.ADB?.trim() || qxAdbPath,
    env: qxEnvironment,
    ...(process.env.QX_ANDROID_DEVICE_SERIAL ? { serial: process.env.QX_ANDROID_DEVICE_SERIAL } : {}),
  });
  if (command === "install") {
    requireApk();
    await manager.waitForBoot();
    await manager.install(apkPath);
    console.log(JSON.stringify({ status: "PASS", operation: "install", apkPath, device: await manager.requireDevice() }, null, 2));
    return;
  }
  if (command === "start") {
    await manager.waitForBoot();
    if (!(await manager.isHostInstalled())) throw new Error("HOST_NOT_INSTALLED: run npm run android-host:install first");
    await manager.startHost();
    const client = new AndroidSpiderBridgeClient({ deviceManager: manager });
    try {
      const health = await client.connect();
      console.log(JSON.stringify({ status: "PASS", operation: "start", health }, null, 2));
    } finally {
      await client.close();
    }
    return;
  }
  if (command === "stop") {
    await manager.stopHost();
    console.log(JSON.stringify({ status: "PASS", operation: "stop" }, null, 2));
    return;
  }
  if (command !== "check") throw new Error(`Unknown android-host command: ${command}`);
  await checkAndroidHost(manager);
}

async function checkAndroidHost(manager: AndroidDeviceManager): Promise<void> {
  if (!existsSync(qxSdkPath) && !process.env.QX_ANDROID_SDK_PATH?.trim()) {
    console.log(JSON.stringify({
      status: "BLOCKED",
      runtimeRoot: qxRuntimeRoot,
      sdk: { found: false, path: qxSdkPath },
      adb: { found: false, path: qxAdbPath },
      blockers: ["QX_RUNTIME_NOT_PROVISIONED"],
    }, null, 2));
    return;
  }
  const environment = await manager.check();
  const hostApkFound = existsSync(apkPath);
  let hostInstalled = false;
  let hostOnline = false;
  let health: Record<string, unknown> | undefined;
  if (environment.deviceFound) {
    hostInstalled = await manager.isHostInstalled();
    if (hostInstalled) {
      const client = new AndroidSpiderBridgeClient({ deviceManager: manager });
      try {
        health = await client.connect();
        hostOnline = true;
      } catch {
        hostOnline = false;
      } finally {
        await client.close();
      }
    }
  }
  const blockers = [
    ...environment.diagnostics,
    ...(hostApkFound ? [] : ["HOST_APK_NOT_FOUND"]),
    ...(environment.deviceFound && !hostInstalled ? ["HOST_NOT_INSTALLED"] : []),
    ...(hostInstalled && !hostOnline ? ["HOST_OFFLINE"] : []),
  ];
  const status = environment.sdkFound && environment.adbFound && environment.deviceFound && hostApkFound && hostInstalled && hostOnline
    ? "PASS"
    : "BLOCKED";
  console.log(JSON.stringify({
    status,
    runtimeRoot: qxRuntimeRoot,
    sdk: { found: environment.sdkFound, path: environment.sdkPath },
    adb: { found: environment.adbFound, path: environment.adbPath, version: environment.adbVersion },
    emulator: { found: environment.emulatorFound, path: environment.emulatorPath, avds: environment.avds },
    device: {
      found: environment.deviceFound,
      serial: environment.device?.serial,
      model: environment.device?.model,
      androidVersion: environment.device?.androidVersion,
      sdkInt: environment.device?.sdkInt,
      abi: environment.device?.abi,
      bootCompleted: environment.device?.bootCompleted,
      devices: environment.devices,
    },
    hostApk: { found: hostApkFound, path: apkPath },
    hostInstalled,
    hostOnline,
    androidHostAvailable: hostOnline,
    health,
    blockers: [...new Set(blockers)],
  }, null, 2));
}

function buildAndroidHost(): void {
  const sdkPath = resolveSdkPath();
  if (!sdkPath) throw new Error("ANDROID_SDK_NOT_FOUND: set QX_ANDROID_SDK_PATH, ANDROID_HOME, or ANDROID_SDK_ROOT");
  const gradle = resolveGradle();
  if (!gradle) throw new Error("GRADLE_NOT_FOUND: set QX_GRADLE_PATH or install Gradle 8.8");
  const javaHome = resolveJavaHome();
  const env = {
    ...process.env,
    ANDROID_HOME: sdkPath,
    ANDROID_SDK_ROOT: sdkPath,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    Path: `${join(sdkPath, "platform-tools")};${join(sdkPath, "cmdline-tools", "latest", "bin")};${javaHome ? join(javaHome, "bin") : ""};${process.env.Path ?? process.env.PATH ?? ""}`,
  };
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : gradle;
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "call", gradle, "hostUnitTest", "assembleDebug"]
    : ["hostUnitTest", "assembleDebug"];
  const result = spawnSync(command, args, {
    cwd: join(projectRoot, "android-spider-host"),
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) writeAndroidRuntimeManifest();
  process.exitCode = result.status ?? 1;
}

function writeAndroidRuntimeManifest(): void {
  if (!existsSync(apkPath)) throw new Error(`HOST_APK_NOT_FOUND: ${apkPath}`);
  const sha256 = createHash("sha256").update(readFileSync(apkPath)).digest("hex");
  const output = join(projectRoot, "build", "android-runtime-manifest.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(buildAndroidRuntimeManifest(sha256), null, 2)}\n`, "utf8");
  console.log(`Android runtime manifest: ${output}`);
}

function requireApk(): void {
  if (!existsSync(apkPath)) throw new Error(`HOST_APK_NOT_FOUND: ${apkPath}; run npm run android-host:build first`);
}

function resolveSdkPath(): string | undefined {
  const manager = new AndroidDeviceManager({
    ...(process.env.QX_ANDROID_SDK_PATH ? { sdkPath: process.env.QX_ANDROID_SDK_PATH } : {}),
  });
  return manager.sdkPath;
}

function resolveGradle(): string | undefined {
  const explicit = process.env.QX_GRADLE_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const wrapper = join(projectRoot, "android-spider-host", process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (existsSync(wrapper)) return wrapper;
  const cachedRoot = join(homedir(), ".gradle", "wrapper", "dists");
  const cached = findFile(cachedRoot, process.platform === "win32" ? "gradle.bat" : "gradle", 5);
  if (cached) return cached;
  return process.platform === "win32" ? "gradle.bat" : "gradle";
}

function resolveJavaHome(): string | undefined {
  const explicit = process.env.JAVA_HOME?.trim();
  if (explicit && existsSync(join(explicit, "bin", process.platform === "win32" ? "java.exe" : "java"))) return explicit;
  if (process.platform !== "win32") return undefined;
  const javaRoot = process.env.ProgramFiles ? join(process.env.ProgramFiles, "Java") : "C:\\Program Files\\Java";
  const candidates = existsSync(javaRoot) ? readdirSync(javaRoot, { withFileTypes: true }) : [];
  const directory = candidates.find((entry) => entry.isDirectory() && /^jdk-21/u.test(entry.name));
  return directory ? join(javaRoot, directory.name) : undefined;
}

function findFile(root: string, name: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
