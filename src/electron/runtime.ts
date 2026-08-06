import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveJavaExecutable } from "../spikes/java-probe.js";
import { resolveBundledJavaExecutable } from "./jre.js";

export interface ElectronRuntime {
  javaExecutable: string;
  hostJar: string;
  spiderJar: string;
  spiderClass: string;
  runtimeSource: "bundled-jre" | "external-java";
}

export type ElectronRuntimeErrorCode = "JAVA_RUNTIME_NOT_FOUND" | "JVM_ARTIFACTS_NOT_FOUND";

export interface ElectronRuntimeResolutionOptions {
  allowBundledJre?: boolean;
  allowExternalJava?: boolean;
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
  const bundledJava = allowBundledJre ? resolveBundledJavaExecutable(resourcesDirectory) : null;
  const javaExecutable = bundledJava ?? (allowExternalJava ? javaResolver() : null);
  if (!javaExecutable) {
    return {
      status: "error",
      code: "JAVA_RUNTIME_NOT_FOUND",
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
    },
  };
}
