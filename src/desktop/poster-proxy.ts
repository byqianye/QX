import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import { CacheService } from "../cache/cache-service.js";

export const POSTER_ROUTE_PREFIX = "/api/poster/";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_HEADERS: Readonly<Record<string, string>> = {
  accept: "Accept",
  "accept-language": "Accept-Language",
  referer: "Referer",
  "user-agent": "User-Agent",
};

export interface PosterReference {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export interface PosterProxyOptions {
  cache?: CacheService;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface PosterDiagnostics {
  sourceKey: string;
  originalUrl: string;
  resolvedUrl: string | null;
  proxyHit: boolean;
  httpStatus: number | null;
  fallbackReason: string | null;
}

interface PosterPayload {
  bytes: Buffer;
  contentType: string;
}

export class PosterProxy {
  private readonly cache: CacheService | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly references = new Map<string, PosterReference>();
  private readonly diagnosticsByToken = new Map<string, PosterDiagnostics>();
  private readonly pending = new Map<string, Promise<PosterPayload>>();

  public constructor(options: PosterProxyOptions = {}) {
    this.cache = options.cache;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  public decorateItem(item: Record<string, unknown>, sourceKey = "unknown"): Record<string, unknown> {
    const raw = typeof item.vod_pic === "string" ? item.vod_pic : "";
    if (!raw.trim()) return { ...item };
    const token = this.register(raw, sourceKey);
    return { ...item, vod_pic: token ? `${POSTER_ROUTE_PREFIX}${token}` : null };
  }

  public decorateState<T extends {
    items: readonly Record<string, unknown>[];
    detail: Record<string, unknown> | null;
    api?: string | null;
    source?: string;
  }>(state: T): T {
    const sourceKey = state.api ?? state.source ?? "unknown";
    return {
      ...state,
      items: state.items.map((item) => this.decorateItem(item, sourceKey)),
      detail: state.detail ? this.decorateItem(state.detail, sourceKey) : null,
    } as T;
  }

  public register(value: string, sourceKey = "unknown"): string | null {
    const reference = parsePosterReference(value);
    if (!reference) return null;
    const key = stableReference(reference);
    const token = createHash("sha256").update(key).digest("hex").slice(0, 40);
    this.references.set(token, reference);
    this.diagnosticsByToken.set(token, {
      sourceKey,
      originalUrl: redactSensitiveSuffix(value),
      resolvedUrl: null,
      proxyHit: false,
      httpStatus: null,
      fallbackReason: null,
    });
    return token;
  }

  public diagnostics(token: string): PosterDiagnostics | null {
    const diagnostics = this.diagnosticsByToken.get(token);
    return diagnostics ? { ...diagnostics } : null;
  }

  public async handle(pathname: string, response: ServerResponse): Promise<boolean> {
    if (!pathname.startsWith(POSTER_ROUTE_PREFIX)) return false;
    const token = pathname.slice(POSTER_ROUTE_PREFIX.length);
    const reference = this.references.get(token);
    if (!reference || !/^[a-f0-9]{40}$/.test(token)) {
      writeError(response, 404, "POSTER_NOT_FOUND");
      return true;
    }
    const diagnostics = this.diagnosticsByToken.get(token);
    if (diagnostics) diagnostics.proxyHit = true;
    try {
      const payload = await this.load(token, reference);
      response.writeHead(200, {
        "cache-control": "private, max-age=3600",
        "content-length": String(payload.bytes.length),
        "content-type": payload.contentType,
        "x-content-type-options": "nosniff",
      });
      response.end(payload.bytes);
    } catch (error) {
      const diagnostics = this.diagnosticsByToken.get(token);
      if (diagnostics) diagnostics.fallbackReason = errorCode(error);
      writeError(response, 502, errorCode(error));
    }
    return true;
  }

  private async load(token: string, reference: PosterReference): Promise<PosterPayload> {
    const existing = this.pending.get(token);
    if (existing) return existing;
    const pending = this.loadOnce(token, reference);
    this.pending.set(token, pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(token);
    }
  }

  private async loadOnce(token: string, reference: PosterReference): Promise<PosterPayload> {
    const cacheInput = cacheKeyInput(reference);
    const cacheKey = this.cache?.cacheKey("poster", cacheInput);
    if (cacheKey && this.cache) {
      const cached = this.cache.read(cacheKey);
      if (cached) {
        const contentType = detectImage(cached);
        if (contentType) {
          const diagnostics = this.diagnosticsByToken.get(token);
          if (diagnostics) {
            diagnostics.proxyHit = true;
            diagnostics.resolvedUrl = reference.url;
          }
          return { bytes: cached, contentType };
        }
      }
    }

    const response = await this.fetchImpl(reference.url, {
      headers: reference.headers,
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const diagnostics = this.diagnosticsByToken.get(token);
    if (diagnostics) {
      diagnostics.httpStatus = response.status;
      diagnostics.resolvedUrl = response.url || reference.url;
    }
    if (!response.ok) throw posterError("POSTER_HTTP_ERROR");
    const declared = normalizeMime(response.headers.get("content-type"));
    if (declared && !declared.startsWith("image/")) throw posterError("POSTER_CONTENT_TYPE_INVALID");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxBytes) throw posterError("POSTER_TOO_LARGE");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.maxBytes) throw posterError("POSTER_TOO_LARGE");
    const contentType = detectImage(bytes);
    if (!contentType || (declared && declared !== contentType)) throw posterError("POSTER_DECODE_FAILED");

    if (this.cache && cacheKey) {
      const stored = await this.cache.cacheImage({
        type: "poster",
        key: cacheInput,
        bytes,
        contentType,
        maxBytes: this.maxBytes,
      });
      if (stored.status !== "stored") throw posterError(stored.errorCode ?? "POSTER_CACHE_FAILED");
    }
    return { bytes, contentType };
  }
}

function cacheKeyInput(reference: PosterReference): Record<string, unknown> {
  return {
    headers: { ...reference.headers },
    url: reference.url,
  };
}

export function parsePosterReference(value: string): PosterReference | null {
  const raw = value.trim();
  if (!raw) return null;
  const marker = raw.indexOf("@");
  const address = marker >= 0 ? raw.slice(0, marker) : raw;
  const suffix = marker >= 0 ? raw.slice(marker + 1) : "";
  const normalizedAddress = address.startsWith("//") ? `https:${address}` : address;
  let url: URL;
  try {
    url = new URL(normalizedAddress);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;

  const headers: Record<string, string> = {};
  for (const part of suffix.split("@")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = decodePart(part.slice(0, separator)).toLowerCase();
    const header = ALLOWED_HEADERS[name];
    const item = decodePart(part.slice(separator + 1));
    if (header && item && !/[\r\n]/.test(item)) headers[header] = item;
  }
  return { url: url.toString(), headers };
}

function stableReference(reference: PosterReference): string {
  return JSON.stringify({
    headers: Object.fromEntries(Object.entries(reference.headers).sort(([left], [right]) => left.localeCompare(right))),
    url: reference.url,
  });
}

function detectImage(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && bytes.subarray(8, 12).toString("ascii") === "avif") return "image/avif";
  return null;
}

function normalizeMime(value: string | null): string | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime || null;
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactSensitiveSuffix(value: string): string {
  return value.replace(/@(cookie|authorization)=[^@]*/gi, "@$1=<redacted>");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function posterError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "POSTER_LOAD_FAILED";
}

function writeError(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: code });
  response.writeHead(status, {
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
    "x-qx-poster-error": code,
  });
  response.end(body);
}
