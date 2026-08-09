export type AndroidDiagnosticStatus = "PASS" | "BLOCKED" | "FAIL" | "NOT_RUN";

export interface AndroidHostEnvironmentDiagnostics {
  sdkFound: boolean;
  sdkPath?: string;
  adbFound: boolean;
  adbPath?: string;
  emulatorPath?: string;
  avds?: readonly string[];
  deviceFound: boolean;
  deviceSerial?: string;
  deviceModel?: string;
  androidVersion?: string;
  sdkInt?: number;
  abi?: string;
  bootCompleted?: boolean;
  hostApkFound: boolean;
  hostApkPath?: string;
  hostInstalled: boolean;
  hostOnline: boolean;
  androidHostAvailable?: boolean;
  rpcHealth?: Record<string, unknown>;
}

export interface AndroidHostArtifactDiagnostics {
  url: string;
  path: string;
  size: number;
  sha256: string;
  androidSha256?: string;
  jarId?: string;
  dexCount?: number;
  candidateSpiderClasses?: readonly string[];
}

export interface AndroidHostClassDiagnostics {
  api: string;
  siteKey: string;
  expectedClass: string;
  resolvedClass?: string;
  classExists: boolean;
  candidateSpiderClasses: readonly string[];
  status: AndroidDiagnosticStatus;
  details?: string;
}

export interface AndroidHostOperationDiagnostics {
  status: AndroidDiagnosticStatus;
  durationMs?: number;
  initException?: string;
  contextDependent?: boolean;
  keyword?: string;
  rawResponseLength?: number;
  resultCount?: number;
  vodYearPresent?: boolean;
  hasPlayFrom?: boolean;
  hasPlayUrl?: boolean;
  playLineCount?: number;
  urlPresent?: boolean;
  parse?: string;
  jx?: boolean;
  headerPresent?: boolean;
  format?: string;
  details?: string;
}

export interface AndroidHostDiagnosticsReport {
  generatedAt: string;
  configUrl: string;
  siteKey: string;
  siteName: string;
  api: string;
  keyword?: string;
  status: Exclude<AndroidDiagnosticStatus, "NOT_RUN">;
  environment: AndroidHostEnvironmentDiagnostics;
  artifact?: AndroidHostArtifactDiagnostics;
  classResolution?: AndroidHostClassDiagnostics;
  init?: AndroidHostOperationDiagnostics;
  operations: Readonly<Record<string, AndroidHostOperationDiagnostics>>;
  blockers: readonly string[];
  notes: readonly string[];
}

export function renderAndroidHostSetup(report: AndroidHostDiagnosticsReport): string {
  const environment = report.environment;
  return [
    "# Android Spider Host Setup",
    "",
    `Status: **${report.status}**`,
    "",
    "The Android Host is a standalone APK. Electron talks to it through ADB port forwarding and a loopback JSON-RPC socket.",
    "",
    "## Environment",
    "",
    `- Android SDK: ${environment.sdkFound ? `PASS (${code(environment.sdkPath ?? "")})` : "BLOCKED"}`,
    `- ADB: ${environment.adbFound ? `PASS (${code(environment.adbPath ?? "")})` : "BLOCKED"}`,
    `- Device: ${environment.deviceFound ? `PASS (${code(environment.deviceSerial ?? "")})` : "BLOCKED"}`,
    `- Host APK: ${environment.hostApkFound ? `PASS (${code(environment.hostApkPath ?? "")})` : "BLOCKED"}`,
    `- Host installed: ${environment.hostInstalled ? "PASS" : "BLOCKED"}`,
    `- Host RPC health: ${environment.hostOnline ? "PASS" : "BLOCKED"}`,
    `- Android Host available: ${(environment.androidHostAvailable ?? environment.hostOnline) ? "true" : "false"}`,
    "",
    "## Commands",
    "",
    "```text",
    "npm run android-host:build",
    "npm run android-host:check",
    "npm run android-host:install",
    "npm run android-host:start",
    "npm run android-host:stop",
    "```",
    "",
    "The commands do not download Android system images automatically. Use an existing emulator or a connected Android 10+ device; x86_64 is preferred.",
    "",
    ...(report.blockers.length > 0 ? ["## Blockers", "", ...report.blockers.map((item) => `- ${code(item)}`), ""] : []),
  ].join("\n");
}

export function renderAndroidSpiderPocV2(report: AndroidHostDiagnosticsReport): string {
  return [
    "# Android Spider PoC Report V2",
    "",
    `Status: **${report.status}**`,
    `Generated: ${report.generatedAt}`,
    `Config: ${code(report.configUrl)}`,
    `Source: ${code(report.siteKey)} / ${report.siteName}`,
    `API: ${code(report.api)}`,
    ...(report.keyword ? [`Keyword: ${code(report.keyword)}`] : []),
    "",
    "## Artifact",
    "",
    ...(report.artifact ? [
      `- Windows path: ${code(report.artifact.path)}`,
      `- Size: ${report.artifact.size} bytes`,
      `- Windows SHA-256: ${code(report.artifact.sha256)}`,
      `- Android SHA-256: ${code(report.artifact.androidSha256 ?? "not verified")}`,
      `- Jar ID: ${code(report.artifact.jarId ?? "not loaded")}`,
      `- Dex count: ${report.artifact.dexCount ?? "unknown"}`,
      `- loadJar duration: ${report.operations.loadJar?.durationMs ?? "not run"}ms`,
    ] : ["- Artifact was not available."]),
    "",
    "## Class resolution",
    "",
    ...(report.classResolution ? [
      `- API: ${code(report.classResolution.api)}`,
      `- Expected class: ${code(report.classResolution.expectedClass)}`,
      `- Resolved class: ${code(report.classResolution.resolvedClass ?? "not resolved")}`,
      `- Class exists: ${report.classResolution.classExists ? "yes" : "no"}`,
      `- Status: ${report.classResolution.status}`,
      `- Candidates: ${report.classResolution.candidateSpiderClasses.map(code).join(", ") || "none"}`,
    ] : ["- Not run."]),
    "",
    "## Lifecycle and real calls",
    "",
    "| Operation | Status | Details |",
    "| --- | --- | --- |",
    ...Object.entries({ init: report.init, ...report.operations }).map(([name, operation]) => `| ${name} | ${operation?.status ?? "NOT_RUN"} | ${operationDetails(operation)} |`),
    "",
    ...(report.blockers.length > 0 ? ["## Blockers", "", ...report.blockers.map((item) => `- ${code(item)}`), ""] : []),
    ...(report.notes.length > 0 ? ["## Notes", "", ...report.notes.map((item) => `- ${item}`), ""] : []),
  ].join("\n");
}

export function renderAndroidSpiderHostReport(report: AndroidHostDiagnosticsReport): string {
  return [
    "# Android Spider Host Report",
    "",
    `Status: **${report.status}**`,
    "",
    "## Architecture",
    "",
    "`QX Electron → AndroidSpiderBridgeClient → 127.0.0.1 JSON-RPC → ADB forward → Host APK → DexClassLoader → Spider JAR`",
    "",
    "The Host binds only to Android loopback, receives artifacts through ADB, stores them under the application private files directory, and loads them with Android `DexClassLoader`. It does not use a JVM `URLClassLoader`, dex2jar, or Node `require`.",
    "",
    "## Protocol v1",
    "",
    "- Request: `{ id, protocolVersion, method, params }`",
    "- Success: `{ id, protocolVersion, success: true, result }`",
    "- Failure: `{ id, protocolVersion, success: false, error: { code, message, stage } }`",
    "- Required methods: health, runtimeInfo, loadJar, unloadJar, createSpider, destroySpider, init, homeContent, homeVideoContent, categoryContent, searchContent, detailContent, playerContent, proxy, destroyAll",
    "",
    "## Runtime evidence",
    "",
    `- SDK / ADB / device: ${report.environment.sdkFound ? "found" : "missing"} / ${report.environment.adbFound ? "found" : "missing"} / ${report.environment.deviceFound ? "found" : "missing"}`,
    `- APK / installed / RPC: ${report.environment.hostApkFound ? "found" : "missing"} / ${report.environment.hostInstalled ? "yes" : "no"} / ${report.environment.hostOnline ? "PASS" : "BLOCKED"}`,
    `- Android Host available: ${(report.environment.androidHostAvailable ?? report.environment.hostOnline) ? "true" : "false"}`,
    `- Artifact hash: ${report.artifact?.androidSha256 && report.artifact.androidSha256 === report.artifact.sha256 ? "PASS" : "not verified"}`,
    `- Class resolution: ${report.classResolution?.status ?? "NOT_RUN"}`,
    `- Search / detail / player: ${report.operations.searchContent?.status ?? "NOT_RUN"} / ${report.operations.detailContent?.status ?? "NOT_RUN"} / ${report.operations.playerContent?.status ?? "NOT_RUN"}`,
    "",
  ].join("\n");
}

export function renderAndroidSpiderRealRun(report: AndroidHostDiagnosticsReport): string {
  const environment = report.environment;
  const health = environment.rpcHealth ?? {};
  const search = report.operations.searchContent;
  const detail = report.operations.detailContent;
  const player = report.operations.playerContent;
  return [
    "# Android Spider Real Run",
    "",
    `Final: **${report.status}**`,
    `Generated: ${report.generatedAt}`,
    "",
    "## Environment Doctor",
    "",
    `- SDK: ${environment.sdkFound ? "PASS" : "BLOCKED"}${environment.sdkPath ? ` (${code(environment.sdkPath)})` : ""}`,
    `- ADB: ${environment.adbFound ? "PASS" : "BLOCKED"}${environment.adbPath ? ` (${code(environment.adbPath)})` : ""}`,
    `- Device: ${environment.deviceFound ? "PASS" : "BLOCKED"}${environment.deviceSerial ? ` (${code(environment.deviceSerial)})` : ""}`,
    `- Model: ${code(environment.deviceModel ?? "unknown")}`,
    `- Android: ${code(environment.androidVersion ?? "unknown")}`,
    `- SDK int: ${environment.sdkInt ?? "unknown"}`,
    `- ABI: ${code(environment.abi ?? "unknown")}`,
    `- Boot completed: ${environment.bootCompleted === true ? "PASS" : "BLOCKED"}`,
    `- Emulator / AVD: ${environment.emulatorPath ? `${code(environment.emulatorPath)} / ${(environment.avds ?? []).map(code).join(", ") || "none"}` : "not available"}`,
    `- Host APK / installed / RPC: ${environment.hostApkFound ? "PASS" : "BLOCKED"} / ${environment.hostInstalled ? "PASS" : "BLOCKED"} / ${environment.hostOnline ? "PASS" : "BLOCKED"}`,
    `- Host version: ${code(typeof health.version === "string" ? health.version : "unknown")}`,
    "",
    "## Source and runtime",
    "",
    `- Source: ${code(report.siteKey)} / ${report.siteName}`,
    `- API: ${code(report.api)}`,
    `- Runtime: ${code("android-dex")}`,
    `- Keyword: ${code(report.keyword ?? "not supplied")}`,
    `- Artifact: ${report.artifact ? `${code(report.artifact.path)}, SHA Windows=${code(report.artifact.sha256)}, SHA Android=${code(report.artifact.androidSha256 ?? "not verified")}` : "not loaded"}`,
    `- DexClassLoader: ${report.operations.loadJar?.status ?? "NOT_RUN"}, jarId=${code(report.artifact?.jarId ?? "not loaded")}, dexCount=${report.artifact?.dexCount ?? "unknown"}, loadDuration=${report.operations.loadJar?.durationMs ?? "unknown"}ms`,
    `- Resolved class: ${code(report.classResolution?.resolvedClass ?? "not resolved")}, classExists=${report.classResolution?.classExists === true}`,
    "",
    "## Lifecycle and real source calls",
    "",
    "| Stage | Status | Evidence |",
    "| --- | --- | --- |",
    `| health | ${report.operations.health?.status ?? "NOT_RUN"} | ${operationDetails(report.operations.health)} |`,
    `| loadJar | ${report.operations.loadJar?.status ?? "NOT_RUN"} | ${operationDetails(report.operations.loadJar)} |`,
    `| createSpider | ${report.operations.createSpider?.status ?? "NOT_RUN"} | ${operationDetails(report.operations.createSpider)} |`,
    `| init | ${report.init?.status ?? "NOT_RUN"} | ${operationDetails(report.init)} |`,
    `| searchContent | ${search?.status ?? "NOT_RUN"} | ${operationDetails(search)} |`,
    `| detailContent | ${detail?.status ?? "NOT_RUN"} | ${operationDetails(detail)} |`,
    `| playerContent | ${player?.status ?? "NOT_RUN"} | ${operationDetails(player)} |`,
    "",
    "## Search / detail / player summary",
    "",
    `- Search: ${search?.status ?? "NOT_RUN"}, rawResponseLength=${search?.rawResponseLength ?? "unknown"}, resultCount=${search?.resultCount ?? "unknown"}`,
    `- Detail: ${detail?.status ?? "NOT_RUN"}, vodYearPresent=${detail?.vodYearPresent ?? "unknown"}, hasPlayFrom=${detail?.hasPlayFrom ?? "unknown"}, hasPlayUrl=${detail?.hasPlayUrl ?? "unknown"}, playLineCount=${detail?.playLineCount ?? "unknown"}`,
    `- Player: ${player?.status ?? "NOT_RUN"}, urlPresent=${player?.urlPresent ?? "unknown"}, parse=${player?.parse ?? "unknown"}, jx=${player?.jx ?? "unknown"}, format=${player?.format ?? "unknown"}, headerPresent=${player?.headerPresent ?? "unknown"}`,
    "",
    "## RuntimeManager gate",
    "",
    report.status === "PASS"
      ? "AndroidDexRuntime.supported=true is eligible only after this report's real health/load/create/init/search PASS evidence."
      : "AndroidDexRuntime.supported remains false; RuntimeManager and PlaybackSourceResolver are not advertised as Android-capable.",
    "",
    ...(report.blockers.length > 0 ? ["## Blockers", "", ...report.blockers.map((item) => `- ${code(item)}`), ""] : []),
  ].join("\n");
}

export function renderRuntimeDiagnosticsV4(report: AndroidHostDiagnosticsReport): string {
  const environment = report.environment;
  return [
    "# Runtime Diagnostics V4",
    "",
    `Status: **${report.status}**`,
    `Generated: ${report.generatedAt}`,
    "",
    "## Single-source diagnostics",
    "",
    "| Check | Status | Evidence |",
    "| --- | --- | --- |",
    `| Android SDK | ${environment.sdkFound ? "PASS" : "BLOCKED"} | ${code(environment.sdkPath ?? "ANDROID_SDK_NOT_FOUND")} |`,
    `| ADB | ${environment.adbFound ? "PASS" : "BLOCKED"} | ${code(environment.adbPath ?? "ADB_NOT_FOUND")} |`,
    `| Device | ${environment.deviceFound ? "PASS" : "BLOCKED"} | ${code(environment.deviceSerial ?? "ANDROID_DEVICE_NOT_FOUND")} |`,
    `| Device facts | ${environment.deviceFound ? "PASS" : "NOT_RUN"} | ${code([environment.deviceModel, environment.androidVersion, environment.sdkInt === undefined ? undefined : `sdkInt=${environment.sdkInt}`, environment.abi].filter((value): value is string => value !== undefined).join(" / ") || "unknown")} |`,
    `| Boot completed | ${environment.bootCompleted === true ? "PASS" : "BLOCKED"} | ${environment.bootCompleted === true ? "sys.boot_completed=1" : "ANDROID_DEVICE_BOOT_TIMEOUT or not run"} |`,
    `| Host APK | ${environment.hostApkFound ? "PASS" : "BLOCKED"} | ${code(environment.hostApkPath ?? "HOST_APK_NOT_FOUND")} |`,
    `| Host installed | ${environment.hostInstalled ? "PASS" : "BLOCKED"} | ${environment.hostInstalled ? "package installed" : "package missing"} |`,
    `| RPC health | ${environment.hostOnline ? "PASS" : "BLOCKED"} | ${environment.hostOnline ? "health response received" : "HOST_OFFLINE"} |`,
    `| Artifact | ${report.artifact?.androidSha256 ? "PASS" : "NOT_RUN"} | ${code(report.artifact?.androidSha256 ?? "JAR_NOT_TRANSFERRED")} dexCount=${report.artifact?.dexCount ?? "unknown"} |`,
    `| Class | ${report.classResolution?.status ?? "NOT_RUN"} | ${code(report.classResolution?.resolvedClass ?? report.classResolution?.expectedClass ?? "CLASS_NOT_RESOLVED")} |`,
    `| Init | ${report.init?.status ?? "NOT_RUN"} | ${operationDetails(report.init)} |`,
    `| Search | ${report.operations.searchContent?.status ?? "NOT_RUN"} | ${operationDetails(report.operations.searchContent)} |`,
    `| Detail | ${report.operations.detailContent?.status ?? "NOT_RUN"} | ${operationDetails(report.operations.detailContent)} |`,
    `| Player | ${report.operations.playerContent?.status ?? "NOT_RUN"} | ${operationDetails(report.operations.playerContent)} |`,
    "",
    ...(report.blockers.length > 0 ? ["## Blockers", "", ...report.blockers.map((item) => `- ${code(item)}`), ""] : []),
  ].join("\n");
}

function operationDetails(operation: AndroidHostOperationDiagnostics | undefined): string {
  if (!operation) return "not run";
  if (operation.status === "NOT_RUN") return "not run";
  const values = [
    operation.details,
    operation.durationMs === undefined ? undefined : `${operation.durationMs}ms`,
    operation.initException ? `initException=${operation.initException}` : undefined,
    operation.contextDependent === undefined ? undefined : `contextDependent=${operation.contextDependent}`,
    operation.keyword ? `keyword=${operation.keyword}` : undefined,
    operation.rawResponseLength === undefined ? undefined : `rawResponseLength=${operation.rawResponseLength}`,
    operation.resultCount === undefined ? undefined : `resultCount=${operation.resultCount}`,
    operation.vodYearPresent === undefined ? undefined : `vodYearPresent=${operation.vodYearPresent}`,
    operation.hasPlayFrom === undefined ? undefined : `hasPlayFrom=${operation.hasPlayFrom}`,
    operation.hasPlayUrl === undefined ? undefined : `hasPlayUrl=${operation.hasPlayUrl}`,
    operation.playLineCount === undefined ? undefined : `playLineCount=${operation.playLineCount}`,
    operation.urlPresent === undefined ? undefined : `urlPresent=${operation.urlPresent}`,
    operation.parse ? `parse=${operation.parse}` : undefined,
    operation.jx === undefined ? undefined : `jx=${operation.jx}`,
    operation.headerPresent === undefined ? undefined : `headerPresent=${operation.headerPresent}`,
    operation.format ? `format=${operation.format}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return values.join(", ") || "completed";
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`").replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ")}\``;
}
