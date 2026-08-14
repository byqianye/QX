import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const manifestUrl = requiredHttps(args["manifest-url"], "--manifest-url");
const signatureUrl = requiredHttps(args["signature-url"], "--signature-url");
const artifactUrl = requiredHttps(args["artifact-url"], "--artifact-url");
const componentId = args["component-id"]?.trim();
const publicKeyBase64 = args["public-key-base64"]?.trim();
if (!componentId) throw new Error("missing --component-id");
if (!publicKeyBase64) throw new Error("missing --public-key-base64");

const directory = await mkdtemp(join(tmpdir(), "qx-tauri-release-download-"));
try {
  const [manifest, signature, artifact] = await Promise.all([
    download(manifestUrl, 256 * 1024),
    download(signatureUrl, 64 * 1024),
    download(artifactUrl, 128 * 1024 * 1024),
  ]);
  const manifestPath = join(directory, "manifest.json");
  const signaturePath = join(directory, "manifest.sig.b64");
  const publicKeyPath = join(directory, "manifest.pub.b64");
  const artifactPath = join(directory, "component.bin");
  await Promise.all([
    writeFile(manifestPath, manifest.bytes),
    writeFile(signaturePath, signature.bytes.toString("utf8").trim(), "utf8"),
    writeFile(publicKeyPath, publicKeyBase64, "utf8"),
    writeFile(artifactPath, artifact.bytes),
  ]);
  const result = await run(process.execPath, [
    join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    join(projectRoot, "scripts", "tauri-release-evidence.ts"),
    "--installer", requiredPath(args["installer"], "--installer"),
    "--component-manifest", manifestPath,
    "--component-signature", signaturePath,
    "--component-public-key", publicKeyPath,
    "--component-artifact", artifactPath,
    "--component-id", componentId,
    "--manifest-url", manifestUrl,
    "--artifact-url", artifactUrl,
    "--output", resolve(projectRoot, args.output ?? "artifacts"),
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`TAURI_RELEASE_DOWNLOAD_CANARY_FAILED: ${result.code}`);
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

interface Downloaded {
  bytes: Buffer;
  finalUrl: string;
}

async function download(url: string, maxBytes: number): Promise<Downloaded> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
  const finalUrl = response.url || url;
  if (!/^https:\/\//iu.test(finalUrl)) throw new Error(`download redirected to a non-HTTPS URL: ${finalUrl}`);
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new Error(`download exceeds limit: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`download size is invalid: ${url}`);
  return { bytes, finalUrl };
}

function parseArgs(values: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument near ${key ?? ""}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function requiredHttps(value: string | undefined, label: string): string {
  if (!value || !/^https:\/\//iu.test(value)) throw new Error(`${label} must be an HTTPS URL`);
  return value;
}

function requiredPath(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`missing ${label}`);
  return resolve(value);
}

function run(executable: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
