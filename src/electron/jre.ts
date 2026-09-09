import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

export const PINNED_TEMURIN = {
  distribution: "Eclipse Temurin",
  version: "21.0.7+6",
  platform: "windows-x64",
  archive: "OpenJDK21U-jdk_x64_windows_hotspot_21.0.7_6.zip",
  downloadUrl: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.7%2B6/OpenJDK21U-jdk_x64_windows_hotspot_21.0.7_6.zip",
  sha256: "38f4b9fa0b36def9812f6576fd45f6224630477db8c4e669ee78eaa35abb9195",
} as const;

// The JDK XML module is required by the JVM host in addition to the base
// modules used by QX.
export const MINIMAL_JRE_MODULES = ["java.base", "java.net.http", "java.xml", "java.logging", "java.desktop", "jdk.crypto.ec"] as const;

export interface JavaRuntimeInspection {
  version: string | null;
  vendor: string | null;
  dataModel: string | null;
  output: string;
}

export function resolveBundledJavaExecutable(
  resourcesDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const executable = platform === "win32" ? "java.exe" : "java";
  const candidate = join(resourcesDirectory, "jre", "bin", executable);
  return existsSync(candidate) ? candidate : null;
}

export function resolveJlinkExecutable(
  javaExecutable: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const tool = platform === "win32" ? "jlink.exe" : "jlink";
  const javaName = basename(javaExecutable).toLowerCase();
  const sibling = javaName === "java.exe" || javaName === "java"
    ? join(dirname(javaExecutable), tool)
    : null;
  const candidates = [sibling, tool, "jlink"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  return [...new Set(candidates)].find((candidate) => canRun(candidate)) ?? null;
}

export function jlinkArguments(outputDirectory: string): string[] {
  return [
    "--add-modules",
    MINIMAL_JRE_MODULES.join(","),
    "--strip-debug",
    "--no-man-pages",
    "--no-header-files",
    "--compress=2",
    "--output",
    outputDirectory,
  ];
}

export function inspectJavaRuntime(javaExecutable: string): JavaRuntimeInspection {
  const result = spawnSync(javaExecutable, ["-XshowSettings:properties", "-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim();
  return {
    version: matchSetting(output, "java.runtime.version") ?? matchVersion(output),
    vendor: matchSetting(output, "java.vendor"),
    dataModel: matchSetting(output, "sun.arch.data.model"),
    output,
  };
}

export function isPinnedTemurin(inspection: JavaRuntimeInspection): boolean {
  return inspection.vendor?.toLowerCase().includes("eclipse") === true
    && inspection.version?.startsWith(PINNED_TEMURIN.version) === true
    && inspection.dataModel === "64";
}

function matchSetting(output: string, name: string): string | null {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m").exec(output);
  return match?.[1]?.trim() ?? null;
}

function matchVersion(output: string): string | null {
  const match = /version\s+"([^"]+)"/.exec(output);
  return match?.[1] ?? null;
}

function canRun(executable: string): boolean {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}
