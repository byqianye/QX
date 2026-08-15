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
const componentArtifacts = requiredList(args["component-artifact"], "--component-artifact").map((value) => requiredPath(value, "--component-artifact"));
const componentIds = requiredList(args["component-id"], "--component-id");
const manifestUrl = requiredHttps(args["manifest-url"], "--manifest-url");
const artifactUrls = requiredList(args["artifact-url"], "--artifact-url").map((value) => requiredHttps(value, "--artifact-url"));
if (componentIds.length !== componentArtifacts.length || componentIds.length !== artifactUrls.length) {
  throw new Error("--component-id, --component-artifact, and --artifact-url must contain the same number of comma-separated values");
}

const manifest = readFileSync(componentManifest);
const signature = decodeBase64File(componentSignature, "component signature");
const publicKey = decodeBase64File(componentPublicKey, "component public key");
const manifestSignatureVerified = verifyManifest(manifest, signature, publicKey);
const components = componentIds.map((componentId, index) => {
  const artifact = readFileSync(componentArtifacts[index]!);
  const artifactSha256 = sha256(artifact);
  const manifestComponent = readManifestComponent(manifest, componentId);
  return {
    componentId,
    artifactSha256,
    artifactBytes: artifact.length,
    artifactUrl: artifactUrls[index]!,
    manifestComponentMatches: manifestComponent?.sha256 === artifactSha256
      && manifestComponent.url === artifactUrls[index],
  };
});
const manifestComponentMatches = components.every((component) => component.manifestComponentMatches);
const authenticode = readAuthenticode(installer);
const installerSha256 = sha256(readFileSync(installer));
const verified = manifestSignatureVerified
  && manifestComponentMatches
  && components.every((component) => component.artifactBytes > 0)
  && authenticode.authenticodeStatus === "Valid"
  && authenticode.timestamped;

const componentEvidence = {
  schemaVersion: "v1",
  evidenceType: "tauri-components-release",
  verified,
  manifestSignatureVerified,
  signatureAlgorithm: "Ed25519",
  componentId: components[0]!.componentId,
  components,
  manifestComponentMatches,
  manifestUrl,
  artifactUrl: components[0]!.artifactUrl,
  artifactSha256: components[0]!.artifactSha256,
  artifactBytes: components[0]!.artifactBytes,
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

function requiredList(value: string | undefined, label: string): string[] {
  const values = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  if (values.length === 0) throw new Error(`missing ${label}`);
  return values;
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
