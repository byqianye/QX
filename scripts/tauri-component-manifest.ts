import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const privateKeyPath = requiredPath(args["private-key"], "--private-key");
const componentsPath = requiredPath(args.components, "--components");
const outputDirectory = resolve(projectRoot, args["output-dir"] ?? "artifacts/release-staging");
const privateKey = loadPrivateKey(privateKeyPath);
const publicKey = deriveRawPublicKey(privateKey);
const configuredPublicKey = process.env.QX_COMPONENT_PUBLIC_KEY_BASE64?.trim();
if (configuredPublicKey && configuredPublicKey !== publicKey.toString("base64")) {
  throw new Error("derived public key does not match QX_COMPONENT_PUBLIC_KEY_BASE64");
}

const components = readComponentSpecs(componentsPath).map((spec) => {
  const artifactPath = requiredPath(spec.artifact, `component ${spec.id} artifact`);
  const artifact = readFileSync(artifactPath);
  if (artifact.length === 0 || artifact.length > 128 * 1024 * 1024) {
    throw new Error(`component ${spec.id} artifact size is invalid`);
  }
  return {
    id: validateComponentId(spec.id),
    version: requireNonEmpty(spec.version, `component ${spec.id} version`),
    target: spec.target ?? "x86_64-pc-windows-msvc",
    sha256: createHash("sha256").update(artifact).digest("hex"),
    url: requireHttps(spec.url, `component ${spec.id} url`),
    ...(spec.payloadPath === undefined ? {} : { payloadPath: validatePayloadPath(spec.payloadPath) }),
  };
});

if (components.length === 0) throw new Error("components spec must contain at least one component");
if (components.some((component) => component.target !== "x86_64-pc-windows-msvc")) {
  throw new Error("all components must target x86_64-pc-windows-msvc");
}

const manifest = Buffer.from(`${JSON.stringify({ version: 1, components }, null, 2)}\n`, "utf8");
if (manifest.length > 256 * 1024) throw new Error("component manifest is too large");
let signature: Buffer;
try {
  signature = sign(null, manifest, privateKey);
} catch (error) {
  throw new Error(`component private key must be an Ed25519 signing key: ${error instanceof Error ? error.message : String(error)}`);
}
if (signature.length !== 64) throw new Error("component signature must be 64 bytes");

mkdirSync(outputDirectory, { recursive: true });
const manifestPath = resolve(outputDirectory, "components-v1.json");
const signaturePath = resolve(outputDirectory, "components-v1.sig.b64");
const publicKeyPath = resolve(outputDirectory, "components-v1.pub.b64");
writeFileSync(manifestPath, manifest);
writeFileSync(signaturePath, `${signature.toString("base64")}\n`, "utf8");
writeFileSync(publicKeyPath, `${publicKey.toString("base64")}\n`, "utf8");

console.log(JSON.stringify({
  manifest: manifestPath,
  signature: signaturePath,
  publicKey: publicKeyPath,
  componentCount: components.length,
  manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  publicKeyBase64: publicKey.toString("base64"),
}, null, 2));

function parseArgs(values: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? ""}`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function requiredPath(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`missing ${label}`);
  const path = resolve(value);
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  return path;
}

function loadPrivateKey(path: string) {
  const raw = readFileSync(path);
  if (raw.includes(Buffer.from("-----BEGIN"))) return createPrivateKey(raw.toString("utf8"));
  return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
}

function deriveRawPublicKey(privateKey: ReturnType<typeof createPrivateKey>): Buffer {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (!der.subarray(0, prefix.length).equals(prefix) || der.length !== prefix.length + 32) {
    throw new Error("private key is not an Ed25519 key");
  }
  return der.subarray(prefix.length);
}

function readComponentSpecs(path: string): ComponentSpec[] {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const specs = Array.isArray(value) ? value : isRecord(value) ? value.components : undefined;
  if (!Array.isArray(specs) || specs.some((spec) => !isRecord(spec))) {
    throw new Error("components spec must be an array or an object with a components array");
  }
  return specs as ComponentSpec[];
}

function validateComponentId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error("component id is invalid");
  }
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireHttps(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^https:\/\//iu.test(value) || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  return value;
}

function validatePayloadPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || value.includes("\\") || value.includes(":") || value.startsWith("/")
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("payloadPath is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ComponentSpec {
  id?: unknown;
  version?: unknown;
  target?: string;
  artifact?: string;
  url?: unknown;
  payloadPath?: unknown;
}
