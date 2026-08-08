import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { parseTvBoxConfig, type TvBoxSite } from "../config/decoder.js";
import { normalizeFongMiSite } from "../config/fongmi.js";
import { JarInspector } from "../spider/jar-inspector.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { SpiderArtifactResolver } from "../spider/spider-artifact-resolver.js";
import { RuntimeAuditService } from "../spider/runtime-audit-service.js";
import { AndroidSpiderBridge } from "../spider/android-spider-bridge.js";
import { normalizeRuntimeError } from "../spider/runtime-errors.js";
import {
  renderAndroidBridgeFeasibility,
  renderAndroidSpiderPoc,
  renderEnoentAudit,
  renderRuntimeDiagnosticsV3,
  type AndroidEnvironmentAudit,
  type AndroidSpiderPocAttempt,
  type AndroidSpiderPocReport,
} from "../spider/android-spider-reports.js";
import { defaultConfigUrl } from "./config-probe.js";

export async function runAndroidSpiderPoc(
  configUrl = process.env.QX_ANDROID_POC_CONFIG_URL ?? defaultConfigUrl,
  outputRoot = process.env.QX_ANDROID_POC_OUTPUT ?? process.cwd(),
): Promise<AndroidSpiderPocReport> {
  const response = await fetch(configUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Configuration request failed: HTTP ${response.status}`);
  const config = parseTvBoxConfig(await response.text());
  const site = selectSite(config.sites ?? []);
  if (!site) throw new Error("No searchable csp_* site was found in the configuration");
  const normalized = normalizeFongMiSite(site, configUrl);
  const cacheRoot = process.env.QX_ANDROID_POC_CACHE ?? join(tmpdir(), "qx-android-spider-poc-cache");
  await mkdir(cacheRoot, { recursive: true });
  const cache = new SpiderArtifactCache(cacheRoot);
  const declaration = typeof config.spider === "string"
    ? config.spider
    : site.jar ?? (typeof site.spider === "string" ? site.spider : undefined);
  if (!declaration) throw new Error("Configuration does not declare a Spider artifact");
  const resolved = await new SpiderArtifactResolver().resolveSpiderArtifact(configUrl, declaration, cache);
  const artifact = await new JarInspector().inspectFile(resolved.localPath, resolved.artifactUrl);
  const environment = inspectEnvironment();
  const blockers = missingPrerequisites(environment);
  const attempts: AndroidSpiderPocAttempt[] = [
    { operation: "health", status: "not_run" },
    { operation: "loadJar", status: "not_run" },
    { operation: "createSpider", status: "not_run" },
    { operation: "init", status: "not_run" },
    { operation: "searchContent", status: "not_run" },
    { operation: "detailContent", status: "not_run" },
    { operation: "playerContent", status: "not_run" },
  ];
  let normalizedError;
  if (blockers.length === 0 && environment.hostExecutable) {
    const bridge = new AndroidSpiderBridge({
      hostExecutable: environment.hostExecutable,
      siteKey: normalized.key,
      sourceName: normalized.name,
      artifactUrl: resolved.artifactUrl,
      artifactPath: resolved.localPath,
      isPackaged: false,
    });
    try {
      await bridge.start();
      await runBridgeAttempt(attempts, "health", () => bridge.health());
      await runBridgeAttempt(attempts, "loadJar", () => bridge.loadJar(resolved.localPath, resolved.artifactUrl));
      await runBridgeAttempt(attempts, "createSpider", () => bridge.createSpider(site.api ?? "", normalized.key, expectedClass(site.api)));
      await runBridgeAttempt(attempts, "init", () => bridge.init(typeof site.ext === "string" ? site.ext : ""));
      const searchResponse = await runBridgeAttempt(attempts, "searchContent", () => bridge.searchContent("测试", false, 1));
      const searchItems = responseList(searchResponse);
      if (searchItems.length === 0) {
        failAttempt(attempts, "searchContent", "searchContent returned no results");
        throw new Error("Android Spider searchContent returned no results");
      }
      const firstId = responseId(searchItems[0]);
      if (!firstId) {
        failAttempt(attempts, "searchContent", "searchContent returned an item without vod_id");
        throw new Error("Android Spider searchContent returned an item without vod_id");
      }
      const detailResponse = await runBridgeAttempt(attempts, "detailContent", () => bridge.detailContent([firstId]));
      if (responseList(detailResponse).length === 0) {
        failAttempt(attempts, "detailContent", "detailContent returned no details");
        throw new Error("Android Spider detailContent returned no details");
      }
      if (hasPlaybackLines(detailResponse)) {
        await runBridgeAttempt(attempts, "playerContent", () => bridge.playerContent("", firstId));
      } else {
        const playerAttempt = attempts.find((attempt) => attempt.operation === "playerContent");
        if (playerAttempt) playerAttempt.details = "not attempted: detailContent returned no playback lines";
      }
    } catch (error) {
      const errorDetails = error instanceof Error && "details" in error
        ? (error as { details?: typeof normalizedError }).details
        : undefined;
      normalizedError = errorDetails ?? normalizeRuntimeError(error, {
        runtimeKind: "android-dex",
        siteKey: normalized.key,
        sourceName: normalized.name,
        artifactUrl: resolved.artifactUrl,
        artifactPath: resolved.localPath,
      });
      blockers.push(normalizedError?.code ?? "android_bridge_failed");
    } finally {
      await bridge.destroy();
    }
  } else {
    const hostPath = environment.hostExecutable ?? join(process.cwd(), "android-spider-host.exe");
    const raw = Object.assign(new Error(`Android Spider Host is missing: ${hostPath}`), {
      code: "ENOENT",
      syscall: "spawn",
      path: hostPath,
    });
    normalizedError = normalizeRuntimeError(raw, {
      runtimeKind: "android-dex",
      siteKey: normalized.key,
      sourceKey: normalized.key,
      sourceName: normalized.name,
      artifactUrl: resolved.artifactUrl,
      artifactPath: resolved.localPath,
      workingDirectory: process.cwd(),
      isPackaged: false,
      rootCause: "runtime_host_missing",
    });
  }

  const status = attempts.some((attempt) => attempt.status === "failed")
    ? "FAILED"
    : blockers.length > 0
      ? "BLOCKED"
      : "PASS";
  const report: AndroidSpiderPocReport = {
    generatedAt: new Date().toISOString(),
    configUrl,
    siteKey: normalized.key,
    siteName: normalized.name,
    api: normalized.api,
    artifactUrl: resolved.artifactUrl,
    artifactPath: resolved.localPath,
    artifact,
    environment,
    status,
    attempts,
    blockers,
    ...(normalizedError ? { normalizedError } : {}),
  };
  const audit = await new RuntimeAuditService({ artifactCache: cache, sourceUrl: configUrl }).audit(config, configUrl);
  await writeFile(join(outputRoot, "ANDROID-BRIDGE-FEASIBILITY.md"), renderAndroidBridgeFeasibility(report), "utf8");
  await writeFile(join(outputRoot, "ANDROID-SPIDER-POC-REPORT.md"), renderAndroidSpiderPoc(report), "utf8");
  await writeFile(join(outputRoot, "ENOENT-AUDIT.md"), renderEnoentAudit(report, audit), "utf8");
  await writeFile(join(outputRoot, "RUNTIME-DIAGNOSTICS-V3.md"), renderRuntimeDiagnosticsV3(report, audit), "utf8");
  console.log(JSON.stringify({ status, site: normalized.key, blockers, summary: audit.summary }, null, 2));
  return report;
}

async function runBridgeAttempt(
  attempts: AndroidSpiderPocAttempt[],
  operation: string,
  action: () => Promise<unknown>,
): Promise<unknown> {
  const attempt = attempts.find((value) => value.operation === operation);
  if (!attempt) return undefined;
  try {
    const response = await action();
    if (isRecord(response) && response.ok === false) {
      attempt.status = "failed";
      const message = isRecord(response.error) && typeof response.error.message === "string" ? response.error.message : "remote_error";
      const code = isRecord(response.error) && typeof response.error.code === "string" ? response.error.code : "ANDROID_BRIDGE_REMOTE_ERROR";
      const diagnostics = isRecord(response.error) && isRecord(response.error.diagnostics) ? response.error.diagnostics : undefined;
      attempt.details = `${code}: ${message}`;
      throw Object.assign(new Error(`${code}: ${message}${diagnosticText(diagnostics)}`), { code, diagnostics });
    }
    attempt.status = "passed";
    return response;
  } catch (error) {
    attempt.status = "failed";
    attempt.details = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function failAttempt(attempts: AndroidSpiderPocAttempt[], operation: string, details: string): void {
  const attempt = attempts.find((attempt) => attempt.operation === operation);
  if (attempt) {
    attempt.status = "failed";
    attempt.details = details;
  }
}

function responseList(response: unknown): readonly Record<string, unknown>[] {
  const value = responseValue(response);
  if (!isRecord(value) || !Array.isArray(value.list)) return [];
  return value.list.filter(isRecord);
}

function responseId(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const value = item.vod_id ?? item.vodId ?? item.id;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function hasPlaybackLines(response: unknown): boolean {
  const first = responseList(response)[0];
  if (!first) return false;
  return (typeof first.vod_play_url === "string" && first.vod_play_url.trim().length > 0)
    || (typeof first.vod_play_from === "string" && first.vod_play_from.trim().length > 0);
}

function responseValue(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  const value = response.result;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function diagnosticText(diagnostics: Record<string, unknown> | undefined): string {
  if (!diagnostics) return "";
  const values = Object.entries(diagnostics)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`);
  return values.length > 0 ? ` (${values.join(", ")})` : "";
}

function inspectEnvironment(): AndroidEnvironmentAudit {
  const adb = spawnSync("adb", ["version"], { encoding: "utf8", windowsHide: true });
  const devices = spawnSync("adb", ["devices"], { encoding: "utf8", windowsHide: true });
  const adbPath = process.env.ADB ?? (adb.status === 0 ? "adb" : undefined);
  const sdkCandidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "AppData", "Local", "Android", "Sdk"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const androidSdkPath = sdkCandidates.find((value) => existsSync(value));
  const hostExecutable = process.env.QX_ANDROID_SPIDER_HOST?.trim() || undefined;
  const deviceOutput = typeof devices.stdout === "string" ? devices.stdout : "";
  const adbVersion = typeof adb.stdout === "string" && adb.stdout.trim()
    ? adb.stdout.trim().split("\n")[0]?.trim()
    : undefined;
  return {
    ...(adbPath ? { adbPath } : {}),
    ...(adbVersion ? { adbVersion } : {}),
    adbDevices: deviceOutput.trim(),
    connectedDevice: /^.+\tdevice$/mu.test(deviceOutput),
    ...(androidSdkPath ? { androidSdkPath } : {}),
    androidSdkAvailable: androidSdkPath !== undefined,
    javaCompilerAvailable: spawnSync("javac", ["-version"], { stdio: "ignore", windowsHide: true }).status === 0,
    ...(hostExecutable ? { hostExecutable } : {}),
    hostAvailable: hostExecutable !== undefined && existsSync(hostExecutable),
  };
}

function missingPrerequisites(environment: AndroidEnvironmentAudit): string[] {
  return [
    !environment.androidSdkAvailable ? "android_sdk_missing" : "",
    !environment.connectedDevice ? "android_device_missing" : "",
    !environment.hostAvailable ? "runtime_host_missing" : "",
  ].filter(Boolean);
}

function selectSite(sites: readonly TvBoxSite[]): TvBoxSite | undefined {
  const candidates = sites.filter((site) => {
    const normalized = normalizeFongMiSite(site);
    return normalized.searchable && /^csp_/i.test(normalized.api);
  });
  return candidates.find((site) => {
    const key = normalizeFongMiSite(site).key.toLowerCase();
    return key !== "config" && key !== "push_agent";
  }) ?? candidates[0];
}

function expectedClass(api: string | undefined): string {
  const name = api?.replace(/^csp_/i, "").trim();
  return name ? `com.github.catvod.spider.${name}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("android-spider-poc.ts")) {
  runAndroidSpiderPoc().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
