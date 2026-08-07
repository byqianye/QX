import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveJavaExecutable } from "../spikes/java-probe.js";
import { resolveBundledJavaExecutable } from "./jre.js";
import {
  runtimeExecutablePath,
  validateBundledRuntime,
  type BundledRuntimeId,
} from "./runtime-manifest.js";

export interface ElectronRuntime {
  javaExecutable: string;
  hostJar: string;
  spiderJar: string;
  spiderClass: string;
  runtimeSource: "bundled-jre" | "external-java";
  pythonExecutable?: string;
  mpvExecutable?: string;
  aria2Executable?: string;
}

export type ElectronRuntimeErrorCode =
  | "BUNDLED_JRE_MISSING"
  | "JAVA_RUNTIME_NOT_FOUND"
  | "JVM_ARTIFACTS_NOT_FOUND"
  | "RUNTIME_INTEGRITY_FAILED";

export interface ElectronRuntimeResolutionOptions {
  allowBundledJre?: boolean;
  allowExternalJava?: boolean;
  requireBundledRuntimeManifest?: boolean;
}

export interface ElectronRuntimeError {
  status: "error";
  code: ElectronRuntimeErrorCode;
  message: string;
}

export type ElectronRuntimeResolution =
  | { status: "ready"; runtime: ElectronRuntime }
  | ElectronRuntimeError;

export function resolveElectronRuntime(
  resourcesDirectory: string,
  javaResolver: () => string | null = resolveJavaExecutable,
  options: ElectronRuntimeResolutionOptions = {},
): ElectronRuntimeResolution {
  const allowBundledJre = options.allowBundledJre ?? true;
  const allowExternalJava = options.allowExternalJava ?? true;
  const requireBundledRuntimeManifest = options.requireBundledRuntimeManifest ?? false;
  const bundledRuntimeError = validateRequiredBundledRuntimes(resourcesDirectory, requireBundledRuntimeManifest);
  if (bundledRuntimeError) return bundledRuntimeError;
  const bundledJava = allowBundledJre ? resolveBundledJavaExecutable(resourcesDirectory) : null;
  const javaExecutable = bundledJava ?? (allowExternalJava ? javaResolver() : null);
  if (!javaExecutable) {
    return {
      status: "error",
      code: requireBundledRuntimeManifest ? "BUNDLED_JRE_MISSING" : "JAVA_RUNTIME_NOT_FOUND",
      message: "未找到可运行 JVM Spider sidecar 的 Java 运行时：包内精简 JRE 缺失，且未找到外部 Java。开发环境可安装 JDK 21 或设置 JAVA_HOME。",
    };
  }

  const hostJar = join(resourcesDirectory, "jvm-spider-host.jar");
  const spiderJar = join(resourcesDirectory, "jvm-spiders.jar");
  const missing = [hostJar, spiderJar].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    return {
      status: "error",
      code: "JVM_ARTIFACTS_NOT_FOUND",
      message: `未找到 JVM Spider 运行时资源：${missing.join("、")}`,
    };
  }

  return {
    status: "ready",
    runtime: {
      javaExecutable,
      hostJar,
      spiderJar,
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      runtimeSource: bundledJava ? "bundled-jre" : "external-java",
      ...(resolveBundledRuntime(resourcesDirectory, "python") ? { pythonExecutable: runtimeExecutablePath(resourcesDirectory, "python") } : {}),
      ...(resolveBundledRuntime(resourcesDirectory, "mpv") ? { mpvExecutable: runtimeExecutablePath(resourcesDirectory, "mpv") } : {}),
      ...(resolveBundledRuntime(resourcesDirectory, "aria2") ? { aria2Executable: runtimeExecutablePath(resourcesDirectory, "aria2") } : {}),
    },
  };
}

function validateRequiredBundledRuntimes(
  resourcesDirectory: string,
  required: boolean,
): ElectronRuntimeError | null {
  if (!required) return null;
  for (const id of ["jre", "python", "mpv", "aria2"] as const) {
    const result = validateBundledRuntime(resourcesDirectory, id, true);
    if (result === "integrity-failed") {
      return {
        status: "error",
        code: "RUNTIME_INTEGRITY_FAILED",
        message: `包内 ${id} runtime 校验失败：文件缺失或 SHA-256 不匹配。`,
      };
    }
    if (result === "missing") {
      return {
        status: "error",
        code: id === "jre" ? "BUNDLED_JRE_MISSING" : "RUNTIME_INTEGRITY_FAILED",
        message: `包内 ${id} runtime 缺失；发布包不使用系统 PATH、JAVA_HOME 或用户 Python。`,
      };
    }
  }
  return null;
}

function resolveBundledRuntime(resourcesDirectory: string, id: BundledRuntimeId): boolean {
  return validateBundledRuntime(resourcesDirectory, id, false) === "ready";
}

export function sanitizedPackagedPythonEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const name of ["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE", "VIRTUAL_ENV"]) delete clean[name];
  clean.PYTHONNOUSERSITE = "1";
  return clean;
}
