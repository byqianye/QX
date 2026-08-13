import type { QxPlayerResult } from "../source/media-source.js";
import {
  PlaybackProxyServer,
  type PlaybackProxySession,
} from "./playback-proxy.js";
import type { PlaybackSource } from "./playback.js";

export type ResolvedMediaType = "hls" | "dash" | "mp4" | "flv" | "web" | "unknown";

export interface MediaProxySession {
  id: string;
  originalUrl: string;
  headers: Record<string, string>;
  createdAt: number;
  sourceKey: string;
  episodeId: string;
  url: string;
  token: string;
  expiresAt: number;
  close(): Promise<void>;
}

export interface ResolvedMedia {
  url: string;
  headers: Record<string, string>;
  mediaType: ResolvedMediaType;
  viaProxy: boolean;
  sourceKey: string;
  originalUrl?: string;
  proxySession?: MediaProxySession;
}

export interface MediaResolveContext {
  playbackSessionId: string;
  sourceKey: string;
  sourceName: string;
  episodeId: string;
}

export interface MediaResolverOptions {
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
}

export class MediaResolverError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "MediaResolverError";
    this.code = code;
  }
}

export class MediaResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly probeTimeoutMs: number;

  public constructor(
    private readonly proxy: PlaybackProxyServer,
    options: MediaResolverOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.probeTimeoutMs = positiveOrDefault(options.probeTimeoutMs, 5_000);
  }

  public async resolve(result: QxPlayerResult, context: MediaResolveContext): Promise<ResolvedMedia> {
    if (result.status === "AUTH_REQUIRED") {
      throw new MediaResolverError("MEDIA_AUTH_REQUIRED", result.message ?? "当前媒体需要认证信息。");
    }
    if (result.parse !== 0 || result.jx === 1) {
      throw new MediaResolverError("MEDIA_PARSE_REQUIRED", "当前结果仍需要 ParseManager 处理。");
    }
    if (!/^https?:\/\//iu.test(result.url)) {
      throw new MediaResolverError("MEDIA_URL_INVALID", "媒体地址必须使用 HTTP 或 HTTPS。");
    }

    const mediaType = await detectMediaType(result.url, result.headers, result.format, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.probeTimeoutMs,
    });
    const proxy = await this.proxy.createSession({
      parse: 0,
      url: result.url,
      headers: result.headers,
      sourceId: context.sourceKey,
      playbackSessionId: context.playbackSessionId,
      episodeId: context.episodeId,
    });
    const session = asMediaProxySession(proxy, context, result.url, result.headers);
    return {
      url: session.url,
      headers: {},
      mediaType,
      viaProxy: true,
      sourceKey: context.sourceKey,
      originalUrl: result.url,
      proxySession: session,
    };
  }
}

export async function detectMediaType(
  url: string,
  headers: Record<string, string>,
  format?: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ResolvedMediaType> {
  const fromFormat = mediaTypeFromHint(format);
  if (fromFormat !== "unknown") return fromFormat;
  const fromUrl = mediaTypeFromUrl(url);
  if (fromUrl !== "unknown") return fromUrl;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveOrDefault(options.timeoutMs, 5_000);
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const probe = await fetchProbe(fetchImpl, url, headers, method, timeoutMs);
      const fromContentType = mediaTypeFromContentType(probe.response.headers.get("content-type"));
      if (fromContentType !== "unknown") {
        await probe.response.body?.cancel();
        return fromContentType;
      }
      if (method === "GET") {
        const feature = await readFeature(probe.response);
        if (feature !== "") {
          const fromFeature = mediaTypeFromFeature(feature);
          if (fromFeature !== "unknown") return fromFeature;
          if (/<(?:html|!doctype\s+html)\b/iu.test(feature)) return "web";
        }
      }
    } catch {
      // Media type detection is advisory. The proxy remains authoritative and
      // will surface the real upstream error when playback starts.
    }
  }
  return "unknown";
}

export function mediaTypeFromUrl(url: string): ResolvedMediaType {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith(".mpd")) return "dash";
    if (/\.(?:mp4|m4v|mov|webm)$/iu.test(pathname)) return "mp4";
    if (pathname.endsWith(".flv")) return "flv";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function asMediaProxySession(
  proxy: PlaybackProxySession,
  context: MediaResolveContext,
  originalUrl: string,
  headers: Record<string, string>,
): MediaProxySession {
  return {
    id: proxy.id ?? context.playbackSessionId,
    originalUrl,
    headers: { ...headers },
    createdAt: proxy.createdAt ?? Date.now(),
    sourceKey: proxy.sourceKey ?? context.sourceKey,
    episodeId: context.episodeId,
    url: proxy.url,
    token: proxy.token,
    expiresAt: proxy.expiresAt,
    close: proxy.close,
  };
}

async function fetchProbe(
  fetchImpl: typeof fetch,
  url: string,
  inputHeaders: Record<string, string>,
  method: "HEAD" | "GET",
  timeoutMs: number,
): Promise<{ response: Response; url: string }> {
  let current = new URL(url);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(inputHeaders);
      if (method === "GET") headers.set("range", "bytes=0-1023");
      const response = await fetchImpl(current, {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, url: current.toString() };
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("MEDIA_PROBE_REDIRECT_INVALID");
      const next = new URL(location, current);
      if (next.origin !== current.origin) throw new Error("MEDIA_PROBE_REDIRECT_ORIGIN_CHANGED");
      current = next;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("MEDIA_PROBE_REDIRECT_LOOP");
}

async function readFeature(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    return first.value ? new TextDecoder().decode(first.value.slice(0, 4096)) : "";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function mediaTypeFromHint(value?: string): ResolvedMediaType {
  const hint = value?.toLowerCase() ?? "";
  if (hint.includes("hls") || hint.includes("m3u8")) return "hls";
  if (hint.includes("dash") || hint.includes("mpd")) return "dash";
  if (hint.includes("mp4")) return "mp4";
  if (hint.includes("flv")) return "flv";
  return "unknown";
}

function mediaTypeFromContentType(value: string | null): ResolvedMediaType {
  const contentType = value?.toLowerCase() ?? "";
  if (contentType.includes("mpegurl") || contentType.includes("m3u")) return "hls";
  if (contentType.includes("dash+xml")) return "dash";
  if (contentType.includes("mp4") || contentType.includes("quicktime") || contentType.includes("webm")) return "mp4";
  if (contentType.includes("x-flv")) return "flv";
  if (contentType.includes("text/html")) return "web";
  return "unknown";
}

function mediaTypeFromFeature(value: string): ResolvedMediaType {
  if (/^\s*#EXTM3U/iu.test(value)) return "hls";
  if (/<MPD\b/iu.test(value)) return "dash";
  return "unknown";
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
