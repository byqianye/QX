import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTvBoxConfig, type TvBoxConfig, type TvBoxSite } from "../config/decoder.js";
import { defaultConfigUrl } from "./config-probe.js";

const classProbeSource = fileURLToPath(new URL("./JvmClassProbe.java", import.meta.url));

export type JarArtifact = "android-dex-jar" | "jvm-jar" | "unknown";

export interface JvmClassProbeResult {
  status: "loaded" | "not-found" | "error" | "not-run";
  targetClass: string;
  javacExecutable: string | null;
  output: string | null;
}

export interface AndroidRuntimeProbeResult {
  adbAvailable: boolean;
  devices: string[];
  error: string | null;
}

export function selectCspSite(config: TvBoxConfig): TvBoxSite {
  const site = config.sites?.find((candidate) => candidate.api === "csp_Douban");
  if (!site) throw new Error("The public config has no csp_Douban site");
  return site;
}

export function resolveCspTargetClass(api: string | undefined): string {
  if (!api || !/^csp_[A-Za-z0-9_$]+$/.test(api)) {
    throw new Error(`Unsupported csp API: ${api ?? "<missing>"}`);
  }
  return `com.github.catvod.spider.${api.slice("csp_".length)}`;
}

export function identifyJarArtifact(bytes: Buffer): JarArtifact {
  const zipMagic = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!zipMagic) return "unknown";
  if (bytes.includes(Buffer.from("classes.dex", "ascii"))) return "android-dex-jar";
  if (bytes.includes(Buffer.from(".class", "ascii"))) return "jvm-jar";
  return "unknown";
}

export async function runJavaProbe(url = process.env.QX_SPIKE_CONFIG_URL ?? defaultConfigUrl) {
  const configResponse = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!configResponse.ok) throw new Error(`Config request failed: HTTP ${configResponse.status}`);
  const config = parseTvBoxConfig(await configResponse.text());
  const site = selectCspSite(config);
  const targetClass = resolveCspTargetClass(site.api);
  if (!config.spider) throw new Error("The public config has no global spider URL");

  const [spiderUrl, expectedMd5] = config.spider.split(";md5;");
  if (!spiderUrl) throw new Error("The public spider value has no URL");
  const jarResponse = await fetch(spiderUrl, { signal: AbortSignal.timeout(60_000) });
  if (!jarResponse.ok) throw new Error(`Spider download failed: HTTP ${jarResponse.status}`);

  const bytes = Buffer.from(await jarResponse.arrayBuffer());
  const actualMd5 = createHash("md5").update(bytes).digest("hex");
  const artifactType = identifyJarArtifact(bytes);
  const javaExecutable = resolveJavaExecutable();
  const javaVersion = javaExecutable ? readVersion(javaExecutable) : null;
  const androidRuntime = inspectAndroidRuntime();
  const workDir = await mkdtemp(join(tmpdir(), "qx-csp-douban-probe-"));

  try {
    const artifactPath = join(workDir, "spider.jar");
    await writeFile(artifactPath, bytes);
    const jvmClassLoad = javaExecutable
      ? runJvmClassProbe(javaExecutable, artifactPath, targetClass, workDir)
      : {
          status: "not-run" as const,
          targetClass,
          javacExecutable: null,
          output: "Java executable was not found",
        };

    const reason = artifactType === "android-dex-jar"
      ? "ANDROID_DEX_NOT_LOADABLE_BY_JVM"
      : !javaExecutable
        ? "JAVA_RUNTIME_NOT_FOUND"
        : jvmClassLoad.status !== "loaded"
          ? "JVM_CLASS_NOT_LOADABLE"
          : "JVM_INIT_HOME_NOT_IMPLEMENTED";

    return {
      probe: "java",
      target: {
        api: site.api,
        key: site.key ?? null,
        name: site.name ?? null,
        className: targetClass,
        requiredMethods: ["init", "homeContent"],
      },
      status: "blocked" as const,
      reason,
      source: url,
      spiderUrl,
      expectedMd5: expectedMd5?.trim() || null,
      actualMd5,
      md5Matches: Boolean(expectedMd5 && expectedMd5.trim().toLowerCase() === actualMd5),
      artifactType,
      byteLength: bytes.length,
      javaAvailable: Boolean(javaExecutable),
      javaExecutable,
      javaVersion,
      jvmClassLoad,
      androidRuntime,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function resolveJavaExecutable(): string | null {
  for (const candidate of unique(javaCandidates())) {
    if (works(candidate, ["--version"])) return candidate;
  }
  return null;
}

export function inspectAndroidRuntime(adb = process.env.QX_ADB ?? "adb"): AndroidRuntimeProbeResult {
  const result = spawnSync(adb, ["devices"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    return {
      adbAvailable: false,
      devices: [],
      error: result.error?.message ?? String(result.stderr ?? "adb failed").trim(),
    };
  }

  const devices = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0] as string);

  return { adbAvailable: true, devices, error: null };
}

function runJvmClassProbe(
  javaExecutable: string,
  artifactPath: string,
  targetClass: string,
  workDir: string,
): JvmClassProbeResult {
  const javacExecutable = resolveJavacExecutable(javaExecutable);
  if (!javacExecutable) {
    return {
      status: "not-run",
      targetClass,
      javacExecutable: null,
      output: "javac executable was not found",
    };
  }

  const compile = spawnSync(javacExecutable, ["-d", workDir, classProbeSource], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (compile.error || compile.status !== 0) {
    return {
      status: "error",
      targetClass,
      javacExecutable,
      output: String(compile.stderr ?? compile.error?.message ?? "javac failed").trim(),
    };
  }

  const run = spawnSync(javaExecutable, ["-cp", workDir, "JvmClassProbe", artifactPath, targetClass], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${String(run.stdout ?? "")}\n${String(run.stderr ?? "")}`.trim();
  const marker = output.split(/\r?\n/, 1)[0]?.split("\t", 1)[0];
  const status = marker === "LOADED"
    ? "loaded"
    : marker === "NOT_FOUND"
      ? "not-found"
      : "error";

  return { status, targetClass, javacExecutable, output: output || null };
}

function resolveJavacExecutable(javaExecutable: string): string | null {
  const javaName = basename(javaExecutable).toLowerCase();
  const sibling = javaName === "java.exe" || javaName === "java"
    ? join(dirname(javaExecutable), process.platform === "win32" ? "javac.exe" : "javac")
    : null;
  const candidates = [
    process.env.QX_JAVAC,
    sibling,
    process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "javac.exe" : "javac")
      : undefined,
    "javac",
  ].filter((candidate): candidate is string => Boolean(candidate));

  return unique(candidates).find((candidate) => works(candidate, ["-version"])) ?? null;
}

function javaCandidates(): string[] {
  const candidates = [
    process.env.QX_JAVA,
    process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : undefined,
    "java",
  ].filter((candidate): candidate is string => Boolean(candidate));

  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const javaRoot = join(programFiles, "Java");
    if (existsSync(javaRoot)) {
      for (const entry of readdirSync(javaRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().includes("jdk")) continue;
        candidates.push(join(javaRoot, entry.name, "bin", "java.exe"));
      }
    }
  }

  return candidates;
}

function readVersion(executable: string): string | null {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
  return String(result.stdout ?? result.stderr ?? "").trim() || null;
}

function works(executable: string, args: string[]): boolean {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

if (isMain()) {
  runJavaProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}

function isMain(): boolean {
  return process.argv[1]?.endsWith("java-probe.ts") ?? false;
}
