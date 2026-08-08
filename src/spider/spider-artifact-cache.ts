import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRuntimeError, runtimeErrorMessage, type RuntimeErrorInfo } from "./runtime-errors.js";

export interface SpiderArtifactRequest {
  url: string;
  md5?: string;
  timeoutMs?: number;
}

export interface SpiderArtifact {
  url: string;
  path: string;
  md5: string;
  sha256: string;
  size: number;
  fromCache: boolean;
  etag?: string;
  lastModified?: string;
}

export interface SpiderArtifactCacheOptions {
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  revalidate?: boolean;
}

interface ArtifactMetadata extends SpiderArtifact {
  declaredMd5: string;
  downloadTime: string;
  metadataPath: string;
}

export class SpiderArtifactError extends Error {
  public constructor(
    public readonly code: "jar_download_failed" | "jar_hash_mismatch",
    message: string,
    options?: ErrorOptions,
    public readonly details?: RuntimeErrorInfo,
  ) {
    super(message, options);
    this.name = "SpiderArtifactError";
  }
}

export class SpiderArtifactCache {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly revalidate: boolean;

  public constructor(private readonly root: string, options: SpiderArtifactCacheOptions = {}) {
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 64 * 1024 * 1024));
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30_000));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.revalidate = options.revalidate === true;
  }

  public async get(request: SpiderArtifactRequest): Promise<SpiderArtifact> {
    try {
      return await this.getInternal(request);
    } catch (error) {
      if (error instanceof SpiderArtifactError) throw error;
      const details = normalizeRuntimeError(error, {
        artifactUrl: request.url,
        artifactPath: this.root,
        rootCause: "artifact_download_failed",
      });
      throw new SpiderArtifactError(
        "jar_download_failed",
        runtimeErrorMessage(details),
        { cause: error },
        details,
      );
    }
  }

  private async getInternal(request: SpiderArtifactRequest): Promise<SpiderArtifact> {
    const url = requireHttpUrl(request.url);
    const declaredMd5 = normalizeMd5(request.md5);
    await mkdir(this.root, { recursive: true });
    const cached = await this.findCached(url, declaredMd5);
    if (cached && !this.revalidate) return cached;

    const headers: Record<string, string> = {};
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      if (cached) return cached;
      throw new SpiderArtifactError("jar_download_failed", `Unable to download Spider artifact: ${url}`, { cause: error });
    }
    if (response.status === 304 && cached) return { ...cached, fromCache: true };
    if (!response.ok) {
      if (cached) return cached;
      throw new SpiderArtifactError("jar_download_failed", `Spider artifact returned HTTP ${response.status}: ${url}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readLimitedBody(response, this.maxBytes);
    } catch (error) {
      throw new SpiderArtifactError("jar_download_failed", `Spider artifact download failed: ${url}`, { cause: error });
    }
    const actualMd5 = createHash("md5").update(bytes).digest("hex");
    if (declaredMd5 && actualMd5 !== declaredMd5) {
      throw new SpiderArtifactError("jar_hash_mismatch", `Spider artifact MD5 mismatch: ${url}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const cacheIdentity = createHash("sha256").update(`${url}\0${declaredMd5}\0${sha256}`).digest("hex");
    const artifactPath = join(this.root, `artifact-${cacheIdentity}.jar`);
    const metadataPath = join(this.root, `artifact-${cacheIdentity}.json`);
    const temporaryPath = join(this.root, `.artifact-${cacheIdentity}.${process.pid}.tmp`);
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx" }).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await writeFile(temporaryPath, bytes);
      });
      await rename(temporaryPath, artifactPath);
      const metadata: ArtifactMetadata = {
        url,
        path: artifactPath,
        md5: actualMd5,
        sha256,
        size: bytes.byteLength,
        fromCache: false,
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
        declaredMd5,
        downloadTime: new Date().toISOString(),
        metadataPath,
      };
      await atomicWriteJson(metadataPath, metadata);
      return publicArtifact(metadata);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async findCached(url: string, declaredMd5: string): Promise<SpiderArtifact | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return undefined;
    }
    for (const entry of entries.filter((item) => item.endsWith(".json"))) {
      try {
        const metadata = JSON.parse(await readFile(join(this.root, entry), "utf8")) as ArtifactMetadata;
        if (metadata.url !== url || metadata.declaredMd5 !== declaredMd5) continue;
        const file = await stat(metadata.path);
        if (file.size !== metadata.size) continue;
        return {
          ...publicArtifact(metadata),
          fromCache: true,
          ...(metadata.etag ? { etag: metadata.etag } : {}),
          ...(metadata.lastModified ? { lastModified: metadata.lastModified } : {}),
        };
      } catch {
        // Ignore stale or partially written metadata and try the next entry.
      }
    }
    return undefined;
  }
}

function publicArtifact(metadata: ArtifactMetadata): SpiderArtifact {
  return {
    url: metadata.url,
    path: metadata.path,
    md5: metadata.md5,
    sha256: metadata.sha256,
    size: metadata.size,
    fromCache: metadata.fromCache,
    ...(metadata.etag ? { etag: metadata.etag } : {}),
    ...(metadata.lastModified ? { lastModified: metadata.lastModified } : {}),
  };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Spider artifact exceeds maximum size");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Spider artifact exceeds maximum size");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Spider artifact exceeds maximum size");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeMd5(value: string | undefined): string {
  if (!value) return "";
  const normalized = value.trim().toLowerCase();
  if (normalized && !/^[\da-f]{32}$/u.test(normalized)) throw new Error("Declared Spider MD5 is invalid");
  return normalized;
}

function requireHttpUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new SpiderArtifactError("jar_download_failed", "Spider artifact URL must be HTTP(S) without credentials");
  }
  return url.toString();
}
