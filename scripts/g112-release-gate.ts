import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const failures: string[] = [];
const warnings: string[] = [];
const allowIncomplete = process.argv.includes("--allow-incomplete");

const packageJson = readJson(join(root, "package.json")) as { version?: string };
const tauriConfig = readJson(join(root, "src-tauri", "tauri.conf.json")) as {
  version?: string;
  identifier?: string;
  bundle?: { targets?: string[] };
};

check("Tauri identifier", tauriConfig.identifier === "com.qx.yingshi.desktop");
check("Tauri NSIS target", tauriConfig.bundle?.targets?.includes("nsis") === true);
check("package semver", typeof packageJson.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(packageJson.version));
check("Tauri version matches package version", tauriConfig.version === packageJson.version);
check("G107 report exists", existsSync(join(root, "G107-BASELINE-REPORT.md")));
check("G108 report exists", existsSync(join(root, "G108-REPORT.md")));
check("G109 report exists", existsSync(join(root, "G109-REPORT.md")));
check("G110 report exists", existsSync(join(root, "G110-REPORT.md")));
check("G111 report exists", existsSync(join(root, "G111-REPORT.md")));
check("old Electron remains during migration", existsSync(join(root, "src", "electron", "main.ts")));
check("Tauri backend remains", existsSync(join(root, "src-tauri", "src", "lib.rs")));

const configuredInstaller = process.env.QX_TAURI_NSIS?.trim();
const installerDirectories = [
  join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle", "nsis"),
  join(root, "src-tauri", "target", "release", "bundle", "nsis"),
];
const installer = configuredInstaller ?? installerDirectories[0]!;
const discoveredInstaller = installerDirectories
  .flatMap((directory) => existsSync(directory)
    ? readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith(".exe"))
      .map((name) => join(directory, name))
    : [])
  .at(0);
const measuredInstaller = configuredInstaller && existsSync(configuredInstaller)
  ? configuredInstaller
  : discoveredInstaller;
if (measuredInstaller) {
  check("NSIS <= 20 MiB", statSync(measuredInstaller).size <= 20 * 1024 * 1024, `${statSync(measuredInstaller).size} bytes`);
  const authenticode = readAuthenticode(measuredInstaller);
  releaseCheck("NSIS Authenticode status", authenticode.authenticodeStatus === "Valid", authenticode.authenticodeStatus);
  releaseCheck("NSIS Authenticode timestamp", authenticode.timestamped, String(authenticode.timestamped));
} else {
  warnings.push(`NSIS artifact not found: ${installer}`);
}

for (const [label, relativePath] of [
  ["clean Win11 E2E report", "artifacts/tauri-clean-win11-e2e.json"],
  ["fresh-user Tauri upgrade E2E report", "artifacts/tauri-upgrade-win11-e2e.json"],
  ["20-second HLS E2E report", "artifacts/tauri-hls-20s-e2e.json"],
  ["signed component Releases report", "artifacts/tauri-components-release.json"],
  ["Authenticode signature report", "artifacts/tauri-signature.json"],
] as const) {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    checkReleaseEvidence(label, false, relativePath);
    continue;
  }
  const evidence = readEvidence(path, label);
    if (evidence) {
      validateEvidence(relativePath, evidence);
      if (relativePath.endsWith("tauri-signature.json") && measuredInstaller) {
        checkEvidenceField(relativePath, evidence, "installerSha256", sha256File(measuredInstaller));
        const authenticode = readAuthenticode(measuredInstaller);
        checkEvidenceField(relativePath, evidence, "authenticodeStatus", authenticode.authenticodeStatus);
        checkEvidenceField(relativePath, evidence, "timestamped", authenticode.timestamped);
      }
  }
}

for (const report of ["G108-REPORT.md", "G109-REPORT.md", "G110-REPORT.md", "G111-REPORT.md", "G112-REPORT.md"]) {
  const text = readFileSync(join(root, report), "utf8");
  if (!/^Status:\s*complete\s*$/imu.test(text)) {
    const message = `${report} is not complete`;
    if (allowIncomplete) warnings.push(message);
    else failures.push(message);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`g112-release-gate: FAIL ${failure}`);
  for (const warning of warnings) console.error(`g112-release-gate: WARN ${warning}`);
  process.exit(1);
}

for (const warning of warnings) console.warn(`g112-release-gate: WARN ${warning}`);
console.log(`g112-release-gate: PASS structural checks${allowIncomplete ? " (incomplete override)" : ""}`);

function check(label: string, condition: boolean, detail?: string): void {
  if (!condition) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}

function checkReleaseEvidence(label: string, condition: boolean, detail?: string): void {
  if (condition) return;
  const message = `${label}${detail ? ` (${detail})` : ""} is missing`;
  if (allowIncomplete) warnings.push(message);
  else failures.push(message);
}

function releaseCheck(label: string, condition: boolean, detail?: string): void {
  if (condition) return;
  const message = `${label}${detail ? ` (${detail})` : ""} is not valid`;
  if (allowIncomplete) warnings.push(message);
  else failures.push(message);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readEvidence(path: string, label: string): Record<string, unknown> | undefined {
  try {
    const value = readJson(path);
    if (!isRecord(value)) {
      evidenceFailure(`${label} must be a JSON object`);
      return undefined;
    }
    return value;
  } catch (error) {
    evidenceFailure(`${label} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

function validateEvidence(relativePath: string, evidence: Record<string, unknown>): void {
  checkEvidenceField(relativePath, evidence, "schemaVersion", "v1");
  checkEvidenceField(relativePath, evidence, "verified", true);

  if (relativePath.endsWith("tauri-clean-win11-e2e.json")) {
    checkEvidenceField(relativePath, evidence, "evidenceType", "tauri-clean-win11-e2e");
    checkEvidenceField(relativePath, evidence, "cleanInstall", true);
    checkEvidenceField(relativePath, evidence, "platform", "win32-x64");
    checkNestedEvidenceField(relativePath, evidence, "observations", "appExitedGracefully", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "noNewRuntimeProcessesAfterLaunch", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "noNewRuntimeProcessesAfterUninstall", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "webviewProfileRemoved", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "runnerWorkspaceRemoved", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "runnerWorkspaceCleanupFailed", false);
    checkSha256Field(relativePath, evidence, "installerSha256");
    if (measuredInstaller) checkEvidenceField(relativePath, evidence, "installerSha256", sha256File(measuredInstaller));
  } else if (relativePath.endsWith("tauri-upgrade-win11-e2e.json")) {
    checkEvidenceField(relativePath, evidence, "evidenceType", "tauri-upgrade-win11-e2e");
    checkEvidenceField(relativePath, evidence, "cleanInstall", true);
    checkEvidenceField(relativePath, evidence, "platform", "win32-x64");
    checkEvidenceField(relativePath, evidence, "oldVersion", "0.8.0");
    checkEvidenceField(relativePath, evidence, "newVersion", packageJson.version ?? "");
    const hashes = evidence.hashes;
    if (!isRecord(hashes) || typeof hashes.newInstallerSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(hashes.newInstallerSha256)) {
      evidenceFailure(`${relativePath} hashes.newInstallerSha256 must be a SHA-256 hex digest`);
    } else if (measuredInstaller) {
      checkEvidenceField(relativePath, hashes, "newInstallerSha256", sha256File(measuredInstaller));
    }
    checkNestedEvidenceField(relativePath, evidence, "observations", "oldDatabaseCreated", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "newDatabasePresent", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "markerPreserved", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "installDirectoryRemoved", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "noNewRuntimeProcessesAfterUninstall", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "runnerWorkspaceRemoved", true);
    checkNestedEvidenceField(relativePath, evidence, "observations", "runnerWorkspaceCleanupFailed", false);
  } else if (relativePath.endsWith("tauri-hls-20s-e2e.json")) {
    checkEvidenceField(relativePath, evidence, "evidenceType", "tauri-hls-20s-e2e");
    checkEvidenceField(relativePath, evidence, "realHttp", true);
    checkSha256Field(relativePath, evidence, "installerSha256");
    if (measuredInstaller) checkEvidenceField(relativePath, evidence, "installerSha256", sha256File(measuredInstaller));
    const duration = evidence.durationSeconds;
    if (typeof duration !== "number" || duration < 20) {
      evidenceFailure(`${relativePath} durationSeconds must be at least 20`);
    }
  } else if (relativePath.endsWith("tauri-components-release.json")) {
    checkEvidenceField(relativePath, evidence, "generatedBy", "scripts/tauri-release-evidence.ts");
    checkEvidenceField(relativePath, evidence, "evidenceType", "tauri-components-release");
    checkEvidenceField(relativePath, evidence, "manifestSignatureVerified", true);
    checkEvidenceField(relativePath, evidence, "manifestComponentMatches", true);
    checkEvidenceField(relativePath, evidence, "signatureAlgorithm", "Ed25519");
    checkHttpsField(relativePath, evidence, "manifestUrl");
    checkHttpsField(relativePath, evidence, "artifactUrl");
    checkSha256Field(relativePath, evidence, "artifactSha256");
    const components = evidence.components;
    if (!Array.isArray(components) || components.length === 0) {
      evidenceFailure(`${relativePath} components must contain every signed component`);
    } else {
      for (const [index, component] of components.entries()) {
        if (!isRecord(component)) {
          evidenceFailure(`${relativePath} components[${index}] must be an object`);
          continue;
        }
        if (typeof component.componentId !== "string" || component.componentId.length === 0) {
          evidenceFailure(`${relativePath} components[${index}].componentId is required`);
        }
        if (component.manifestComponentMatches !== true) {
          evidenceFailure(`${relativePath} components[${index}].manifestComponentMatches must equal true`);
        }
        if (typeof component.artifactBytes !== "number" || component.artifactBytes <= 0) {
          evidenceFailure(`${relativePath} components[${index}].artifactBytes must be positive`);
        }
        checkHttpsField(relativePath, component, `components[${index}].artifactUrl`);
        checkSha256Field(relativePath, component, `components[${index}].artifactSha256`);
      }
    }
  } else if (relativePath.endsWith("tauri-signature.json")) {
    checkEvidenceField(relativePath, evidence, "generatedBy", "scripts/tauri-release-evidence.ts");
    checkEvidenceField(relativePath, evidence, "evidenceType", "tauri-signature");
    checkEvidenceField(relativePath, evidence, "authenticodeStatus", "Valid");
    checkEvidenceField(relativePath, evidence, "timestamped", true);
    checkSha256Field(relativePath, evidence, "installerSha256");
  }
}

function checkNestedEvidenceField(
  relativePath: string,
  evidence: Record<string, unknown>,
  parentField: string,
  field: string,
  expected: string | boolean,
): void {
  const parent = evidence[parentField];
  if (!isRecord(parent) || parent[field] !== expected) {
    evidenceFailure(`${relativePath} ${parentField}.${field} must equal ${String(expected)}`);
  }
}

function checkEvidenceField(
  relativePath: string,
  evidence: Record<string, unknown>,
  field: string,
  expected: string | boolean,
): void {
  if (evidence[field] !== expected) {
    evidenceFailure(`${relativePath} ${field} must equal ${String(expected)}`);
  }
}

function checkHttpsField(relativePath: string, evidence: Record<string, unknown>, field: string): void {
  if (typeof evidence[field] !== "string" || !/^https:\/\//iu.test(evidence[field])) {
    evidenceFailure(`${relativePath} ${field} must be an HTTPS URL`);
  }
}

function checkSha256Field(relativePath: string, evidence: Record<string, unknown>, field: string): void {
  if (typeof evidence[field] !== "string" || !/^[a-f0-9]{64}$/iu.test(evidence[field])) {
    evidenceFailure(`${relativePath} ${field} must be a SHA-256 hex digest`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readAuthenticode(path: string): { authenticodeStatus: string; timestamped: boolean; signer: string | null } {
  if (process.platform !== "win32") return { authenticodeStatus: "Unavailable", timestamped: false, signer: null };
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:QX_SIGNATURE_PATH; [pscustomobject]@{ status = $s.Status.ToString(); signer = if ($null -eq $s.SignerCertificate) { $null } else { $s.SignerCertificate.Subject }; timestamped = $null -ne $s.TimeStamperCertificate } | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, QX_SIGNATURE_PATH: path },
  });
  if (result.status !== 0) return { authenticodeStatus: "Unavailable", timestamped: false, signer: null };
  try {
    const value = JSON.parse(result.stdout.trim()) as { status?: unknown; signer?: unknown; timestamped?: unknown };
    return {
      authenticodeStatus: typeof value.status === "string" ? value.status : "Unknown",
      timestamped: value.timestamped === true,
      signer: typeof value.signer === "string" ? value.signer : null,
    };
  } catch {
    return { authenticodeStatus: "Unavailable", timestamped: false, signer: null };
  }
}

function evidenceFailure(message: string): void {
  if (allowIncomplete) warnings.push(message);
  else failures.push(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
