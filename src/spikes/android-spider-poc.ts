import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { parseTvBoxConfig, type TvBoxSite } from "../config/decoder.js";
import { normalizeFongMiSite } from "../config/fongmi.js";
import { JarInspector } from "../spider/jar-inspector.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { SpiderArtifactResolver } from "../spider/spider-artifact-resolver.js";
import { RuntimeAuditService } from "../spider/runtime-audit-service.js";
import { AndroidDeviceManager } from "../spider/android-device-manager.js";
import { AndroidSpiderBridgeClient } from "../spider/android-spider-bridge-client.js";
import {
  androidPlaybackLineStats,
  extractAndroidVodItems,
  firstAndroidPlaybackRequest,
  firstAndroidVodId,
  hasAndroidPlaybackFields,
  parseAndroidSpiderResult,
  validateAndroidDetail,
} from "../spider/android-spider-parsers.js";
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
import {
  renderAndroidHostSetup,
  renderAndroidSpiderRealRun,
  renderAndroidSpiderHostReport,
  renderAndroidSpiderPocV2,
  renderRuntimeDiagnosticsV4,
  type AndroidHostDiagnosticsReport,
  type AndroidHostOperationDiagnostics,
} from "../spider/android-host-reports.js";
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

  const hostApkPath = process.env.QX_ANDROID_HOST_APK?.trim()
    || join(process.cwd(), "android-spider-host", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const manager = new AndroidDeviceManager({
    ...(process.env.QX_ANDROID_SDK_PATH ? { sdkPath: process.env.QX_ANDROID_SDK_PATH } : {}),
    ...(process.env.ADB ? { adbPath: process.env.ADB } : {}),
    ...(process.env.QX_ANDROID_DEVICE_SERIAL ? { serial: process.env.QX_ANDROID_DEVICE_SERIAL } : {}),
  });
  const snapshot = await manager.check();
  const hostApkFound = existsSync(hostApkPath);
  let hostInstalled = false;
  let hostOnline = false;
  let selectedDevice = snapshot.device;
  let bootReady = snapshot.deviceFound;
  let rpcHealth: Record<string, unknown> | undefined;
  const blockers = [...snapshot.diagnostics.filter((value) => value !== "ANDROID_DEVICE_NOT_FOUND")];
  if (!snapshot.deviceFound) blockers.push("ANDROID_DEVICE_NOT_FOUND");
  if (!hostApkFound) blockers.push("HOST_APK_NOT_FOUND");
  if (requiresArm64(artifact.nativeLibraries)) blockers.push("requires_arm64");
  const keyword = readKeyword();
  if (!keyword) blockers.push("ANDROID_POC_KEYWORD_REQUIRED");
  if (snapshot.deviceFound) {
    try {
      selectedDevice = await manager.waitForBoot();
    } catch (error) {
      bootReady = false;
      const code = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "ANDROID_DEVICE_BOOT_TIMEOUT";
      blockers.push(code);
    }
  }

  const attempts: AndroidSpiderPocAttempt[] = [
    { operation: "health", status: "not_run" },
    { operation: "loadJar", status: "not_run" },
    { operation: "createSpider", status: "not_run" },
    { operation: "init", status: "not_run" },
    { operation: "searchContent", status: "not_run" },
    { operation: "detailContent", status: "not_run" },
    { operation: "playerContent", status: "not_run" },
  ];
  const operations: Record<string, AndroidHostOperationDiagnostics> = {
    health: { status: "NOT_RUN" },
    loadJar: { status: "NOT_RUN" },
    createSpider: { status: "NOT_RUN" },
    searchContent: { status: "NOT_RUN", ...(keyword ? { keyword } : {}) },
    detailContent: { status: "NOT_RUN" },
    playerContent: { status: "NOT_RUN" },
  };
  let classResolution: AndroidHostDiagnosticsReport["classResolution"];
  let initDiagnostics: AndroidHostOperationDiagnostics | undefined;
  let artifactDiagnostics: AndroidHostDiagnosticsReport["artifact"] = {
    url: resolved.artifactUrl,
    path: resolved.localPath,
    size: artifact.size,
    sha256: artifact.sha256,
    dexCount: artifact.dexCount,
  };
  let normalizedError;
  let client: AndroidSpiderBridgeClient | undefined;

  if (bootReady && hostApkFound) {
    try {
      hostInstalled = await manager.isHostInstalled();
      if (!hostInstalled) {
        await manager.install(hostApkPath);
        hostInstalled = await manager.isHostInstalled();
      }
      if (!hostInstalled) throw new Error("ANDROID_HOST_NOT_INSTALLED: Host package verification failed after install");
      await manager.startHost();
      client = new AndroidSpiderBridgeClient({
        deviceManager: manager,
        siteKey: normalized.key,
        sourceName: normalized.name,
        artifactUrl: resolved.artifactUrl,
      });
      rpcHealth = await client.connect();
      hostOnline = true;
      operations.health = { status: "PASS", details: "health response received" };
      markAttempt(attempts, "health", "passed");

      const loadStarted = Date.now();
      try {
        const loaded = await runOperation(attempts, "loadJar", () => client!.loadJar(resolved.localPath, resolved.artifactUrl));
        const loadedRecord = record(loaded);
        operations.loadJar = {
          status: "PASS",
          ...(typeof loadedRecord.loadDurationMs === "number" ? { durationMs: loadedRecord.loadDurationMs } : { durationMs: Date.now() - loadStarted }),
          details: "DexClassLoader accepted artifact",
        };
        artifactDiagnostics = {
          ...artifactDiagnostics,
          ...(typeof loadedRecord.sha256 === "string" ? { androidSha256: loadedRecord.sha256 } : {}),
          ...(typeof loadedRecord.jarId === "string" ? { jarId: loadedRecord.jarId } : {}),
          ...(typeof loadedRecord.dexCount === "number" ? { dexCount: loadedRecord.dexCount } : { dexCount: artifact.dexCount }),
          ...(Array.isArray(loadedRecord.candidateSpiderClasses) ? { candidateSpiderClasses: loadedRecord.candidateSpiderClasses.filter((value): value is string => typeof value === "string") } : {}),
        };
      } catch (error) {
        operations.loadJar = {
          status: "FAIL",
          durationMs: Date.now() - loadStarted,
          details: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }

      const expectedClass = expectedAndroidSpiderClass(normalized.api);
      try {
        const created = await runOperation(attempts, "createSpider", () => client!.createSpider(normalized.api, expectedClass, normalized.key));
        const createdRecord = record(created);
        classResolution = {
          api: normalized.api,
          siteKey: normalized.key,
          expectedClass,
          ...(typeof createdRecord.resolvedClass === "string" ? { resolvedClass: createdRecord.resolvedClass } : {}),
          classExists: createdRecord.classExists === true,
          candidateSpiderClasses: artifactDiagnostics.candidateSpiderClasses ?? [],
          status: "PASS",
        };
        operations.createSpider = { status: "PASS", details: expectedClass };
      } catch (error) {
        classResolution = classDiagnosticsFromError(normalized.api, normalized.key, expectedClass, artifactDiagnostics.candidateSpiderClasses ?? [], error);
        throw error;
      }

      const initStarted = Date.now();
      try {
        const initResult = await runOperation(attempts, "init", () => client!.init(Object.prototype.hasOwnProperty.call(site, "ext") ? site.ext : ""));
        const initRecord = record(initResult);
        initDiagnostics = {
          status: "PASS",
          durationMs: Date.now() - initStarted,
          ...(typeof initRecord.contextDependent === "boolean" ? { contextDependent: initRecord.contextDependent } : {}),
          ...(typeof initRecord.runtimeContextInitialized === "boolean" ? { runtimeContextInitialized: initRecord.runtimeContextInitialized } : {}),
          details: "real Android Application Context supplied",
        };
      } catch (error) {
        const diagnostics = bridgeDiagnostics(error);
        initDiagnostics = {
          status: "FAIL",
          durationMs: typeof diagnostics?.initDurationMs === "number" ? diagnostics.initDurationMs : Date.now() - initStarted,
          ...(typeof diagnostics?.initException === "string" ? { initException: diagnostics.initException } : {}),
          ...(typeof diagnostics?.contextDependent === "boolean" ? { contextDependent: diagnostics.contextDependent } : {}),
          details: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }

      if (!keyword) {
        operations.searchContent = { status: "BLOCKED", details: "a user keyword is required before searchContent" };
        markAttempt(attempts, "searchContent", "blocked", operations.searchContent.details);
      } else {
        const searchStarted = Date.now();
        const searchResult = await client.searchContent(keyword, false, 1);
        const searchItems = extractAndroidVodItems(searchResult);
        const searchVodId = firstString(searchItems[0]?.vod_id, searchItems[0]?.id);
        const searchDetails = searchItems.length > 0 ? "SEARCH_PASS" : "search list was empty";
        operations.searchContent = {
          status: searchItems.length > 0 ? "PASS" : "FAIL",
          durationMs: Date.now() - searchStarted,
          keyword,
          rawResponseLength: rawResponseLength(searchResult),
          resultCount: searchItems.length,
          ...(searchVodId === undefined ? {} : { vodId: searchVodId }),
          details: searchDetails,
        };
        markAttempt(attempts, "searchContent", searchItems.length > 0 ? "passed" : "failed", searchDetails);
        if (searchItems.length === 0) throw new Error("SEARCH_FAIL: searchContent returned no results");

        const firstId = firstAndroidVodId(searchResult);
        if (!firstId) throw new Error("SEARCH_FAIL: result did not contain vod_id");
        const detailStarted = Date.now();
        const detailResult = await client.detailContent([firstId]);
        const detailItems = extractAndroidVodItems(detailResult);
        const detailItem = detailItems[0];
        const detailValidation = validateAndroidDetail(detailResult);
        const playbackStats = androidPlaybackLineStats(detailResult);
        const detailPlayable = playbackStats.hasPlayFrom && playbackStats.hasPlayUrl;
        const detailVodId = firstString(detailItem?.vod_id, detailItem?.id);
        const detailDetails = detailValidation.valid
          ? detailPlayable ? "DETAIL_PLAYABLE_PASS" : "detail fields present; no playback lines"
          : `missing ${detailValidation.missing.join(", ")}`;
        operations.detailContent = {
          status: detailValidation.valid ? "PASS" : "FAIL",
          durationMs: Date.now() - detailStarted,
          ...(detailVodId === undefined ? {} : { vodId: detailVodId }),
          ...(typeof detailItem?.vod_play_from === "string" ? { vodPlayFrom: detailItem.vod_play_from } : {}),
          ...(typeof detailItem?.vod_play_url === "string" ? { vodPlayUrl: detailItem.vod_play_url } : {}),
          vodYearPresent: detailValidation.missing.includes("vod_year") === false,
          ...playbackStats,
          details: detailDetails,
        };
        markAttempt(attempts, "detailContent", detailValidation.valid ? "passed" : "failed", detailDetails);
        if (!detailValidation.valid || detailItems.length === 0) throw new Error(`DETAIL_FAIL: ${detailValidation.missing.join(", ")}`);

        const playback = firstAndroidPlaybackRequest(detailResult);
        if (!hasAndroidPlaybackFields(detailResult) || !playback) {
          operations.playerContent = { status: "BLOCKED", details: "detailContent had no playable lines" };
          markAttempt(attempts, "playerContent", "blocked", operations.playerContent.details);
        } else {
          const playerStarted = Date.now();
          try {
            const playerResult = await runOperation(attempts, "playerContent", () => client!.playerContent(playback.flag, playback.id));
            const playerPayload = parseAndroidSpiderResult(playerResult);
            const playerUrl = firstString(playerPayload.url, playerPayload.link, playerPayload.playUrl);
            const playerMessage = firstString(playerPayload.msg, playerPayload.errMsg);
            const headerPresent = playerPayload.header !== undefined || playerPayload.headers !== undefined;
            operations.playerContent = {
              status: playerUrl ? "PASS" : "FAIL",
              durationMs: Date.now() - playerStarted,
              url: playerUrl ?? (typeof playerPayload.url === "string" ? playerPayload.url : ""),
              urlPresent: Boolean(playerUrl),
              parse: typeof playerPayload.parse === "boolean" || typeof playerPayload.parse === "number" || typeof playerPayload.parse === "string" ? String(playerPayload.parse) : "unknown",
              jx: playerPayload.jx === undefined ? "unknown" : String(playerPayload.jx),
              headerPresent,
              format: typeof playerPayload.format === "string" ? playerPayload.format : "unknown",
              ...(playerMessage ? { message: playerMessage } : {}),
              details: playerUrl ? "PLAYER_CONTENT_PASS" : playerMessage ? `PLAYER_CONTENT_FAIL: ${playerMessage}` : "player response did not contain url",
            };
            if (!playerUrl) {
              markAttempt(attempts, "playerContent", "failed", operations.playerContent.details);
              const failure = new Error(`PLAYER_FAIL: ${playerMessage ?? "playerContent returned no playable URL"}`);
              if (playerMessage && /(登录|token|access_token|配置)/iu.test(playerMessage)) Object.assign(failure, { code: "SPIDER_SOURCE_AUTH_REQUIRED" });
              throw failure;
            }
          } catch (error) {
            const existingPlayer = operations.playerContent;
            operations.playerContent = existingPlayer?.status === "FAIL"
              ? { ...existingPlayer, durationMs: Date.now() - playerStarted }
              : {
                status: "FAIL",
                durationMs: Date.now() - playerStarted,
                url: "",
                urlPresent: false,
                parse: "unknown",
                jx: "unknown",
                format: "unknown",
                details: error instanceof Error ? error.message : String(error),
              };
            throw error;
          }
        }
      }
    } catch (error) {
      const details = bridgeDiagnostics(error);
      normalizedError = normalizeRuntimeError(error, {
        runtimeKind: "android-dex",
        siteKey: normalized.key,
        sourceKey: normalized.key,
        sourceName: normalized.name,
        artifactUrl: resolved.artifactUrl,
        artifactPath: resolved.localPath,
        workingDirectory: process.cwd(),
        isPackaged: false,
        ...(details ? { rootCause: String(details.code ?? (error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined) ?? "android_host_failed") } : {}),
      });
      if (normalizedError.code) blockers.push(normalizedError.code);
    } finally {
      if (client) await client.destroyAll();
    }
  } else {
    const code = blockers[0] ?? "ANDROID_HOST_NOT_READY";
    const raw = Object.assign(new Error(`Android Spider Host prerequisites are unavailable: ${code}`), { code });
    normalizedError = normalizeRuntimeError(raw, {
      runtimeKind: "android-dex",
      siteKey: normalized.key,
      sourceKey: normalized.key,
      sourceName: normalized.name,
      artifactUrl: resolved.artifactUrl,
      artifactPath: resolved.localPath,
      workingDirectory: process.cwd(),
      isPackaged: false,
      rootCause: code,
    });
  }

  const environment: AndroidEnvironmentAudit = {
    ...(snapshot.adbPath ? { adbPath: snapshot.adbPath } : {}),
    ...(snapshot.adbVersion ? { adbVersion: snapshot.adbVersion } : {}),
    ...(snapshot.emulatorPath ? { emulatorPath: snapshot.emulatorPath } : {}),
    avds: snapshot.avds,
    adbDevices: snapshot.devices.map((device) => `${device.serial}\t${device.state}`).join("\n"),
    connectedDevice: snapshot.deviceFound,
    ...(snapshot.device?.serial ? { deviceSerial: snapshot.device.serial } : {}),
    ...(selectedDevice?.model ? { deviceModel: selectedDevice.model } : {}),
    ...(selectedDevice?.androidVersion ? { androidVersion: selectedDevice.androidVersion } : {}),
    ...(selectedDevice?.sdkInt !== undefined ? { sdkInt: selectedDevice.sdkInt } : {}),
    ...(selectedDevice?.abi ? { abi: selectedDevice.abi } : {}),
    ...(selectedDevice?.bootCompleted !== undefined ? { bootCompleted: selectedDevice.bootCompleted } : {}),
    ...(snapshot.sdkPath ? { androidSdkPath: snapshot.sdkPath } : {}),
    androidSdkAvailable: snapshot.sdkFound,
    javaCompilerAvailable: spawnSync("javac", ["-version"], { stdio: "ignore", windowsHide: true }).status === 0,
    ...(hostApkFound ? { hostApkPath } : {}),
    hostApkAvailable: hostApkFound,
    hostInstalled,
    hostOnline,
    androidHostAvailable: client?.androidHostAvailable ?? hostOnline,
    hostAvailable: hostOnline,
  };
  const coreOperations = new Set(["health", "loadJar", "createSpider", "init", "searchContent"]);
  const coreFailed = attempts.some((attempt) => coreOperations.has(attempt.operation) && attempt.status === "failed");
  const blockingBlockers = blockers.filter((blocker) => blocker !== "SPIDER_SOURCE_AUTH_REQUIRED");
  const status: AndroidSpiderPocReport["status"] = coreFailed
    ? "FAILED"
    : blockingBlockers.length > 0
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
    blockers: [...new Set(blockers)],
    ...(normalizedError ? { normalizedError } : {}),
  };
  const audit = await new RuntimeAuditService({ artifactCache: cache, sourceUrl: configUrl }).audit(config, configUrl);
  const hostReport: AndroidHostDiagnosticsReport = {
    generatedAt: report.generatedAt,
    configUrl,
    siteKey: normalized.key,
    siteName: normalized.name,
    api: normalized.api,
    ...(keyword ? { keyword } : {}),
    status: status === "FAILED" ? "FAIL" : status,
    environment: {
      sdkFound: snapshot.sdkFound,
      ...(snapshot.sdkPath ? { sdkPath: snapshot.sdkPath } : {}),
      adbFound: snapshot.adbFound,
      ...(snapshot.adbPath ? { adbPath: snapshot.adbPath } : {}),
      deviceFound: snapshot.deviceFound,
      ...(snapshot.device?.serial ? { deviceSerial: snapshot.device.serial } : {}),
      ...(snapshot.emulatorPath ? { emulatorPath: snapshot.emulatorPath } : {}),
      avds: snapshot.avds,
      ...(selectedDevice?.model ? { deviceModel: selectedDevice.model } : {}),
      ...(selectedDevice?.androidVersion ? { androidVersion: selectedDevice.androidVersion } : {}),
      ...(selectedDevice?.sdkInt !== undefined ? { sdkInt: selectedDevice.sdkInt } : {}),
      ...(selectedDevice?.abi ? { abi: selectedDevice.abi } : {}),
      ...(selectedDevice?.bootCompleted !== undefined ? { bootCompleted: selectedDevice.bootCompleted } : {}),
      hostApkFound,
      ...(hostApkFound ? { hostApkPath } : {}),
      hostInstalled,
      hostOnline,
      androidHostAvailable: client?.androidHostAvailable ?? hostOnline,
      ...(rpcHealth ? { rpcHealth } : {}),
    },
    artifact: artifactDiagnostics,
    ...(classResolution ? { classResolution } : {}),
    ...(initDiagnostics ? { init: initDiagnostics } : {}),
    operations,
    blockers: [...new Set(blockers)],
    notes: [
      "Host availability is based on ADB device reachability, package installation, and RPC health; no android-spider-host.exe check is used.",
      "Cleartext HTTP is enabled for this PoC Host because the selected real source declares HTTP site URLs.",
    ],
  };
  await writeFile(join(outputRoot, "ANDROID-BRIDGE-FEASIBILITY.md"), renderAndroidBridgeFeasibility(report), "utf8");
  await writeFile(join(outputRoot, "ANDROID-SPIDER-POC-REPORT.md"), renderAndroidSpiderPoc(report), "utf8");
  await writeFile(join(outputRoot, "ENOENT-AUDIT.md"), renderEnoentAudit(report, audit), "utf8");
  await writeFile(join(outputRoot, "RUNTIME-DIAGNOSTICS-V3.md"), renderRuntimeDiagnosticsV3(report, audit), "utf8");
  await writeFile(join(outputRoot, "ANDROID-HOST-SETUP.md"), renderAndroidHostSetup(hostReport), "utf8");
  await writeFile(join(outputRoot, "ANDROID-SPIDER-POC-REPORT-V2.md"), renderAndroidSpiderPocV2(hostReport), "utf8");
  await writeFile(join(outputRoot, "ANDROID-SPIDER-HOST-REPORT.md"), renderAndroidSpiderHostReport(hostReport), "utf8");
  await writeFile(join(outputRoot, "ANDROID-SPIDER-REAL-RUN.md"), renderAndroidSpiderRealRun(hostReport), "utf8");
  await writeFile(join(outputRoot, "RUNTIME-DIAGNOSTICS-V4.md"), renderRuntimeDiagnosticsV4(hostReport), "utf8");
  console.log(JSON.stringify({ status: hostReport.status, site: normalized.key, blockers: hostReport.blockers, summary: audit.summary }, null, 2));
  return report;
}

async function runOperation(
  attempts: AndroidSpiderPocAttempt[],
  operation: string,
  action: () => Promise<unknown>,
): Promise<unknown> {
  const started = Date.now();
  try {
    const result = await action();
    markAttempt(attempts, operation, "passed", `${Date.now() - started}ms`);
    return result;
  } catch (error) {
    markAttempt(attempts, operation, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function markAttempt(attempts: AndroidSpiderPocAttempt[], operation: string, status: AndroidSpiderPocAttempt["status"], details?: string): void {
  const attempt = attempts.find((value) => value.operation === operation);
  if (!attempt) return;
  attempt.status = status;
  if (details) attempt.details = details;
}

function classDiagnosticsFromError(api: string, siteKey: string, expectedClass: string, candidates: readonly string[], error: unknown): NonNullable<AndroidHostDiagnosticsReport["classResolution"]> {
  const diagnostics = error instanceof Error && "diagnostics" in error
    ? (error as { diagnostics?: Record<string, unknown> }).diagnostics
    : undefined;
  return {
    api,
    siteKey,
    expectedClass,
    ...(typeof diagnostics?.resolvedClass === "string" ? { resolvedClass: diagnostics.resolvedClass } : {}),
    classExists: diagnostics?.classExists === true,
    candidateSpiderClasses: Array.isArray(diagnostics?.candidateSpiderClasses)
      ? diagnostics.candidateSpiderClasses.filter((value): value is string => typeof value === "string")
      : candidates,
    status: "FAIL",
    details: error instanceof Error ? error.message : String(error),
  };
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

function expectedAndroidSpiderClass(api: string | undefined): string {
  const name = api?.replace(/^csp_/i, "").trim();
  return name && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? `com.github.catvod.spider.${name}` : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rawResponseLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (record(value).raw && typeof record(value).raw === "string") return String(record(value).raw).length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function bridgeDiagnostics(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error)) return undefined;
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  return typeof diagnostics === "object" && diagnostics !== null && !Array.isArray(diagnostics)
    ? diagnostics as Record<string, unknown>
    : undefined;
}

function readKeyword(): string | undefined {
  const environment = process.env.QX_ANDROID_POC_KEYWORD?.trim();
  if (environment) return environment;
  const equalsArgument = process.argv.find((value) => value.startsWith("--keyword="));
  if (equalsArgument) return equalsArgument.slice("--keyword=".length).trim() || undefined;
  const index = process.argv.indexOf("--keyword");
  const next = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  return next || undefined;
}

function requiresArm64(nativeLibraries: readonly string[]): boolean {
  if (nativeLibraries.length === 0) return false;
  const hasX86 = nativeLibraries.some((value) => /(?:^|[\\/])(?:x86|x86_64)(?:[\\/]|$)/iu.test(value));
  const hasArm = nativeLibraries.some((value) => /(?:^|[\\/])(?:armeabi|armeabi-v7a|arm64-v8a)(?:[\\/]|$)/iu.test(value));
  return hasArm && !hasX86;
}

if (process.argv[1]?.endsWith("android-spider-poc.ts")) {
  runAndroidSpiderPoc().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
