import type { JarInspectionResult } from "./jar-inspector.js";
import type { RuntimeAuditReport } from "./runtime-audit-types.js";
import type { RuntimeErrorInfo } from "./runtime-errors.js";

export interface AndroidEnvironmentAudit {
  adbPath?: string;
  adbVersion?: string;
  adbDevices: string;
  connectedDevice: boolean;
  androidSdkPath?: string;
  androidSdkAvailable: boolean;
  javaCompilerAvailable: boolean;
  hostExecutable?: string;
  hostAvailable: boolean;
  hostApkPath?: string;
  hostApkAvailable?: boolean;
  hostInstalled?: boolean;
  hostOnline?: boolean;
  deviceSerial?: string;
}

export interface AndroidSpiderPocAttempt {
  operation: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  details?: string;
}

export interface AndroidSpiderPocReport {
  generatedAt: string;
  configUrl: string;
  siteKey: string;
  siteName: string;
  api: string;
  artifactUrl: string;
  artifactPath: string;
  artifact: JarInspectionResult;
  environment: AndroidEnvironmentAudit;
  status: "PASS" | "BLOCKED" | "FAILED";
  attempts: readonly AndroidSpiderPocAttempt[];
  blockers: readonly string[];
  normalizedError?: RuntimeErrorInfo;
}

export function renderAndroidBridgeFeasibility(report: AndroidSpiderPocReport): string {
  const environment = report.environment;
  return [
    "# Android Spider Bridge Feasibility",
    "",
    `Status: **${report.status}**`,
    "",
    "This Goal does not claim Android DEX execution without an Android-compatible Host. The artifact below was downloaded and inspected statically only.",
    "",
    "## Environment evidence",
    "",
    `- adb: ${environment.adbPath ?? "missing"}${environment.adbVersion ? ` (${cell(environment.adbVersion)})` : ""}`,
    `- Connected Android device: ${environment.connectedDevice ? "yes" : "no"}`,
    `- Android SDK: ${environment.androidSdkAvailable ? `available at \`${cell(environment.androidSdkPath ?? "") }\`` : "missing"}`,
    `- Java compiler: ${environment.javaCompilerAvailable ? "available" : "missing"}`,
    `- Android Spider Host health: ${(environment.hostOnline ?? environment.hostAvailable) ? "online" : "offline"}`,
    `- Android Spider Host APK: ${environment.hostApkAvailable ? `available at \`${cell(environment.hostApkPath ?? "") }\`` : "not checked"}`,
    "",
    "## Real artifact",
    "",
    `- Site: \`${cell(report.siteKey)}\` / ${cell(report.siteName)}`,
    `- API: \`${cell(report.api)}\``,
    `- Artifact URL: \`${cell(report.artifactUrl)}\``,
    `- Resolved local path: \`${cell(report.artifactPath)}\``,
    `- Size: ${report.artifact.size} bytes`,
    `- SHA-256: \`${report.artifact.sha256}\``,
    `- classes.dex: ${report.artifact.hasClassesDex ? "yes" : "no"}`,
    `- Runtime requirement: ${report.artifact.runtimeRequirement}`,
    "",
    "## Why this is blocked",
    "",
    ...(report.blockers.length > 0 ? report.blockers.map((blocker) => `- ${cell(blocker)}`) : ["- No environment blocker was detected."]),
    "",
    "## Required Android Host surface",
    "",
    "- Android `DexClassLoader` and a real Android `Context` are required to load and initialize the Spider.",
    "- Android networking, cookies, SharedPreferences/assets, and any WebView/native dependency must be provided by the Host and remain isolated from Electron Renderer.",
    "- The current workspace has no Android SDK/platform package, Host APK/process, or connected device, so these dependencies are unverified.",
    "- Estimated next implementation is a separate Android Host project plus build/runtime packaging; it is not a safe Node/JVM-only substitution.",
    "",
    "A Windows Electron process cannot load `classes.dex` with the JVM URLClassLoader. A real PASS requires an Android-compatible Host process and a connected Android runtime/device, or an explicitly provided equivalent runtime.",
    "",
  ].join("\n");
}

export function renderAndroidSpiderPoc(report: AndroidSpiderPocReport): string {
  return [
    "# Android Spider PoC Report",
    "",
    `Status: **${report.status}**`,
    `Generated: ${report.generatedAt}`,
    `Config: \`${cell(report.configUrl)}\``,
    `Source: \`${cell(report.siteKey)}\` / ${cell(report.siteName)}`,
    `API: \`${cell(report.api)}\``,
    "",
    "## Artifact",
    "",
    `- URL: \`${cell(report.artifactUrl)}\``,
    `- Local path: \`${cell(report.artifactPath)}\``,
    `- Runtime: ${report.artifact.runtimeRequirement}`,
    `- SHA-256: \`${report.artifact.sha256}\``,
    "",
    "## Required operations",
    "",
    "| Operation | Status | Details |",
    "| --- | --- | --- |",
    ...report.attempts.map((attempt) => `| ${attempt.operation} | ${attempt.status} | ${cell(attempt.details ?? "")} |`),
    "",
    ...(report.normalizedError ? [
      "## Normalized failure",
      "",
      "```json",
      JSON.stringify(report.normalizedError, null, 2),
      "```",
      "",
    ] : []),
    report.status === "PASS"
      ? "The selected real csp_* source completed the minimum Bridge PoC."
      : "The selected real csp_* source was not reported as executable; the missing prerequisite remains explicit.",
    "",
  ].join("\n");
}

export function renderEnoentAudit(
  report: AndroidSpiderPocReport,
  audit: RuntimeAuditReport,
): string {
  const selected = audit.sites.find((site) => site.siteKey === report.siteKey);
  return [
    "# ENOENT Root-Cause Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Configuration source: \`${cell(report.configUrl)}\``,
    "",
    "ENOENT is not used as the user-facing root cause. Each failure is classified with the missing path and runtime context.",
    "",
    "## Observed source",
    "",
    `| Source | Runtime | Audit result | Root cause |`,
    `| --- | --- | --- | --- |`,
    `| ${cell(report.siteName)} (${cell(report.siteKey)}) | ${selected?.runtime ?? "android-dex"} | ${report.status} | ${report.normalizedError?.rootCause ?? "none"} |`,
    "",
    "## Diagnostic fields",
    "",
    ...(report.normalizedError ? [
      `- errorCode: \`${report.normalizedError.code}\``,
      `- syscall: \`${report.normalizedError.syscall ?? "unknown"}\``,
      `- missingPath: \`${cell(report.normalizedError.missingPath ?? "unknown")}\``,
      `- sourceKey: \`${cell(report.normalizedError.sourceKey ?? report.siteKey)}\``,
      `- sourceName: ${cell(report.normalizedError.sourceName ?? report.siteName)}`,
      `- runtimeKind: \`${report.normalizedError.runtime ?? "android-dex"}\``,
      `- artifactUrl: \`${cell(report.normalizedError.artifactUrl ?? report.artifactUrl)}\``,
      `- resolvedArtifactPath: \`${cell(report.normalizedError.artifactPath ?? report.artifactPath)}\``,
      `- workingDirectory: \`${cell(report.normalizedError.workingDirectory ?? "unknown")}\``,
      `- isPackaged: ${String(report.normalizedError.isPackaged ?? false)}`,
      `- resourcesPath: \`${cell(report.normalizedError.resourcesPath ?? "unknown")}\``,
    ] : ["- No normalized ENOENT was observed."]),
    "",
    "## Current configuration boundary",
    "",
    `- Configured sites: ${audit.summary.totalSites}`,
    `- Searchable sites: ${audit.summary.searchableSites}`,
    `- Android DEX sites not executable by the current desktop runtime: ${audit.summary.runtimeCounts["android-dex"]}`,
    "- Other Android DEX sites were not collapsed into ENOENT; they remain `android_dex_runtime_not_available` until a Host exists.",
    "",
  ].join("\n");
}

export function renderRuntimeDiagnosticsV3(
  report: AndroidSpiderPocReport,
  audit: RuntimeAuditReport,
): string {
  return [
    "# Runtime Diagnostics V3",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Configuration",
    "",
    `- Configured: ${audit.summary.totalSites}`,
    `- Searchable: ${audit.summary.searchableSites}`,
    `- Current supported: ${audit.summary.supportedSites}`,
    `- Searchable supported: ${audit.summary.searchableSupportedSites}`,
    `- Android DEX: ${audit.summary.runtimeCounts["android-dex"]}`,
    `- JavaScript: ${audit.summary.runtimeCounts.javascript}`,
    `- Native: ${audit.summary.runtimeCounts.native}`,
    `- CMS: ${audit.summary.runtimeCounts["cms-json"] + audit.summary.runtimeCounts["cms-xml"]}`,
    "",
    "## Host",
    "",
    `- Host: ${report.environment.hostAvailable ? "online candidate" : "missing"}`,
    `- adb device: ${report.environment.connectedDevice ? "online" : "offline"}`,
    `- Artifact: ${report.artifact.runtimeRequirement}, ${report.artifact.size} bytes`,
    `- Selected source initialization: ${report.status === "PASS" ? "success" : "blocked"}`,
    "",
    "## Selected source",
    "",
    `- ${cell(report.siteName)} (${cell(report.siteKey)})`,
    `- API: \`${cell(report.api)}\``,
    `- Search: ${statusFor(report, "searchContent")}`,
    `- Detail: ${statusFor(report, "detailContent")}`,
    `- Player: ${statusFor(report, "playerContent")}`,
    "",
    report.status === "PASS" ? "Bridge PoC status: PASS" : "Bridge PoC status: BLOCKED; no unsupported capability is advertised.",
    "",
  ].join("\n");
}

function statusFor(report: AndroidSpiderPocReport, operation: string): string {
  return report.attempts.find((attempt) => attempt.operation === operation)?.status ?? "not_run";
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
}
