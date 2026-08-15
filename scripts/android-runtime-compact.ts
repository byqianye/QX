import { existsSync } from "node:fs";
import { join } from "node:path";

import { AndroidRuntimeBootstrapper } from "../src/spider/android-runtime-bootstrapper.js";
import type { AndroidRuntimePaths } from "../src/spider/android-runtime-types.js";
import { ANDROID_RUNTIME_COMPACT_AVD_NAME } from "../src/spider/android-runtime-types.js";

const runtimeRoot = process.env.QX_ANDROID_RUNTIME_ROOT?.trim();

async function main(): Promise<void> {
  if (!runtimeRoot) throw new Error("QX_ANDROID_RUNTIME_ROOT_REQUIRED");
  const paths: AndroidRuntimePaths = {
    root: runtimeRoot,
    sdk: join(runtimeRoot, "sdk"),
    avd: join(runtimeRoot, "avd"),
    downloads: join(runtimeRoot, "downloads"),
    host: join(runtimeRoot, "host"),
    state: join(runtimeRoot, "state"),
  };
  const hostApkPath = join(paths.host, "android-spider-host.apk");
  if (!existsSync(hostApkPath)) throw new Error(`HOST_APK_NOT_FOUND: ${hostApkPath}`);
  const javaExecutable = process.env.QX_JAVA_EXECUTABLE?.trim()
    || join(process.env.ProgramFiles ?? "C:\\Program Files", "Java", "jdk-21", "bin", "java.exe");
  const bootstrapper = new AndroidRuntimeBootstrapper({
    paths,
    hostApkPath,
    avdName: ANDROID_RUNTIME_COMPACT_AVD_NAME,
    ...(existsSync(javaExecutable) ? { javaExecutable } : {}),
  });
  const state = await bootstrapper.ensureProvisioned({ consent: true });
  const doctor = await bootstrapper.environmentDoctor();
  const ready = state.bootstrapState === "READY" && doctor.whpx === "ready";
  console.log(JSON.stringify({
    status: ready ? "PASS" : "BLOCKED",
    runtimeRoot,
    avdName: ANDROID_RUNTIME_COMPACT_AVD_NAME,
    state,
    acceleration: doctor,
  }, null, 2));
  if (!ready) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
