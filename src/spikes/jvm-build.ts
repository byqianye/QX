import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveJavaExecutable } from "./java-probe.js";

export interface JvmArtifacts {
  workDir: string;
  hostJar: string;
  spiderJar: string;
}

export async function buildJvmArtifacts(javaExecutable = resolveJavaExecutable()): Promise<JvmArtifacts> {
  if (!javaExecutable) throw new Error("JDK 17+ is required to build the JVM Spider artifacts");

  const javacExecutable = resolveJdkTool(javaExecutable, "javac");
  const jarExecutable = resolveJdkTool(javaExecutable, "jar");
  if (!javacExecutable || !jarExecutable) {
    throw new Error("The JDK javac and jar tools are required to build the JVM Spider artifacts");
  }

  const workDir = await mkdtemp(join(tmpdir(), "qx-jvm-spike-"));
  try {
    const hostClasses = join(workDir, "host-classes");
    const spiderClasses = join(workDir, "spider-classes");
    await mkdir(hostClasses, { recursive: true });
    await mkdir(spiderClasses, { recursive: true });

    const sourceDir = fileURLToPath(new URL("../../fixtures/jvm/", import.meta.url));
    const hostSources = [
      join(sourceDir, "Spider.java"),
      join(sourceDir, "JsonCodec.java"),
      join(sourceDir, "JvmSpiderHost.java"),
    ];
    const fixtureSources = [
      join(sourceDir, "JsonCodec.java"),
      join(sourceDir, "HttpSpider.java"),
      join(sourceDir, "DoubanJvmSpider.java"),
      join(sourceDir, "PlayableJvmSpider.java"),
    ];
    const hostJar = join(workDir, "jvm-spider-host.jar");
    const spiderJar = join(workDir, "jvm-spiders.jar");

    runTool(javacExecutable, ["-encoding", "UTF-8", "-d", hostClasses, ...hostSources], "javac host");
    runTool(jarExecutable, ["--create", "--file", hostJar, "-C", hostClasses, "."], "jar host");
    runTool(
      javacExecutable,
      ["-encoding", "UTF-8", "-cp", hostJar, "-d", spiderClasses, ...fixtureSources],
      "javac spiders",
    );
    runTool(jarExecutable, ["--create", "--file", spiderJar, "-C", spiderClasses, "."], "jar spiders");

    return { workDir, hostJar, spiderJar };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function removeJvmArtifacts(artifacts: JvmArtifacts): Promise<void> {
  await rm(artifacts.workDir, { recursive: true, force: true });
}

export function resolveJdkTool(javaExecutable: string, tool: string): string | null {
  const executableName = process.platform === "win32" ? `${tool}.exe` : tool;
  const javaName = basename(javaExecutable).toLowerCase();
  const sibling = javaName === "java.exe" || javaName === "java"
    ? join(dirname(javaExecutable), executableName)
    : null;
  const candidates = [sibling, executableName, tool].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of [...new Set(candidates)]) {
    if (existsSync(candidate) || canRun(candidate)) return candidate;
  }
  return null;
}

function canRun(executable: string): boolean {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}

function runTool(executable: string, args: string[], label: string): void {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (!result.error && result.status === 0) return;

  const details = String(result.stderr || result.stdout || result.error?.message || "unknown error").trim();
  throw new Error(`${label} failed: ${details}`);
}
