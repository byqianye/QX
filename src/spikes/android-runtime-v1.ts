import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseTvBoxConfig, type TvBoxSite } from "../config/decoder.js";
import { AndroidDeviceManager } from "../spider/android-device-manager.js";
import { AndroidArtifactRegistry, AndroidSpiderBridgeClient } from "../spider/android-spider-bridge-client.js";
import { expectedAndroidSpiderClass } from "../spider/android-dex-runtime.js";
import { JarInspector } from "../spider/jar-inspector.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { SpiderArtifactResolver } from "../spider/spider-artifact-resolver.js";
import {
  androidPlaybackLineStats,
  extractAndroidVodItems,
  firstAndroidPlaybackRequest,
  firstAndroidVodId,
  hasAndroidPlaybackFields,
  parseAndroidSpiderResult,
  validateAndroidDetail,
} from "../spider/android-spider-parsers.js";
import { defaultConfigUrl } from "./config-probe.js";

export interface AndroidRuntimeV1SiteResult {
  siteKey: string;
  siteName: string;
  api: string;
  expectedClass: string;
  resolvedClass?: string;
  classExists: boolean;
  resolutionMethod?: string;
  init: "PASS" | "FAIL";
  home: "PASS" | "FAIL" | "NOT_RUN";
  homeVideo: "PASS" | "FAIL" | "NOT_RUN";
  category: "PASS" | "FAIL" | "NOT_RUN";
  search: "PASS" | "EMPTY" | "FAIL";
  resultCount: number;
  vodId?: string;
  detail: "PASS" | "FAIL" | "NOT_RUN";
  hasPlayFrom: boolean;
  hasPlayUrl: boolean;
  playLineCount: number;
  player: "PASS" | "AUTH_REQUIRED" | "FAIL" | "NOT_RUN";
  urlPresent: boolean;
  parse?: string;
  jx?: string;
  headerPresent: boolean;
  format?: string;
  message?: string;
  error?: string;
}

export interface AndroidRuntimeV1Report {
  generatedAt: string;
  configUrl: string;
  keyword: string;
  device: Record<string, unknown>;
  artifact: Record<string, unknown>;
  host: Record<string, unknown>;
  configuredSites: number;
  searchableSites: number;
  selectedSites: number;
  results: readonly AndroidRuntimeV1SiteResult[];
  counts: {
    searchSuccess: number;
    detailSuccess: number;
    playerUsable: number;
    authRequired: number;
  };
  status: "PASS" | "PARTIAL" | "FAIL";
}

const ordinarySourcePattern = /(直播|音乐|教育|资讯|短剧|漫画|小说|游戏|电台|网络|特殊|配置|中心|网盘|动漫|课堂|MV)/iu;
const preferredSourcePattern = /(闪电|优汐|蜡笔|至臻|金牌|农民|荐片|火火|瓜子|厂长|360|哔哩|动漫)/u;

function isSearchable(value: TvBoxSite["searchable"]): boolean {
  return value !== 0 && value !== "0";
}

export async function runAndroidRuntimeV1(
  configUrl = process.env.QX_ANDROID_POC_CONFIG_URL ?? defaultConfigUrl,
  outputRoot = process.env.QX_ANDROID_POC_OUTPUT ?? process.cwd(),
): Promise<AndroidRuntimeV1Report> {
  const keyword = process.env.QX_ANDROID_POC_KEYWORD?.trim() || "庆余年";
  const configResponse = await fetch(configUrl, { signal: AbortSignal.timeout(30_000) });
  if (!configResponse.ok) throw new Error(`Configuration request failed: HTTP ${configResponse.status}`);
  const config = parseTvBoxConfig(await configResponse.text());
  const candidates = (config.sites ?? []).filter((site) => site.type === 3
    && typeof site.api === "string"
    && /^csp_/iu.test(site.api)
    && isSearchable(site.searchable)
    && !ordinarySourcePattern.test(`${site.name ?? ""} ${site.key ?? ""} ${site.api}`));
  const selected = selectSourceBatch(candidates, 8);
  if (selected.length < 8) throw new Error(`ANDROID_SOURCE_BATCH_TOO_SMALL: ${selected.length}`);
  const firstSelected = selected[0];
  if (!firstSelected) throw new Error("ANDROID_SOURCE_BATCH_EMPTY");

  const cacheRoot = process.env.QX_ANDROID_POC_CACHE ?? join(tmpdir(), "qx-android-spider-poc-cache");
  await mkdir(cacheRoot, { recursive: true });
  const cache = new SpiderArtifactCache(cacheRoot);
  const declaration = typeof config.spider === "string"
    ? config.spider
    : firstSelected.jar ?? (typeof firstSelected.spider === "string" ? firstSelected.spider : undefined);
  if (!declaration) throw new Error("ANDROID_ARTIFACT_NOT_DECLARED");
  const resolved = await new SpiderArtifactResolver().resolveSpiderArtifact(configUrl, declaration, cache);
  const artifact = await new JarInspector().inspectFile(resolved.localPath, resolved.artifactUrl);

  const manager = new AndroidDeviceManager({
    ...(process.env.QX_ANDROID_SDK_PATH ? { sdkPath: process.env.QX_ANDROID_SDK_PATH } : {}),
    ...(process.env.ADB ? { adbPath: process.env.ADB } : {}),
    ...(process.env.QX_ANDROID_DEVICE_SERIAL ? { serial: process.env.QX_ANDROID_DEVICE_SERIAL } : {}),
  });
  const snapshot = await manager.check();
  if (!snapshot.deviceFound) throw new Error("ANDROID_DEVICE_NOT_FOUND");
  const device = await manager.waitForBoot();
  const hostApkPath = process.env.QX_ANDROID_HOST_APK?.trim()
    || join(process.cwd(), "android-spider-host", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  if (!existsSync(hostApkPath)) throw new Error("HOST_APK_NOT_FOUND");
  if (!await manager.isHostInstalled()) await manager.install(hostApkPath);
  await manager.startHost();

  const registry = new AndroidArtifactRegistry();
  const clients: AndroidSpiderBridgeClient[] = [];
  const bootstrapClient = new AndroidSpiderBridgeClient({
    deviceManager: manager,
    siteKey: "__artifact_bootstrap__",
    artifactUrl: resolved.artifactUrl,
    artifactRegistry: registry,
    operationTimeoutMs: 15_000,
  });
  clients.push(bootstrapClient);
  await withTimeout(bootstrapClient.connect(), 5_000, "HOST_OFFLINE");
  await withTimeout(bootstrapClient.loadJar(resolved.localPath, resolved.artifactUrl), 15_000, "LOAD_JAR_TIMEOUT");
  const results = await probeSites(selected, clients, manager, registry, resolved.localPath, resolved.artifactUrl, keyword);
  const counts = {
    searchSuccess: results.filter((result) => result.search === "PASS").length,
    detailSuccess: results.filter((result) => result.detail === "PASS").length,
    playerUsable: results.filter((result) => result.player === "PASS" || (result.player === "FAIL" && result.parse === "1")).length,
    authRequired: results.filter((result) => result.player === "AUTH_REQUIRED").length,
  };
  const status: AndroidRuntimeV1Report["status"] = counts.searchSuccess >= 3 && counts.detailSuccess >= 3 && counts.playerUsable >= 1
    ? "PASS"
    : counts.searchSuccess > 0 || counts.detailSuccess > 0
      ? "PARTIAL"
      : "FAIL";
  await Promise.all(clients.map((client) => client.destroy()));
  const healthClient = new AndroidSpiderBridgeClient({
    deviceManager: manager,
    localPort: 8765,
    artifactUrl: resolved.artifactUrl,
    operationTimeoutMs: 5_000,
  });
  const hostHealth = await withTimeout(healthClient.health(), 5_000, "HOST_OFFLINE")
    .catch(() => ({ status: "offline" }));
  await healthClient.destroy();
  const report: AndroidRuntimeV1Report = {
    generatedAt: new Date().toISOString(),
    configUrl,
    keyword,
    device: {
      serial: device.serial,
      model: device.model,
      androidVersion: device.androidVersion,
      sdkInt: device.sdkInt,
      abi: device.abi,
    },
    artifact: {
      url: resolved.artifactUrl,
      path: resolved.localPath,
      sha256: artifact.sha256,
      size: artifact.size,
      dexCount: artifact.dexCount,
    },
    host: hostHealth,
    configuredSites: (config.sites ?? []).length,
    searchableSites: (config.sites ?? []).filter((site) => isSearchable(site.searchable)).length,
    selectedSites: selected.length,
    results,
    counts,
    status,
  };
  await writeReports(outputRoot, report);
  return report;
}

function selectSourceBatch(candidates: readonly TvBoxSite[], limit: number): TvBoxSite[] {
  const ordered = [...candidates].sort((left, right) => Number(preferredSourcePattern.test(`${right.name ?? ""} ${right.key ?? ""}`))
    - Number(preferredSourcePattern.test(`${left.name ?? ""} ${left.key ?? ""}`)));
  return ordered.slice(0, limit);
}

async function probeSites(
  sites: readonly TvBoxSite[],
  clients: AndroidSpiderBridgeClient[],
  manager: AndroidDeviceManager,
  registry: AndroidArtifactRegistry,
  artifactPath: string,
  artifactUrl: string,
  keyword: string,
): Promise<AndroidRuntimeV1SiteResult[]> {
  const queue = [...sites];
  const results: AndroidRuntimeV1SiteResult[] = [];
  const worker = async (workerIndex: number): Promise<void> => {
    while (queue.length > 0) {
      const site = queue.shift();
      if (!site || typeof site.api !== "string") return;
      const client = new AndroidSpiderBridgeClient({
        deviceManager: manager,
        localPort: 8766 + workerIndex,
        siteKey: site.key ?? site.api,
        ...(site.name ? { sourceName: site.name } : {}),
        artifactUrl,
        artifactRegistry: registry,
        operationTimeoutMs: 15_000,
      });
      clients.push(client);
      results.push(await probeSite(site, client, artifactPath, artifactUrl, keyword));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sites.length) }, (_, index) => worker(index)));
  return sites.map((site) => results.find((result) => result.siteKey === (site.key ?? site.api))!).filter(Boolean);
}

async function probeSite(
  site: TvBoxSite,
  client: AndroidSpiderBridgeClient,
  artifactPath: string,
  artifactUrl: string,
  keyword: string,
): Promise<AndroidRuntimeV1SiteResult> {
  const api = site.api ?? "";
  const expectedClass = expectedAndroidSpiderClass(api);
  const result: AndroidRuntimeV1SiteResult = {
    siteKey: site.key ?? api,
    siteName: site.name ?? site.key ?? api,
    api,
    expectedClass,
    classExists: false,
    init: "FAIL",
    home: "NOT_RUN",
    homeVideo: "NOT_RUN",
    category: "NOT_RUN",
    search: "FAIL",
    resultCount: 0,
    detail: "NOT_RUN",
    hasPlayFrom: false,
    hasPlayUrl: false,
    playLineCount: 0,
    player: "NOT_RUN",
    urlPresent: false,
    headerPresent: false,
  };
  try {
    await withTimeout(client.connect(), 5_000, "HOST_OFFLINE");
    const loaded = await withTimeout(client.loadJar(artifactPath, artifactUrl), 15_000, "LOAD_JAR_TIMEOUT");
    const classProbe = await withTimeout(client.resolveClass(api), 5_000, "CLASS_RESOLVE_TIMEOUT");
    result.classExists = classProbe.classExists === true;
    if (typeof classProbe.resolvedClass === "string") result.resolvedClass = classProbe.resolvedClass;
    if (typeof classProbe.resolutionMethod === "string") result.resolutionMethod = classProbe.resolutionMethod;
    if (!result.classExists) throw new Error("SPIDER_CLASS_NOT_FOUND");
    await withTimeout(client.createSpider(api, result.resolvedClass ?? expectedClass, result.siteKey), 5_000, "CREATE_TIMEOUT");
    await withTimeout(client.init(Object.prototype.hasOwnProperty.call(site, "ext") ? site.ext : ""), 15_000, "INIT_TIMEOUT");
    result.init = "PASS";
    result.home = await capabilityCall(() => client.homeContent(false));
    result.homeVideo = await capabilityCall(() => client.homeVideoContent());
    result.category = await capabilityCall(() => client.categoryContent("1", 1, false, {}));
    const searchRaw = await withTimeout(client.searchContent(keyword, false, 1), 15_000, "SEARCH_TIMEOUT");
    const items = extractAndroidVodItems(searchRaw);
    result.resultCount = items.length;
    const vodId = firstAndroidVodId(searchRaw);
    if (vodId !== undefined) result.vodId = vodId;
    result.search = items.length > 0 ? "PASS" : "EMPTY";
    if (!vodId) return result;
    const detailRaw = await withTimeout(client.detailContent([vodId]), 15_000, "DETAIL_TIMEOUT");
    const validation = validateAndroidDetail(detailRaw);
    const lines = androidPlaybackLineStats(detailRaw);
    result.detail = validation.valid ? "PASS" : "FAIL";
    result.hasPlayFrom = lines.hasPlayFrom;
    result.hasPlayUrl = lines.hasPlayUrl;
    result.playLineCount = lines.playLineCount;
    const playback = firstAndroidPlaybackRequest(detailRaw);
    if (!hasAndroidPlaybackFields(detailRaw) || !playback) return result;
    const player = parseAndroidSpiderResult(await withTimeout(client.playerContent(playback.flag, playback.id), 15_000, "PLAYER_TIMEOUT"));
    const url = firstString(player.url, player.link, player.playUrl);
    const message = firstString(player.msg, player.errMsg);
    result.player = url ? "PASS" : /(\u672a\u767b\u5f55|\u767b\u5f55|token|access[_-]?token|\u914d\u7f6e|\u6388\u6743)/iu.test(message ?? "") ? "AUTH_REQUIRED" : "FAIL";
    result.urlPresent = Boolean(url);
    const parse = primitiveString(player.parse);
    if (parse !== undefined) result.parse = parse;
    const jx = primitiveString(player.jx);
    if (jx !== undefined) result.jx = jx;
    result.headerPresent = player.header !== undefined || player.headers !== undefined;
    if (typeof player.format === "string") result.format = player.format;
    if (message !== undefined) result.message = message;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (result.detail === "PASS" && result.hasPlayFrom && result.hasPlayUrl && result.player === "NOT_RUN") {
      result.player = "FAIL";
    }
    if (result.init === "PASS" && result.search === "FAIL") result.search = "FAIL";
    return result;
  }
}

async function writeReports(outputRoot: string, report: AndroidRuntimeV1Report): Promise<void> {
  const table = report.results.map((result) => `| ${cell(result.siteName)} | ${cell(result.api)} | ${cell(result.resolvedClass ?? result.expectedClass)} | ${result.init} | ${result.home} | ${result.homeVideo} | ${result.category} | ${result.search} (${result.resultCount}) | ${result.detail} (${result.playLineCount}) | ${result.player} | ${result.message ? cell(result.message) : "-"} |`).join("\n");
  const compatibility = [
    "# Android Source Compatibility",
    "",
    `Generated: ${report.generatedAt}`,
    `Config: ${report.configUrl}`,
    `Device: ${report.device.model ?? "unknown"} / Android ${report.device.androidVersion ?? "unknown"}`,
    "",
    "| Source | API | Class | Init | Home | HomeVideo | Category | Search | Detail | Player | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    table,
    "",
  ].join("\n");
  const runtimeReport = [
    "# Android Runtime V1 Report",
    "",
    `Status: **${report.status}**`,
    `Generated: ${report.generatedAt}`,
    `Config sites: ${report.configuredSites}; searchable: ${report.searchableSites}; selected real Android DEX batch: ${report.selectedSites}`,
    `Host: ${JSON.stringify(report.host)}`,
    `Artifact SHA-256: ${report.artifact.sha256}`,
    "",
    `- Search success: ${report.counts.searchSuccess}`,
    `- Detail success: ${report.counts.detailSuccess}`,
    `- Player usable: ${report.counts.playerUsable}`,
    `- Auth required: ${report.counts.authRequired}`,
    "",
    "The gate is PASS only when search >= 3, detail >= 3, and at least one player result is usable (direct URL or parse=1).",
    "",
  ].join("\n");
  const diagnostics = [
    "# Runtime Diagnostics V5",
    "",
    `- Configured: ${report.configuredSites}`,
    `- Searchable: ${report.searchableSites}`,
    `- Android DEX batch tested: ${report.selectedSites}`,
    `- Host: ${report.host.status === "ok" ? "ONLINE" : report.host.status ?? "unknown"}`,
    `- Real search success/results: ${report.counts.searchSuccess}/${report.results.reduce((sum, result) => sum + result.resultCount, 0)}`,
    `- Real detail success/play lines: ${report.counts.detailSuccess}/${report.results.reduce((sum, result) => sum + result.playLineCount, 0)}`,
    `- Real player usable: ${report.counts.playerUsable}`,
    `- UC credential: MISSING for this probe; AUTH_REQUIRED is reported per source without exposing credential data.`,
    "",
  ].join("\n");
  const playback = [
    "# Playback Source Real Test",
    "",
    `Status: **${report.status}**`,
    `Keyword: ${report.keyword}`,
    "",
    "| Source | Search results | VOD ID | Play lines | Player | urlPresent | parse | jx | headerPresent | format |",
    "| --- | ---: | --- | ---: | --- | --- | --- | --- | --- | --- |",
    ...report.results.map((result) => `| ${cell(result.siteName)} | ${result.resultCount} | ${cell(result.vodId ?? "-")} | ${result.playLineCount} | ${result.player} | ${result.urlPresent} | ${result.parse ?? "-"} | ${result.jx ?? "-"} | ${result.headerPresent} | ${cell(result.format ?? "-")} |`),
    "",
    "Sensitive player URLs and tokens are intentionally not written.",
    "",
  ].join("\n");
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(join(outputRoot, "ANDROID-RUNTIME-V1-REPORT.md"), runtimeReport, "utf8"),
    writeFile(join(outputRoot, "ANDROID-SOURCE-COMPATIBILITY.md"), compatibility, "utf8"),
    writeFile(join(outputRoot, "RUNTIME-DIAGNOSTICS-V5.md"), diagnostics, "utf8"),
    writeFile(join(outputRoot, "PLAYBACK-SOURCE-REAL-TEST.md"), playback, "utf8"),
  ]);
}

function primitiveString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

async function capabilityCall(call: () => Promise<unknown>): Promise<"PASS" | "FAIL"> {
  try {
    await withTimeout(call(), 15_000, "CAPABILITY_TIMEOUT");
    return "PASS";
  } catch {
    return "FAIL";
  }
}

if (process.argv[1]?.endsWith("android-runtime-v1.ts")) {
  runAndroidRuntimeV1().then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
