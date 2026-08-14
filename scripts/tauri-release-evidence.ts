import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(projectRoot, args.output ?? "artifacts");
const installer = requiredPath(args["installer"] ?? process.env.QX_TAURI_NSIS, "--installer or QX_TAURI_NSIS");
const componentManifest = requiredPath(args["component-manifest"], "--component-manifest");
const componentSignature = requiredPath(args["component-signature"], "--component-signature");
const componentPublicKey = requiredPath(args["component-public-key"], "--component-public-key");
const componentArtifact = requiredPath(args["component-artifact"], "--component-artifact");
const componentId = args["component-id"]?.trim();
if (!componentId) throw new Error("missing --component-id");
const manifestUrl = requiredHttps(args["manifest-url"], "--manifest-url");
const artifactUrl = requiredHttps(args["artifact-url"], "--artifact-url");

const manifest = readFileSync(componentManifest);
const signature = decodeBase64File(componentSignature, "component signature");
const publicKey = decodeBase64File(componentPublicKey, "component public key");
const artifact = readFileSync(componentArtifact);
const manifestSignatureVerified = verifyManifest(manifest, signature, publicKey);
const artifactSha256 = sha256(artifact);
const manifestComponent = readManifestComponent(manifest, componentId);
const manifestComponentMatches = manifestComponent?.sha256 === artifactSha256
  && manifestComponent.url === artifactUrl;
const authenticode = readAuthenticode(installer);
const installerSha256 = sha256(readFileSync(installer));
const verified = manifestSignatureVerified
  && manifestComponentMatches
  && artifact.length > 0
  && authenticode.authenticodeStatus === "Valid"
  && authenticode.timestamped;

const componentEvidence = {
  schemaVersion: "v1",
  evidenceType: "tauri-components-release",
  verified,
  manifestSignatureVerified,
  signatureAlgorithm: "Ed25519",
  componentId,
  manifestComponentMatches,
  manifestUrl,
  artifactUrl,
  artifactSha256,
  artifactBytes: artifact.length,
  manifestSha256: sha256(manifest),
  generatedBy: "scripts/tauri-release-evidence.ts",
};
const signatureEvidence = {
  schemaVersion: "v1",
  evidenceType: "tauri-signature",
  verified,
  authenticodeStatus: authenticode.authenticodeStatus,
  timestamped: authenticode.timestamped,
  signer: authenticode.signer,
  installerSha256,
  installer,
  generatedBy: "scripts/tauri-release-evidence.ts",
};

console.log(JSON.stringify({ component: componentEvidence, signature: signatureEvidence }, null, 2));
if (!verified) {
  throw new Error("TAURI_RELEASE_EVIDENCE_FAILED: manifest signature, manifest/component binding, component bytes, Authenticode status, and timestamp are all required");
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "tauri-components-release.json"), `${JSON.stringify(componentEvidence, null, 2)}\n`, "utf8");
writeFileSync(resolve(outputDir, "tauri-signature.json"), `${JSON.stringify(signatureEvidence, null, 2)}\n`, "utf8");
console.log(`TAURI_RELEASE_EVIDENCE_WRITTEN: ${outputDir}`);

function parseArgs(values: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) throw new Error(`unexpected argument: ${value ?? ""}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${value}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function requiredPath(value: string | undefined, label: string): string {
  const path = value?.trim();
  if (!path || !existsSync(path)) throw new Error(`missing ${label}`);
  return resolve(path);
}

function requiredHttps(value: string | undefined, label: string): string {
  if (!value || !/^https:\/\//iu.test(value)) throw new Error(`${label} must be an HTTPS URL`);
  return value;
}

function decodeBase64File(path: string, label: string): Buffer {
  const value = readFileSync(path, "utf8").trim();
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.length === 0 || decoded.toString("base64") !== value.replace(/\s+/gu, "")) {
    throw new Error(`${label} must contain base64`);
  }
  return decoded;
}

function verifyManifest(manifest: Buffer, signature: Buffer, rawPublicKey: Buffer): boolean {
  if (signature.length !== 64 || rawPublicKey.length !== 32) return false;
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, rawPublicKey]), format: "der", type: "spki" });
  return verify(null, manifest, publicKey, signature);
}

function readManifestComponent(manifest: Buffer, componentId: string): { sha256?: unknown; url?: unknown } | undefined {
  try {
    const value = JSON.parse(manifest.toString("utf8")) as { version?: unknown; components?: unknown };
    if (value.version !== 1 || !Array.isArray(value.components)) return undefined;
    const component = value.components.find((candidate) => isRecord(candidate) && candidate.id === componentId);
    return isRecord(component) ? component : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
