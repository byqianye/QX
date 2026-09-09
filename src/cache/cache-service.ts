import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { CacheRepository, type CacheEntryRecord } from "../data/repositories.js";
import { safeHistoryIdentifier } from "../history/history-progress.js";
import {
  CACHE_TYPES,
  type CacheClearScope,
  type CacheLease,
  type CacheType,
  type CacheTypeSummary,
  type CacheUiState,
  isCacheType,
} from "./cache-types.js";

export const CACHE_TTL_MS: Readonly<Record<CacheType, number>> = {
  poster: 30 * 24 * 60 * 60 * 1_000,
  backdrop: 30 * 24 * 60 * 60 * 1_000,
  "source-config": 7 * 24 * 60 * 60 * 1_000,
  home: 5 * 60 * 1_000,
  category: 5 * 60 * 1_000,
  search: 10 * 60 * 1_000,
  detail: 24 * 60 * 60 * 1_000,
  subtitle: 24 * 60 * 60 * 1_000,
  "parser-metadata": 24 * 60 * 60 * 1_000,
  temporary: 5 * 60 * 1_000,
};

export const CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const CACHE_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
export const CACHE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

const IMAGE_MAGIC: ReadonlyArray<{ mime: string; test: (bytes: Buffer) => boolean }> = [
  { mime: "image/jpeg", test: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: "image/png", test: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/gif", test: (bytes) => bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a" },
  { mime: "image/webp", test: (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" },
  { mime: "image/avif", test: (bytes) => bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && bytes.subarray(8, 12).toString("ascii") === "avif" },
];

export interface CacheServiceOptions {
  root: string;
  repository: CacheRepository;
  now?: () => number;
  maxBytes?: number;
  maxEntryBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface CachePutInput {
  type: CacheType;
  key: string | Record<string, unknown>;
  sourceId?: string | null;
  bytes: Uint8Array;
  contentType?: string | null;
  etag?: string | null;
  ttlMs?: number;
  extension?: string;
}

export interface CacheImageInput {
  type: "poster" | "backdrop";
  key: string | Record<string, unknown>;
  sourceId?: string | null;
  bytes?: Uint8Array;
  url?: string;
  contentType?: string | null;
  maxBytes?: number;
}

export interface CacheImageResult {
  status: "stored" | "placeholder";
  record: CacheEntryRecord | null;
  errorCode: string | null;
}

export class CacheService {
  private readonly root: string;
  private readonly repository: CacheRepository;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly inUse = new Set<string>();
  private readonly writes = new Map<string, Promise<CacheEntryRecord>>();

  public constructor(options: CacheServiceOptions) {
    this.root = resolve(options.root);
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.maxBytes = positiveInteger(options.maxBytes, CACHE_MAX_BYTES);
    this.maxEntryBytes = positiveInteger(options.maxEntryBytes, CACHE_MAX_ENTRY_BYTES);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ensureRoot();
  }

  public get rootPath(): string {
    return this.root;
  }

  public cacheKey(type: CacheType, key: string | Record<string, unknown>): string {
    if (!isCacheType(type)) throw cacheError("CACHE_TYPE_INVALID");
    return `${type}:${sha256(stableSerialize(key))}`;
  }

  public async put(input: CachePutInput): Promise<CacheEntryRecord> {
    const cacheKey = this.cacheKey(input.type, input.key);
    const existing = this.get(cacheKey);
    if (existing) return existing;
    const pending = this.writes.get(cacheKey);
    if (pending) return pending;
    const write = this.write(cacheKey, input);
    this.writes.set(cacheKey, write);
    try {
      return await write;
    } finally {
      this.writes.delete(cacheKey);
    }
  }

  public get(cacheKey: string): CacheEntryRecord | null {
    const record = this.repository.get(cacheKey);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= this.now()) {
      if (!this.inUse.has(cacheKey)) this.remove(record);
      return null;
    }
    const path = this.safePath(record.path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      if (!this.inUse.has(cacheKey)) this.repository.delete(cacheKey);
      return null;
    }
    this.repository.touch(cacheKey, this.now());
    return this.repository.get(cacheKey);
  }

  public read(cacheKey: string): Buffer | null {
    const lease = this.acquire(cacheKey);
    if (!lease) return null;
    try {
      return readFileSync(lease.path);
    } finally {
      lease.release();
    }
  }

  public acquire(cacheKey: string): CacheLease | null {
    const record = this.get(cacheKey);
    if (!record) return null;
    const path = this.safePath(record.path);
    this.inUse.add(cacheKey);
    let released = false;
    return {
      record,
      path,
      release: () => {
        if (released) return;
        released = true;
        this.inUse.delete(cacheKey);
      },
    };
  }

  public async cacheImage(input: CacheImageInput): Promise<CacheImageResult> {
    try {
      const maxBytes = positiveInteger(input.maxBytes, CACHE_MAX_IMAGE_BYTES);
      const bytes = Buffer.from(input.bytes ?? await this.downloadImage(input.url, maxBytes));
      if (bytes.length > maxBytes) throw cacheError("CACHE_IMAGE_TOO_LARGE");
      const detected = detectImage(bytes);
      if (!detected) throw cacheError("CACHE_IMAGE_DECODE_FAILED");
      const declared = normalizeMime(input.contentType);
      if (declared !== null && declared !== detected) throw cacheError("CACHE_IMAGE_MIME_MISMATCH");
      const extension = IMAGE_MIME_TO_EXTENSION[detected] ?? "bin";
      const record = await this.put({
        type: input.type,
        key: input.key,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        bytes,
        contentType: detected,
        extension,
      });
      return { status: "stored", record, errorCode: null };
    } catch (error) {
      return { status: "placeholder", record: null, errorCode: errorCode(error) };
    }
  }

  public uiState(): CacheUiState {
    const byType = CACHE_TYPES.map((type): CacheTypeSummary => {
      const entries = this.repository.list(type);
      return {
        type,
        count: entries.filter((entry) => this.fileSize(entry) !== null).length,
        bytes: entries.reduce((total, entry) => total + (this.fileSize(entry) ?? 0), 0),
      };
    });
    return {
      totalBytes: byType.reduce((total, item) => total + item.bytes, 0),
      maxBytes: this.maxBytes,
      entries: byType.reduce((total, item) => total + item.count, 0),
      byType,
    };
  }

  public clear(scope: CacheClearScope): number {
    if (scope === "expired") return this.clearExpired();
    if (scope === "images") return this.clearTypes(["poster", "backdrop"]);
    if (scope === "search") return this.clearTypes(["search"]);
    return this.clearTypes(CACHE_TYPES);
  }

  public clearExpired(): number {
    const now = this.now();
    return this.repository.list().reduce((count, record) => {
      if (record.expiresAt === null || record.expiresAt > now) return count;
      return this.remove(record) ? count + 1 : count;
    }, 0);
  }

  public prune(): number {
    let removed = this.clearExpired();
    let total = this.repository.list().reduce((sum, record) => sum + (this.fileSize(record) ?? 0), 0);
    if (total <= this.maxBytes) return removed;
    const candidates = this.repository.list()
      .filter((record) => !this.inUse.has(record.cacheKey))
      .sort((left, right) => left.accessedAt - right.accessedAt);
    for (const record of candidates) {
      if (total <= this.maxBytes) break;
      const size = this.fileSize(record) ?? 0;
      if (this.remove(record)) {
        removed += 1;
        total -= size;
      }
    }
    return removed;
  }

  private async write(cacheKey: string, input: CachePutInput): Promise<CacheEntryRecord> {
    const bytes = Buffer.from(input.bytes);
    if (bytes.length > this.maxEntryBytes) throw cacheError("CACHE_ENTRY_TOO_LARGE");
    const contentHash = sha256(bytes);
    const folder = cacheFolder(input.type);
    const extension = safeExtension(input.extension);
    const relativePath = `${folder}/${sha256(cacheKey)}-${contentHash}.${extension}`;
    const path = this.safePath(relativePath);
    mkdirSync(dirname(path), { recursive: true });
    this.assertNoSymlinkPath(path);
    const temporary = this.safePath(`${folder}/.${contentHash}.${randomUUID()}.tmp`);
    const previous = this.repository.get(cacheKey);
    try {
      writeFileSync(temporary, bytes, { flag: "wx" });
      if (existsSync(path)) {
        const current = lstatSync(path);
        if (current.isSymbolicLink()) throw cacheError("CACHE_SYMLINK_ESCAPE");
        unlinkSync(path);
      }
      renameSync(temporary, path);
      const createdAt = this.now();
      const ttlMs = input.ttlMs === undefined ? CACHE_TTL_MS[input.type] : nonNegativeInteger(input.ttlMs);
      const record: CacheEntryRecord = {
        cacheKey,
        type: input.type,
        sourceId: input.sourceId ? safeHistoryIdentifier(input.sourceId) : null,
        path: relativePath,
        size: bytes.length,
        createdAt,
        accessedAt: createdAt,
        expiresAt: ttlMs === 0 ? createdAt : createdAt + ttlMs,
        etag: input.etag ?? null,
        contentHash,
      };
      this.repository.upsert(record);
      this.prune();
      return record;
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
      if (!previous && existsSync(path)) rmSync(path, { force: true });
      throw error;
    }
  }

  private async downloadImage(url: string | undefined, maxBytes: number): Promise<Buffer> {
    if (!url) throw cacheError("CACHE_IMAGE_DOWNLOAD_FAILED");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw cacheError("CACHE_IMAGE_DOWNLOAD_FAILED");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw cacheError("CACHE_IMAGE_DOWNLOAD_FAILED");
    }
    const response = await this.fetchImpl(url, { redirect: "error" });
    if (!response.ok) throw cacheError("CACHE_IMAGE_DOWNLOAD_FAILED");
    const contentType = normalizeMime(response.headers.get("content-type"));
    if (contentType === "text/html" || (contentType !== null && !contentType.startsWith("image/"))) {
      throw cacheError("CACHE_IMAGE_MIME_INVALID");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw cacheError("CACHE_IMAGE_TOO_LARGE");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw cacheError("CACHE_IMAGE_TOO_LARGE");
    const detected = detectImage(bytes);
    if (!detected || (contentType !== null && contentType !== detected)) {
      throw cacheError("CACHE_IMAGE_DECODE_FAILED");
    }
    return bytes;
  }

  private clearTypes(types: readonly CacheType[]): number {
    const allowed = new Set(types);
    return this.repository.list().reduce((count, record) => {
      if (!allowed.has(record.type as CacheType)) return count;
      return this.remove(record) ? count + 1 : count;
    }, 0);
  }

  private remove(record: CacheEntryRecord): boolean {
    if (this.inUse.has(record.cacheKey)) return false;
    const path = this.safePath(record.path, true);
    if (existsSync(path)) rmSync(path, { force: true });
    this.repository.delete(record.cacheKey);
    return true;
  }

  private fileSize(record: CacheEntryRecord): number | null {
    try {
      const path = this.safePath(record.path);
      const stat = statSync(path);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  private ensureRoot(): void {
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw cacheError("CACHE_SYMLINK_ESCAPE");
    mkdirSync(this.root, { recursive: true });
    this.assertNoSymlinkPath(this.root);
  }

  private safePath(relativePath: string, allowFinalSymlink = false): string {
    if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) throw cacheError("CACHE_PATH_INVALID");
    const candidate = resolve(this.root, relativePath);
    if (!isWithin(this.root, candidate)) throw cacheError("CACHE_PATH_TRAVERSAL");
    this.assertNoSymlinkPath(candidate, allowFinalSymlink);
    return candidate;
  }

  private assertNoSymlinkPath(candidate: string, allowFinalSymlink = false): void {
    const rootReal = realpathSync.native(this.root);
    let current = candidate;
    while (true) {
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) {
          if (!(allowFinalSymlink && current === candidate)) throw cacheError("CACHE_SYMLINK_ESCAPE");
        } else {
          const real = realpathSync.native(current);
          if (!isWithin(rootReal, real)) throw cacheError("CACHE_SYMLINK_ESCAPE");
        }
      }
      if (current === this.root) break;
      const parent = dirname(current);
      if (parent === current || !isWithin(this.root, parent)) break;
      current = parent;
    }
  }
}

function cacheFolder(type: CacheType): string {
  return type.replace(/[^a-z0-9-]/gi, "-");
}

function safeExtension(value: string | undefined): string {
  return value && /^[a-z0-9]{1,8}$/i.test(value) ? value.toLowerCase() : "bin";
}

function detectImage(bytes: Buffer): string | null {
  return IMAGE_MAGIC.find((candidate) => candidate.test(bytes))?.mime ?? null;
}

function normalizeMime(value: string | null | undefined): string | null {
  if (!value) return null;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime || null;
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function cacheError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "CACHE_IMAGE_FAILED";
}
