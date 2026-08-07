import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_MANIFEST_VERSION = 1 as const;

export type BundledRuntimeId = "jre" | "python" | "mpv" | "aria2";

export interface BundledRuntimeEntry {
  id: BundledRuntimeId;
  bundled: boolean;
  vendor: string;
  architecture: "windows-x64";
  source: string;
  archive: string;
  license: string;
  executable: string;
  version: string;
  archiveSha256: string;
  executableSha256: string | null;
  licenseFiles: readonly string[];
}

export interface RuntimeManifest {
  schemaVersion: typeof RUNTIME_MANIFEST_VERSION;
  target: "windows-x64";
  runtimes: Record<BundledRuntimeId, BundledRuntimeEntry>;
}

export const FIXED_RUNTIME_DEFINITIONS: Record<BundledRuntimeId, Omit<BundledRuntimeEntry, "bundled" | "executableSha256">> = {
  jre: {
    id: "jre",
    vendor: "Eclipse Adoptium",
    architecture: "windows-x64",
    source: "https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.7%2B6",
    archive: "OpenJDK21U-jdk_x64_windows_hotspot_21.0.7_6.zip",
    license: "GPL-2.0-with-classpath-exception",
    executable: "jre/bin/java.exe",
    version: "Eclipse Temurin 21.0.7+6",
    archiveSha256: "38f4b9fa0b36def9812f6576fd45f6224630477db8c4e669ee78eaa35abb9195",
    licenseFiles: ["jre/NOTICE", "jre/legal"],
  },
  python: {
    id: "python",
    vendor: "Python Software Foundation",
    architecture: "windows-x64",
    source: "https://www.python.org/downloads/release/python-31210/",
    archive: "python-3.12.10-embed-amd64.zip",
    license: "PSF-2.0",
    executable: "python/python.exe",
    version: "CPython 3.12.10 embeddable",
    archiveSha256: "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
    licenseFiles: ["python/LICENSE.txt"],
  },
  mpv: {
    id: "mpv",
    vendor: "zhongfly/mpv-winbuild",
    architecture: "windows-x64",
    source: "https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-08-07-21277b0ccf",
    archive: "mpv-x86_64-20260807-git-21277b0ccf.7z",
    license: "GPL-2.0-or-later",
    executable: "mpv/mpv.exe",
    version: "mpv git 21277b0ccf (2026-08-07)",
    archiveSha256: "a49e0e1d821c7a907a7fda005d191359cec8a9f7885d631a4fe4ee30236b4e12",
    licenseFiles: ["mpv/doc/manual.pdf"],
  },
  aria2: {
    id: "aria2",
    vendor: "aria2",
    architecture: "windows-x64",
    source: "https://github.com/aria2/aria2/releases/tag/release-1.37.0",
    archive: "aria2-1.37.0-win-64bit-build1.zip",
    license: "GPL-2.0-or-later",
    executable: "aria2/aria2c.exe",
    version: "aria2 1.37.0",
    archiveSha256: "67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288",
    licenseFiles: ["aria2/COPYING", "aria2/LICENSE.OpenSSL"],
  },
};

export function runtimeExecutablePath(resourcesDirectory: string, id: BundledRuntimeId): string {
  return join(resourcesDirectory, FIXED_RUNTIME_DEFINITIONS[id].executable);
}

export function buildRuntimeManifest(resourcesDirectory: string): RuntimeManifest {
  const runtimes = Object.fromEntries(
    (Object.keys(FIXED_RUNTIME_DEFINITIONS) as BundledRuntimeId[]).map((id) => {
      const definition = FIXED_RUNTIME_DEFINITIONS[id];
      const executable = runtimeExecutablePath(resourcesDirectory, id);
      const bundled = existsSync(executable);
      return [id, {
        ...definition,
        bundled,
        executableSha256: bundled ? sha256File(executable) : null,
      } satisfies BundledRuntimeEntry];
    }),
  ) as Record<BundledRuntimeId, BundledRuntimeEntry>;

  return { schemaVersion: RUNTIME_MANIFEST_VERSION, target: "windows-x64", runtimes };
}

export function readRuntimeManifest(resourcesDirectory: string): RuntimeManifest | null {
  const path = join(resourcesDirectory, "runtime-manifest.json");
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isManifest(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function validateBundledRuntime(
  resourcesDirectory: string,
  id: BundledRuntimeId,
  requireManifest = true,
): "missing" | "integrity-failed" | "ready" {
  const manifest = readRuntimeManifest(resourcesDirectory);
  if (!manifest) return requireManifest ? "missing" : existsSync(runtimeExecutablePath(resourcesDirectory, id)) ? "ready" : "missing";
  const entry = manifest.runtimes[id];
  if (!entry?.bundled) return "missing";
  const executable = runtimeExecutablePath(resourcesDirectory, id);
  if (!existsSync(executable) || !entry.executableSha256) return "missing";
  return sha256File(executable) === entry.executableSha256 ? "ready" : "integrity-failed";
}

export function hasExpectedArchiveHash(id: BundledRuntimeId, archivePath: string): boolean {
  return sha256File(archivePath) === FIXED_RUNTIME_DEFINITIONS[id].archiveSha256;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isManifest(value: unknown): value is RuntimeManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RUNTIME_MANIFEST_VERSION || record.target !== "windows-x64") return false;
  if (typeof record.runtimes !== "object" || record.runtimes === null) return false;
  return (Object.keys(FIXED_RUNTIME_DEFINITIONS) as BundledRuntimeId[]).every((id) => {
    const entry = (record.runtimes as Record<string, unknown>)[id];
    return typeof entry === "object" && entry !== null
      && typeof (entry as Record<string, unknown>).executable === "string"
      && typeof (entry as Record<string, unknown>).vendor === "string"
      && (entry as Record<string, unknown>).architecture === "windows-x64"
      && typeof (entry as Record<string, unknown>).source === "string"
      && typeof (entry as Record<string, unknown>).archive === "string"
      && typeof (entry as Record<string, unknown>).license === "string"
      && typeof (entry as Record<string, unknown>).version === "string"
      && typeof (entry as Record<string, unknown>).archiveSha256 === "string"
      && typeof (entry as Record<string, unknown>).bundled === "boolean";
  });
}
