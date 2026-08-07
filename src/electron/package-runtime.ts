import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
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
import {
  buildRuntimeManifest,
  hasExpectedArchiveHash,
  type BundledRuntimeId,
} from "./runtime-manifest.js";

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
  assertRuntimeArchive("jre", process.env.QX_TEMURIN_ARCHIVE, "temurin21.zip");
  await copyBundledRuntime("python", join(outputDirectory, "python"), resolveAssetRoot("QX_PYTHON_RUNTIME", "python-runtime"), assertRuntimeArchive("python", process.env.QX_PYTHON_ARCHIVE, "python-3.12.10-embed-amd64.zip"));
  await writePythonDependencyLock(join(outputDirectory, "python"));
  await copyBundledRuntime("mpv", join(outputDirectory, "mpv"), resolveAssetRoot("QX_MPV_RUNTIME", "mpv"), assertRuntimeArchive("mpv", process.env.QX_MPV_ARCHIVE, "mpv-x86_64-20260807-git-21277b0ccf.7z"));
  await copyBundledRuntime("aria2", join(outputDirectory, "aria2"), resolveAssetRoot("QX_ARIA2_RUNTIME", "aria2/aria2-1.37.0-win-64bit-build1"), assertRuntimeArchive("aria2", process.env.QX_ARIA2_ARCHIVE, "aria2-1.37.0-win-64bit-build1.zip"));
  const manifest = buildRuntimeManifest(outputDirectory);
  if (process.env.QX_RELEASE_BUILD === "1" && Object.values(manifest.runtimes).some((runtime) => !runtime.bundled)) {
    const missing = Object.values(manifest.runtimes).filter((runtime) => !runtime.bundled).map((runtime) => runtime.id);
    throw new Error(`Release runtime assets missing: ${missing.join(", ")}`);
  }
  await writeFile(
    join(outputDirectory, "runtime-manifest.json"),
    `${JSON.stringify({
      ...manifest,
      build: {
        toolchainSource: buildJdk.source,
        toolchainVendor: buildJdk.inspection.vendor,
        toolchainVersion: buildJdk.inspection.version,
        toolchainDataModel: buildJdk.inspection.dataModel,
        temurin: PINNED_TEMURIN,
        jreModules: MINIMAL_JRE_MODULES,
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

async function copyBundledRuntime(id: BundledRuntimeId, destination: string, source: string, archive: string | null): Promise<void> {
  if (process.env.QX_RELEASE_BUILD === "1" && !archive) throw new Error(`Missing ${id} runtime archive`);
  const executable = id === "python" ? join(source, "python.exe")
    : id === "mpv" ? join(source, "mpv.exe")
      : join(source, "aria2c.exe");
  if (!resolvePathExists(executable)) {
    if (process.env.QX_RELEASE_BUILD === "1") throw new Error(`Missing ${id} runtime asset: ${executable}`);
    console.warn(`Development runtime asset unavailable: ${id} (${source})`);
    return;
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function writePythonDependencyLock(directory: string): Promise<void> {
  if (!resolvePathExists(join(directory, "python.exe"))) return;
  await writeFile(join(directory, "requirements-lock.txt"), [
    "# QX影视 bundled CPython 3.12.10 embeddable runtime",
    "# Dependency policy: standard library only; no third-party packages are bundled.",
    "# Python embeddable isolation is enforced by python312._pth and PYTHONNOUSERSITE=1.",
    "# pip, PYTHONPATH, PYTHONHOME, PYTHONUSERBASE and VIRTUAL_ENV are not release inputs.",
    "",
  ].join("\n"), "utf8");
}

function assertRuntimeArchive(id: BundledRuntimeId, configured: string | undefined, fallbackName: string): string | null {
  const archive = configured?.trim() || join(process.cwd(), "dist", "release-assets", fallbackName);
  if (!existsSync(archive)) {
    if (process.env.QX_RELEASE_BUILD === "1") throw new Error(`Missing ${id} runtime archive: ${archive}`);
    return null;
  }
  if (!hasExpectedArchiveHash(id, archive)) {
    throw new Error(`Unexpected ${id} runtime archive SHA-256: ${archive}`);
  }
  return archive;
}

function resolveAssetRoot(variable: string, fallback: string): string {
  const configured = process.env[variable]?.trim();
  return configured ? configured : join(process.cwd(), "dist", "release-assets", fallback);
}

function resolvePathExists(path: string): boolean {
  return existsSync(path);
}
