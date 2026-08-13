import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseTvBoxConfig } from "../src/config/decoder.js";
import { AndroidDeviceManager } from "../src/spider/android-device-manager.js";
import { AndroidArtifactRegistry, AndroidSpiderBridgeClient } from "../src/spider/android-spider-bridge-client.js";
import { SourceCompatibilityAuditor, type SourceCompatibilityReport, type SourceProbeEngine, type SourceProbeMetadata } from "../src/spider/source-compatibility-v2.js";
import { SpiderArtifactCache } from "../src/spider/spider-artifact-cache.js";
import { SpiderRuntimeManager } from "../src/spider/spider-runtime.js";
import type { PlayerRequest, SearchRequest } from "../src/source/media-source.js";
import { defaultConfigUrl } from "../src/spikes/config-probe.js";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "QXMovie", "android-runtime");
const sdkPath = process.env.QX_ANDROID_SDK_PATH?.trim() || join(runtimeRoot, "sdk");
const adbPath = join(sdkPath, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const qxEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  QX_ANDROID_HOME: sdkPath,
  QX_ANDROID_AVD_HOME: join(runtimeRoot, "avd"),
  ANDROID_HOME: sdkPath,
  ANDROID_SDK_ROOT: sdkPath,
  ANDROID_AVD_HOME: join(runtimeRoot, "avd"),
  ANDROID_USER_HOME: join(runtimeRoot, "state", "android-user"),
  ANDROID_EMULATOR_HOME: join(runtimeRoot, "state", "android-user"),
  ANDROID_ADB_SERVER_PORT: "5038",
  ADB_SERVER_SOCKET: "tcp:5038",
  ADB: adbPath,
  Path: [
    join(sdkPath, "platform-tools"),
    join(sdkPath, "emulator"),
    join(sdkPath, "cmdline-tools", "latest", "bin"),
    process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32",
  ].join(";"),
};
qxEnvironment.PATH = qxEnvironment.Path;

const hostApkPath = process.env.QX_ANDROID_HOST_APK?.trim()
  || join(projectRoot, "android-spider-host", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

async function main(): Promise<void> {
  const sourceUrl = process.env.QX_G105_CONFIG_URL?.trim() || defaultConfigUrl;
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CONFIG_HTTP_${response.status}`);
  const config = parseTvBoxConfig(await response.text());
  const outputRoot = process.env.QX_G105_OUTPUT?.trim() || projectRoot;
  await mkdir(outputRoot, { recursive: true });

  const manager = await prepareAndroidManager();
  const cacheRoot = process.env.QX_G105_CACHE?.trim() || join(tmpdir(), "qx-g105-source-audit-cache");
  await mkdir(cacheRoot, { recursive: true });
  const artifactRegistry = new AndroidArtifactRegistry();
  const artifactCache = new SpiderArtifactCache(cacheRoot, { timeoutMs: 30_000 });
  let nextPort = 8766;
  const runtimeManager = new SpiderRuntimeManager({
    config,
    sourceUrl,
    artifactCache,
    androidRuntimePreparer: async () => undefined,
    androidBridgeClientFactory: async (site, support) => {
      if (!support.artifactPath) return undefined;
      return new AndroidSpiderBridgeClient({
        deviceManager: manager,
        localPort: nextPort++,
        requestTimeoutMs: 15_000,
        healthTimeoutMs: 5_000,
        operationTimeoutMs: 15_000,
        siteKey: site.key ?? site.api ?? "source",
        ...(site.name ? { sourceName: site.name } : {}),
        ...(support.artifactUrl ? { artifactUrl: support.artifactUrl } : {}),
        artifactRegistry,
      });
    },
  });

  try {
    const report = await new SourceCompatibilityAuditor({
      sourceUrl,
      keywords: (process.env.QX_G105_KEYWORDS
        ?? [process.env.QX_SOURCE_PROBE_MOVIE ?? "movie", process.env.QX_SOURCE_PROBE_TV ?? "tv", process.env.QX_SOURCE_PROBE_ANIME ?? "anime"].join(",")).split(","),
      initConcurrency: 2,
      searchConcurrency: 4,
      detailConcurrency: 3,
      playerConcurrency: 2,
      runtimeForSite: async (site): Promise<SourceProbeMetadata> => {
        const support = await runtimeManager.supports(site);
        return {
          runtime: support.runtime,
          ...(support.artifactUrl ? { artifact: support.artifactUrl } : {}),
          ...(support.artifact?.sha256 ? { artifactSha256: support.artifact.sha256 } : {}),
          ...(support.artifact?.size === undefined ? {} : { artifactSize: support.artifact.size }),
        };
      },
      createEngine: async (site): Promise<SourceProbeEngine> => {
        const runtime = await runtimeManager.getRuntime(site);
        return {
          init: (ext) => runtime.init(site, {
            sourceId: site.key ?? site.api ?? "source",
            ...(site.key ? { siteKey: site.key } : {}),
            ...(site.api ? { api: site.api } : {}),
            ...(ext === undefined ? {} : { ext }),
          }),
          home: () => runtime.home(false),
          category: (typeId = "") => runtime.category({ typeId, page: 1 }),
          search: (keyword, quick, page) => runtime.search({ key: keyword, quick, page } satisfies SearchRequest),
          detail: (ids) => runtime.detail([...ids]),
          player: (request: PlayerRequest) => runtime.player(request),
          metadata: async () => {
            const support = await runtimeManager.supports(site);
            const probe = await runtime.probeCompatibility?.();
            return {
              runtime: support.runtime,
              ...(support.artifactUrl ? { artifact: support.artifactUrl } : {}),
              ...(support.artifact?.sha256 ? { artifactSha256: support.artifact.sha256 } : {}),
              ...(support.artifact?.size === undefined ? {} : { artifactSize: support.artifact.size }),
              ...(probe ?? {}),
            } satisfies SourceProbeMetadata;
          },
        };
      },
    }).audit(config, sourceUrl);
    await writeReport(outputRoot, report);
    const gate = report.summary.total === 39
      && report.summary.searchable >= 33
      && report.sites.filter((site) => site.search.status === "PASS").length >= 3
      && report.sites.filter((site) => site.detail.status === "PASS").length >= 2
      && report.sites.some((site) => site.player.status === "PASS");
    console.log(JSON.stringify({ status: gate ? "PASS" : "FAIL", report: report.summary, outputRoot }, null, 2));
    if (!gate) process.exitCode = 2;
  } finally {
    await runtimeManager.destroy();
  }
}

async function prepareAndroidManager(): Promise<AndroidDeviceManager> {
  if (!existsSync(sdkPath) || !existsSync(adbPath)) throw new Error(`QX_RUNTIME_NOT_PROVISIONED: ${sdkPath}`);
  if (!existsSync(hostApkPath)) throw new Error(`HOST_APK_NOT_FOUND: ${hostApkPath}`);
  const manager = new AndroidDeviceManager({
    sdkPath,
    adbPath,
    env: qxEnvironment,
    ...(process.env.QX_ANDROID_DEVICE_SERIAL ? { serial: process.env.QX_ANDROID_DEVICE_SERIAL } : {}),
  });
  const environment = await manager.check();
  const serial = environment.device?.serial ?? "";
  if (!environment.deviceFound || !isQxManagedEmulator(serial)) {
    throw new Error(`EXTERNAL_ANDROID_DEVICE_FORBIDDEN: ${serial || "no emulator"}`);
  }
  await manager.waitForBoot();
  if (!await manager.isHostInstalled()) await manager.install(hostApkPath);
  await manager.startHost();
  return manager;
}

function isQxManagedEmulator(serial: string): boolean {
  return /^emulator-\d+$/u.test(serial) || /^(?:127\.0\.0\.1|localhost):5555$/iu.test(serial);
}

async function writeReport(outputRoot: string, report: SourceCompatibilityReport): Promise<void> {
  await writeFile(join(outputRoot, "G105-source-compatibility.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(outputRoot, "G105-SOURCE-COMPATIBILITY-REPORT.md"), renderMarkdown(report), "utf8");
}

function renderMarkdown(report: SourceCompatibilityReport): string {
  const lines = [
    "# G105 Source Compatibility V2",
    "",
    `Generated: ${report.generatedAt}`,
    report.sourceUrl ? `Config: ${redactUrl(report.sourceUrl)}` : "Config: unknown",
    `Keywords: ${report.keywords.join(", ")}`,
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Configured sources | ${report.summary.total} |`,
    `| Searchable | ${report.summary.searchable} |`,
    `| Search PASS | ${report.sites.filter((site) => site.search.status === "PASS").length} |`,
    `| Detail PASS | ${report.sites.filter((site) => site.detail.status === "PASS").length} |`,
    `| Player PASS | ${report.sites.filter((site) => site.player.status === "PASS").length} |`,
    `| P50/P90/P95 total ms | ${report.summary.p50Ms}/${report.summary.p90Ms}/${report.summary.p95Ms} |`,
    "",
    "| Site | Category | API | Runtime | Class | Init | Search | Detail | PlayerContent | Playback | Auth | Health | Status | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |",
    ...report.sites.map((site) => `| ${cell(site.siteName)} (${cell(site.siteKey)}) | ${site.sourceCategory} | ${cell(site.api)} | ${site.runtime} | ${cell(site.resolvedClass ?? "-")} | ${site.init.status} | ${site.search.status}/${site.search.resultCount ?? 0} | ${site.detail.status} | ${site.player.status} | ${site.playback} | ${site.authentication} | ${site.healthScore} | ${site.status} | ${cell(site.failureReason ?? "")} |`),
    "",
    "Artifact URLs and sensitive query material are redacted in this report. Raw cookies, tokens and media URLs are not written.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

function cell(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
