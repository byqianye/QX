import { randomUUID } from "node:crypto";

export type SnifferViolationKind =
  | "origin"
  | "protocol"
  | "popup"
  | "download"
  | "local-file"
  | "navigation";

export interface SnifferViolation {
  kind: SnifferViolationKind;
  url?: string;
  message?: string;
}

export interface SnifferPolicy {
  partition: string;
  allowedOrigins: readonly string[];
  maxRedirects: number;
  maxPages: number;
  maxResources: number;
  maxTotalMs: number;
  maxIdleMs: number;
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  webSecurity: true;
  allowDownloads: false;
  allowPopups: false;
}

export interface IsolatedSnifferRequest {
  sourceId: string;
  playbackSessionId?: string;
  initialUrl: string;
  headers?: Readonly<Record<string, string>>;
  allowedOrigins?: readonly string[];
  maxRedirects?: number;
  maxPages?: number;
  maxResources?: number;
  maxTotalMs?: number;
  maxIdleMs?: number;
  signal?: AbortSignal;
}

export interface SnifferRequestEvent {
  requestId: string;
  url: string;
  method?: string;
  resourceType?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  pageUrl?: string;
  isMainFrame?: boolean;
}

export interface SnifferResponseEvent extends SnifferRequestEvent {
  statusCode?: number;
  responseHeaders?: Readonly<Record<string, string | readonly string[]>>;
  contentType?: string;
  contentLength?: number;
  durationMs?: number;
  isMasterPlaylist?: boolean;
  explicitPlayerRequest?: boolean;
  accessible?: boolean;
}

export interface SnifferNavigationEvent {
  url: string;
  isMainFrame?: boolean;
}

export interface IsolatedSnifferSession {
  load(url: string, headers?: Readonly<Record<string, string>>): Promise<void>;
  onRequest(listener: (event: SnifferRequestEvent) => void): () => void;
  onResponse(listener: (event: SnifferResponseEvent) => void): () => void;
  onNavigate(listener: (event: SnifferNavigationEvent) => void): () => void;
  onViolation(listener: (event: SnifferViolation) => void): () => void;
  close(): Promise<void>;
}

export interface IsolatedSnifferPlatform {
  createSession(policy: SnifferPolicy): Promise<IsolatedSnifferSession>;
}

export interface SnifferCandidateEvaluation {
  accepted: boolean;
  score: number;
  kind: "playlist" | "video" | "audio" | "segment" | "unknown";
  contentType: string;
  extension: string;
  reason?: string;
}

export interface SnifferDiagnostics {
  redacted: true;
  sourceId: string;
  playbackSessionId: string | null;
  candidateCount: number;
  rejectedCount: number;
  selectedScore: number;
  selectedKind: SnifferCandidateEvaluation["kind"];
  selectedContentType: string;
  selectedExtension: string;
  elapsedMs: number;
  headerNames: readonly string[];
}

export interface SniffedMedia {
  parse: 0;
  url: string;
  headers: Record<string, string>;
  score: number;
  contentType: string;
  diagnostics: SnifferDiagnostics;
}

export class IsolatedSnifferError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "IsolatedSnifferError";
    this.code = code;
  }
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_RESOURCES = 96;
const DEFAULT_MAX_TOTAL_MS = 15_000;
const DEFAULT_MAX_IDLE_MS = 2_500;
const MAX_PARTITION_LENGTH = 120;
const MEDIA_SCORE_THRESHOLD = 60;
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "origin",
  "range",
  "referer",
  "user-agent",
]);
const DISALLOWED_MIME_PREFIXES = [
  "image/",
  "font/",
  "text/css",
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/json",
];
const DISALLOWED_EXTENSIONS = new Set([
  "avif",
  "css",
  "gif",
  "html",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "json",
  "png",
  "svg",
  "webp",
]);
const PLAYLIST_EXTENSIONS = new Set(["m3u", "m3u8"]);
const VIDEO_EXTENSIONS = new Set(["f4v", "flv", "m4v", "mkv", "mov", "mp4", "webm"]);
const AUDIO_EXTENSIONS = new Set(["aac", "m4a", "mp3", "ogg", "wav"]);
const SEGMENT_EXTENSIONS = new Set(["m4s", "ts", "vtt"]);

export function evaluateSnifferCandidate(
  candidate: SnifferResponseEvent,
  allowedOrigins: ReadonlySet<string>,
): SnifferCandidateEvaluation {
  const url = parseHttpUrl(candidate.url);
  if (!url) return rejected("unknown", "", "protocol blocked");
  if (!allowedOrigins.has(url.origin)) return rejected("unknown", "", "origin blocked");
  if (candidate.accessible === false) return rejected("unknown", "", "resource inaccessible");

  const contentType = headerValue(candidate.responseHeaders, "content-type")
    ?? candidate.contentType
    ?? "";
  const normalizedType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = mediaExtension(url.pathname);
  const resourceType = candidate.resourceType?.toLowerCase() ?? "";
  if (DISALLOWED_MIME_PREFIXES.some((prefix) => normalizedType.startsWith(prefix))) {
    return rejected("unknown", normalizedType, "non-media MIME type");
  }
  if (DISALLOWED_EXTENSIONS.has(extension) && !candidate.explicitPlayerRequest) {
    return rejected("unknown", normalizedType, "non-media extension");
  }
  const statusCode = candidate.statusCode ?? 200;
  if (statusCode < 200 || statusCode >= 300) {
    return rejected("unknown", normalizedType, "non-success status");
  }

  const mimeKind = mediaKindForMime(normalizedType);
  const extensionKind = mediaKindForExtension(extension);
  const explicitMediaRequest = candidate.explicitPlayerRequest === true
    || resourceType === "media"
    || resourceType === "video"
    || resourceType === "audio";
  const kind = mimeKind !== "unknown"
    ? mimeKind
    : extensionKind !== "unknown"
      ? extensionKind
      : explicitMediaRequest ? "segment" : "unknown";
  if (kind === "unknown" && !explicitMediaRequest) {
    return rejected(kind, normalizedType, "no media signal");
  }
  if (resourceType === "image" || resourceType === "stylesheet" || resourceType === "script") {
    return rejected("unknown", normalizedType, "non-media resource type");
  }

  let score = 0;
  if (kind === "playlist") score += 58;
  else if (kind === "video") score += 50;
  else if (kind === "audio") score += 48;
  else if (kind === "segment") score += 36;
  if (mimeKind !== "unknown") score += 12;
  if (extensionKind !== "unknown") score += 22;
  if (explicitMediaRequest) score += 14;
  if (statusCode >= 200 && statusCode < 300) score += 10;
  if ((candidate.contentLength ?? contentLength(candidate.responseHeaders)) !== undefined) score += 4;
  if (candidate.pageUrl && parseHttpUrl(candidate.pageUrl)?.origin === url.origin) score += 5;
  if (candidate.isMasterPlaylist === true) score += 8;
  if (candidate.durationMs !== undefined && candidate.durationMs >= 0 && candidate.durationMs < 5_000) score += 2;

  return {
    accepted: true,
    score,
    kind,
    contentType: normalizedType,
    extension,
  };
}

export function sanitizeSnifferHeaders(
  ...sources: Array<Readonly<Record<string, string>> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const normalizedName = name.trim().toLowerCase();
      if (!SAFE_REQUEST_HEADERS.has(normalizedName)) continue;
      if (typeof value !== "string" || value.length > 4096) continue;
      if (/[\r\n]/.test(value)) continue;
      result[name.trim()] = value;
    }
  }
  return result;
}

export class IsolatedSniffer {
  private readonly activeRuns = new Set<ActiveSnifferRun>();
  private closed = false;

  public constructor(private readonly platform: IsolatedSnifferPlatform) {}

  public get activeSessionCount(): number {
    return this.activeRuns.size;
  }

  public async sniff(request: IsolatedSnifferRequest): Promise<SniffedMedia> {
    if (this.closed) throw new IsolatedSnifferError("SNIFF_CLOSED", "隔离嗅探器已经关闭");
    const initialUrl = parseHttpUrl(request.initialUrl);
    if (!initialUrl) {
      throw new IsolatedSnifferError("SNIFF_INVALID_URL", "隔离嗅探只接受 HTTP(S) 初始地址");
    }
    if (request.signal?.aborted) {
      throw new IsolatedSnifferError("SNIFF_CANCELLED", "隔离嗅探已取消");
    }

    const allowedOrigins = new Set<string>([
      initialUrl.origin,
      ...(request.allowedOrigins ?? []).map(normalizeOrigin).filter((origin): origin is string => origin !== null),
    ]);
    const policy = createSnifferPolicy(request, allowedOrigins);
    const controller = new AbortController();
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const run: ActiveSnifferRun = {
      controller,
      cancel: () => controller.abort(),
      completion,
    };
    if (resolveCompletion) runCompletionResolvers.set(run, resolveCompletion);
    this.activeRuns.add(run);
    const onParentAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onParentAbort, { once: true });
    const startedAt = Date.now();
    let session: IsolatedSnifferSession | undefined;
    let removeRequest: (() => void) | undefined;
    let removeResponse: (() => void) | undefined;
    let removeNavigate: (() => void) | undefined;
    let removeViolation: (() => void) | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let candidateCount = 0;
    let rejectedCount = 0;
    let pageCount = 1;
    let redirectCount = 0;
    let lastPageUrl = initialUrl.toString();

    const fail = (code: string, message: string): never => {
      throw new IsolatedSnifferError(code, message);
    };

    try {
      session = await this.platform.createSession(policy);
      if (controller.signal.aborted || this.closed) fail("SNIFF_CANCELLED", "隔离嗅探已取消");

      const result = await new Promise<SniffedMedia>((resolve, reject) => {
        let settled = false;
        let best: { event: SnifferResponseEvent; evaluation: SnifferCandidateEvaluation } | undefined;
        const finish = (error?: Error, value?: SniffedMedia) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else if (value) resolve(value);
          else reject(new IsolatedSnifferError("SNIFF_NO_MEDIA", "隔离页面没有发现可播放媒体"));
        };
        run.cancel = () => {
          controller.abort();
          finish(new IsolatedSnifferError("SNIFF_CANCELLED", "隔离嗅探已取消"));
        };
        const resetIdleTimer = () => {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            finish(new IsolatedSnifferError("SNIFF_TIMEOUT", "隔离嗅探在空闲窗口内没有发现媒体"));
          }, policy.maxIdleMs);
        };
        const checkUrl = (value: string): URL => {
          const parsed = parseHttpUrl(value);
          if (!parsed) {
            finish(new IsolatedSnifferError("SNIFF_PROTOCOL_BLOCKED", "隔离嗅探拒绝非 HTTP(S) 地址"));
            throw new Error("blocked protocol");
          }
          if (!allowedOrigins.has(parsed.origin)) {
            finish(new IsolatedSnifferError("SNIFF_ORIGIN_BLOCKED", "隔离嗅探拒绝不在 allowlist 内的地址"));
            throw new Error("blocked origin");
          }
          return parsed;
        };

        removeRequest = session?.onRequest((event) => {
          if (settled) return;
          resetIdleTimer();
          candidateCount += 1;
          if (candidateCount > policy.maxResources) {
            finish(new IsolatedSnifferError("SNIFF_RESOURCE_LIMIT", "隔离嗅探超过资源数量上限"));
            return;
          }
          try {
            checkUrl(event.url);
          } catch {
            // The policy error has already settled the run.
          }
        });
        removeResponse = session?.onResponse((event) => {
          if (settled) return;
          resetIdleTimer();
          try {
            checkUrl(event.url);
          } catch {
            return;
          }
          const evaluation = evaluateSnifferCandidate(event, allowedOrigins);
          if (!evaluation.accepted) {
            rejectedCount += 1;
            return;
          }
          if (!best || evaluation.score > best.evaluation.score) {
            best = { event, evaluation };
          }
          if (evaluation.score < MEDIA_SCORE_THRESHOLD || !best) return;
          const selected = best;
          const headers = sanitizeSnifferHeaders(selected.event.requestHeaders, request.headers);
          finish(undefined, {
            parse: 0,
            url: selected.event.url,
            headers,
            score: selected.evaluation.score,
            contentType: selected.evaluation.contentType,
            diagnostics: {
              redacted: true,
              sourceId: request.sourceId,
              playbackSessionId: request.playbackSessionId ?? null,
              candidateCount,
              rejectedCount,
              selectedScore: selected.evaluation.score,
              selectedKind: selected.evaluation.kind,
              selectedContentType: selected.evaluation.contentType,
              selectedExtension: selected.evaluation.extension,
              elapsedMs: Date.now() - startedAt,
              headerNames: Object.keys(headers).map((name) => name.toLowerCase()).sort(),
            },
          });
        });
        removeNavigate = session?.onNavigate((event) => {
          if (settled || event.isMainFrame === false) return;
          resetIdleTimer();
          let url: URL;
          try {
            url = checkUrl(event.url);
          } catch {
            return;
          }
          const nextUrl = url.toString();
          if (nextUrl === lastPageUrl) return;
          lastPageUrl = nextUrl;
          pageCount += 1;
          redirectCount += 1;
          if (redirectCount > policy.maxRedirects) {
            finish(new IsolatedSnifferError("SNIFF_REDIRECT_LIMIT", "隔离嗅探超过重定向上限"));
          } else if (pageCount > policy.maxPages) {
            finish(new IsolatedSnifferError("SNIFF_PAGE_LIMIT", "隔离嗅探超过页面数量上限"));
          }
        });
        removeViolation = session?.onViolation((event) => {
          if (settled) return;
          const code = event.kind === "origin" || event.kind === "navigation"
            ? "SNIFF_ORIGIN_BLOCKED"
            : event.kind === "protocol" || event.kind === "local-file"
              ? "SNIFF_PROTOCOL_BLOCKED"
              : "SNIFF_POLICY_BLOCKED";
          finish(new IsolatedSnifferError(code, event.message ?? "隔离嗅探阻止了不安全的页面行为"));
        });
        const onAbort = () => finish(new IsolatedSnifferError("SNIFF_CANCELLED", "隔离嗅探已取消"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        totalTimer = setTimeout(() => {
          finish(new IsolatedSnifferError("SNIFF_TIMEOUT", "隔离嗅探超过总时限"));
        }, policy.maxTotalMs);
        resetIdleTimer();

        void session?.load(initialUrl.toString(), sanitizeSnifferHeaders(request.headers)).catch((error: unknown) => {
          if (!settled) finish(new IsolatedSnifferError("SNIFF_LOAD_ERROR", errorMessage(error)));
        });
      });
      return result;
    } finally {
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      removeRequest?.();
      removeResponse?.();
      removeNavigate?.();
      removeViolation?.();
      request.signal?.removeEventListener("abort", onParentAbort);
      try {
        await session?.close();
      } finally {
        this.activeRuns.delete(run);
        runCompletionResolvers.get(run)?.();
        runCompletionResolvers.delete(run);
      }
    }
  }

  public cancelAll(): void {
    for (const run of this.activeRuns) run.cancel();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.activeRuns].map((run) => run.completion);
    this.cancelAll();
    await Promise.all(pending);
  }
}

export function createSnifferPolicy(
  request: IsolatedSnifferRequest,
  allowedOrigins: ReadonlySet<string>,
): SnifferPolicy {
  const partition = `temp:qx-sniffer-${randomUUID()}`.slice(0, MAX_PARTITION_LENGTH);
  return {
    partition,
    allowedOrigins: [...allowedOrigins].sort(),
    maxRedirects: positiveLimit(request.maxRedirects, DEFAULT_MAX_REDIRECTS),
    maxPages: positiveLimit(request.maxPages, DEFAULT_MAX_PAGES),
    maxResources: positiveLimit(request.maxResources, DEFAULT_MAX_RESOURCES),
    maxTotalMs: positiveLimit(request.maxTotalMs, DEFAULT_MAX_TOTAL_MS),
    maxIdleMs: positiveLimit(request.maxIdleMs, DEFAULT_MAX_IDLE_MS),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowDownloads: false,
    allowPopups: false,
  };
}

function mediaKindForMime(value: string): SnifferCandidateEvaluation["kind"] {
  if (value.includes("mpegurl") || value.includes("m3u8")) return "playlist";
  if (value.startsWith("video/") || value.includes("mp4") || value.includes("webm")) return "video";
  if (value.startsWith("audio/") || value.includes("mpeg") || value.includes("aac")) return "audio";
  return "unknown";
}

function mediaKindForExtension(extension: string): SnifferCandidateEvaluation["kind"] {
  if (PLAYLIST_EXTENSIONS.has(extension)) return "playlist";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (SEGMENT_EXTENSIONS.has(extension)) return "segment";
  return "unknown";
}

function mediaExtension(pathname: string): string {
  const match = pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function rejected(
  kind: SnifferCandidateEvaluation["kind"],
  contentType: string,
  reason: string,
): SnifferCandidateEvaluation {
  return {
    accepted: false,
    score: 0,
    kind,
    contentType,
    extension: "",
    reason,
  };
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string | null {
  const url = parseHttpUrl(value);
  return url?.origin ?? null;
}

function headerValue(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
  return typeof entry === "string" ? entry : entry?.[0];
}

function contentLength(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
): number | undefined {
  const value = headerValue(headers, "content-length");
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 60_000)
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ActiveSnifferRun {
  controller: AbortController;
  cancel: () => void;
  completion: Promise<void>;
}

const runCompletionResolvers = new Map<ActiveSnifferRun, () => void>();
