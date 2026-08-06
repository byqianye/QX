import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { buildJvmArtifacts, removeJvmArtifacts, resolveJdkTool } from "../spikes/jvm-build.js";
import { resolveJavaExecutable } from "../spikes/java-probe.js";
import {
  inspectJavaRuntime,
  isPinnedTemurin,
  jlinkArguments,
  PINNED_TEMURIN,
  MINIMAL_JRE_MODULES,
  resolveJlinkExecutable,
  type JavaRuntimeInspection,
} from "./jre.js";

const outputDirectory = join(process.cwd(), "dist", "electron-runtime");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Spike18 runtime packaging currently targets Windows x64 only");
}

const buildJdk = resolveBuildJdk();
console.log(`electron runtime toolchain: ${buildJdk.source} ${buildJdk.inspection.version ?? "unknown"}`);
const artifacts = await buildJvmArtifacts(buildJdk.javaExecutable);
try {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(artifacts.hostJar, join(outputDirectory, "jvm-spider-host.jar"));
  await copyFile(artifacts.spiderJar, join(outputDirectory, "jvm-spiders.jar"));

  const jreDirectory = join(outputDirectory, "jre");
  buildMinimalJre(buildJdk.javaExecutable, jreDirectory);
  await writeFile(
    join(outputDirectory, "runtime-manifest.json"),
    `${JSON.stringify({
      spike: "18",
      target: "windows-x64",
      jre: {
        distribution: PINNED_TEMURIN.distribution,
        version: PINNED_TEMURIN.version,
        modules: MINIMAL_JRE_MODULES,
        toolchainSource: buildJdk.source,
        toolchainVendor: buildJdk.inspection.vendor,
        toolchainVersion: buildJdk.inspection.version,
        toolchainDataModel: buildJdk.inspection.dataModel,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  console.log(`electron runtime: ${outputDirectory}`);
} finally {
  await removeJvmArtifacts(artifacts);
}

interface BuildJdk {
  javaExecutable: string;
  source: "pinned-temurin" | "development-fallback";
  inspection: JavaRuntimeInspection;
}

function resolveBuildJdk(): BuildJdk {
  const configuredRoot = process.env.QX_TEMURIN_JDK;
  if (configuredRoot) {
    const javaExecutable = resolveTemurinJava(configuredRoot);
    if (!javaExecutable) {
      throw new Error(`QX_TEMURIN_JDK does not contain bin\\java.exe: ${configuredRoot}`);
    }
    const inspection = inspectJavaRuntime(javaExecutable);
    if (!isPinnedTemurin(inspection)) {
      throw new Error(
        `QX_TEMURIN_JDK must be Eclipse Temurin ${PINNED_TEMURIN.version}; `
        + `found ${inspection.vendor ?? "unknown vendor"} ${inspection.version ?? "unknown version"}`,
      );
    }
    return { javaExecutable, source: "pinned-temurin", inspection };
  }

  const javaExecutable = resolveJavaExecutable();
  if (!javaExecutable) {
    throw new Error(
      `No build JDK found. Set QX_TEMURIN_JDK to Eclipse Temurin ${PINNED_TEMURIN.version}`,
    );
  }
  const inspection = inspectJavaRuntime(javaExecutable);
  console.warn(
    `Spike18 development fallback: set QX_TEMURIN_JDK for the pinned `
    + `${PINNED_TEMURIN.distribution} ${PINNED_TEMURIN.version}; `
    + `using ${inspection.vendor ?? "unknown vendor"} ${inspection.version ?? "unknown version"}`,
  );
  return { javaExecutable, source: "development-fallback", inspection };
}

function resolveTemurinJava(root: string): string | null {
  const candidate = join(root, "bin", "java.exe");
  return resolveJdkTool(candidate, "java") ? candidate : null;
}

function buildMinimalJre(javaExecutable: string, outputDirectory: string): void {
  const jlinkExecutable = resolveJlinkExecutable(javaExecutable, "win32");
  if (!jlinkExecutable) {
    throw new Error("The selected JDK does not provide a runnable jlink.exe");
  }
  runTool(jlinkExecutable, jlinkArguments(outputDirectory), "jlink minimal JRE");
}

function runTool(executable: string, args: string[], label: string): void {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (!result.error && result.status === 0) return;

  const details = String(result.stderr || result.stdout || result.error?.message || "unknown error").trim();
  throw new Error(`${label} failed: ${details}`);
}
