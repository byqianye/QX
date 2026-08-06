export type ParserType = "direct" | "json" | "redirect" | "html-declared" | "source-provided" | "fixture";

export interface ParserCandidate {
  id: string;
  name: string;
  type: ParserType;
  endpoint?: string;
  headers?: Readonly<Record<string, string>>;
  enabled: boolean;
  priority: number;
  timeout: number;
}

export interface ParseRequest {
  sourceId: string;
  flag: string;
  originalUrl: string;
  parserCandidates: readonly ParserCandidate[];
  headers: Readonly<Record<string, string>>;
  timeout: number;
  playbackSessionId: string;
  parse?: number;
  allowedOrigins?: readonly string[];
  maxAttempts?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: ParseAttempt) => void;
}

export type ParseAttemptStatus = "timeout" | "error" | "succeeded";

export interface ParseAttempt {
  parserId: string;
  parserType: ParserType;
  status: ParseAttemptStatus;
  elapsedMs: number;
  code?: string;
  message?: string;
}

export interface ParseDiagnostics {
  redacted: true;
  sourceId: string;
  playbackSessionId: string;
  parserIds: readonly string[];
  headerNames: readonly string[];
}

export interface ParseResult {
  parse: 0;
  url: string;
  headers: Record<string, string>;
  parserId: string;
  elapsedMs: number;
  attempts: readonly ParseAttempt[];
  diagnostics: ParseDiagnostics;
}

export type ParseUiStatus = "idle" | "resolving" | "attempting" | "failed" | "succeeded" | "cancelled";

export interface ParseUiState {
  status: ParseUiStatus;
  parserId: string | null;
  attempts: readonly ParseAttempt[];
  error: { code: string; message: string } | null;
}

export interface SourceProvidedResult {
  parse?: number;
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export interface ParseChainOptions {
  fetchImpl?: typeof fetch;
  allowedOrigins?: readonly string[];
  maxResponseBytes?: number;
  maxRedirects?: number;
  maxAttempts?: number;
  maxDepth?: number;
  sourceProvided?: (
    candidate: ParserCandidate,
    request: ParseRequest,
  ) => Promise<SourceProvidedResult>;
}

export class ParseChainError extends Error {
  public readonly code: string;
  public readonly attempts: readonly ParseAttempt[];
  public readonly diagnostics: ParseDiagnostics | null;

  public constructor(
    code: string,
    message: string,
    details: { attempts?: readonly ParseAttempt[]; diagnostics?: ParseDiagnostics } = {},
  ) {
    super(message);
    this.name = "ParseChainError";
    this.code = code;
    this.attempts = details.attempts ?? [];
    this.diagnostics = details.diagnostics ?? null;
  }
}

interface CandidateValue {
  parse: number;
  url: string;
  headers: Record<string, string>;
}

interface FetchResult {
  response: Response;
  url: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_DEPTH = 3;

export class ParseChainResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultAllowedOrigins: ReadonlySet<string>;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultMaxDepth: number;
  private readonly sourceProvided: ParseChainOptions["sourceProvided"];
  private readonly activeControllers = new Set<AbortController>();
  private closed = false;

  public constructor(options: ParseChainOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultAllowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
    this.maxResponseBytes = positiveOrDefault(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.maxRedirects = positiveOrDefault(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
    this.defaultMaxAttempts = positiveOrDefault(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.defaultMaxDepth = positiveOrDefault(options.maxDepth, DEFAULT_MAX_DEPTH);
    this.sourceProvided = options.sourceProvided;
  }

  public get activeRequestCount(): number {
    return this.activeControllers.size;
  }

  public async resolve(request: ParseRequest): Promise<ParseResult> {
    this.assertOpen();
    const original = ensureHttpUrl(request.originalUrl, "PARSE_INVALID_URL");
    if (request.parse === 0) {
      return {
        parse: 0,
        url: original.toString(),
        headers: cloneHeaders(request.headers),
        parserId: "direct",
        elapsedMs: 0,
        attempts: [],
        diagnostics: diagnosticsFor(request, []),
      };
    }
    const candidates = request.parserCandidates
      .filter((candidate) => candidate.enabled)
      .slice()
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    if (candidates.length === 0) {
      throw new ParseChainError("PARSE_UNAVAILABLE", "parse=1 没有可用的解析器。" );
    }

    const allowedOrigins = this.allowedOrigins(original, request, candidates);
    const attempts: ParseAttempt[] = [];
    const startedAt = Date.now();
    let result: ParseResult;
    try {
      result = await this.resolveInternal(
        request,
        original.toString(),
        candidates,
        allowedOrigins,
        new Set([original.toString()]),
        0,
        attempts,
      );
    } catch (error) {
      const parseError = toParseError(error);
      throw new ParseChainError(
        parseError.code,
        safeAttemptMessage(parseError.message),
        { attempts: attempts.map((attempt) => ({ ...attempt })), diagnostics: diagnosticsFor(request, candidates) },
      );
    }
    return {
      ...result,
      elapsedMs: Date.now() - startedAt,
      attempts: attempts.map((attempt) => ({ ...attempt })),
      diagnostics: diagnosticsFor(request, candidates),
    };
  }

  public close(): void {
    this.closed = true;
    for (const controller of this.activeControllers) controller.abort();
  }

  private async resolveInternal(
    request: ParseRequest,
    currentUrl: string,
    candidates: readonly ParserCandidate[],
    allowedOrigins: ReadonlySet<string>,
    visited: ReadonlySet<string>,
    depth: number,
    attempts: ParseAttempt[],
  ): Promise<ParseResult> {
    const maxAttempts = positiveOrDefault(request.maxAttempts, this.defaultMaxAttempts);
    const maxDepth = positiveOrDefault(request.maxDepth, this.defaultMaxDepth);
    let lastError: ParseChainError | undefined;
    for (const candidate of candidates) {
      if (attempts.length >= maxAttempts) break;
      this.assertNotCancelled(request.signal);
      const startedAt = Date.now();
      try {
        const value = await this.resolveCandidate(
          candidate,
          request,
          currentUrl,
          allowedOrigins,
        );
        const target = ensureHttpUrl(value.url, "PARSE_INVALID_RESULT_URL");
        assertAllowedOrigin(target, allowedOrigins);
        const normalizedTarget = target.toString();
        if (visited.has(normalizedTarget)) {
          throw new ParseChainError("PARSE_CYCLE_DETECTED", "解析器返回了循环 URL。" );
        }
        const attempt: ParseAttempt = {
          parserId: candidate.id,
          parserType: candidate.type,
          status: "succeeded",
          elapsedMs: Date.now() - startedAt,
        };
        attempts.push(attempt);
        request.onAttempt?.({ ...attempt });
        if (value.parse === 1) {
          if (depth >= maxDepth) {
            throw new ParseChainError("PARSE_MAX_DEPTH", "解析递归深度超过限制。" );
          }
          const nested = await this.resolveInternal(
            request,
            normalizedTarget,
            candidates,
            allowedOrigins,
            new Set([...visited, normalizedTarget]),
            depth + 1,
            attempts,
          );
          return nested;
        }
        return {
          parse: 0,
          url: normalizedTarget,
          headers: value.headers,
          parserId: candidate.id,
          elapsedMs: 0,
          attempts: [],
          diagnostics: diagnosticsFor(request, candidates),
        };
      } catch (error) {
        const parseError = toParseError(error);
        if (parseError.code === "PARSE_CANCELLED") throw parseError;
        lastError = parseError;
        const attempt = {
          parserId: candidate.id,
          parserType: candidate.type,
          status: parseError.code === "PARSE_TIMEOUT" ? "timeout" : "error",
          elapsedMs: Date.now() - startedAt,
          code: parseError.code,
          message: safeAttemptMessage(parseError.message),
        } satisfies ParseAttempt;
        attempts.push(attempt);
        request.onAttempt?.({ ...attempt });
      }
    }
    if (attempts.length >= maxAttempts && !lastError) {
      throw new ParseChainError("PARSE_MAX_ATTEMPTS", "解析器尝试次数超过限制。" );
    }
    throw lastError ?? new ParseChainError("PARSE_UNAVAILABLE", "解析器没有返回可播放地址。" );
  }

  private async resolveCandidate(
    candidate: ParserCandidate,
    request: ParseRequest,
    currentUrl: string,
    allowedOrigins: ReadonlySet<string>,
  ): Promise<CandidateValue> {
    if (candidate.type === "direct") {
      return {
        parse: 0,
        url: candidate.endpoint ?? currentUrl,
        headers: mergeHeaders(request.headers, candidate.headers),
      };
    }
    if (candidate.type === "source-provided") {
      if (!this.sourceProvided) throw new ParseChainError("PARSE_SOURCE_UNAVAILABLE", "Source-provided parser 未提供实现。" );
      const value = await this.resolveSourceProvided(candidate, request);
      return {
        parse: value.parse ?? 0,
        url: value.url,
        headers: mergeHeaders(request.headers, mergeHeaders(candidate.headers, value.headers)),
      };
    }

    const endpoint = ensureHttpUrl(candidate.endpoint ?? currentUrl, "PARSE_PROTOCOL_BLOCKED");
    assertAllowedOrigin(endpoint, allowedOrigins);
    const fetched = await this.fetchWithRedirects(
      endpoint.toString(),
      mergeHeaders(request.headers, candidate.headers),
      minPositive(candidate.timeout, request.timeout),
      request.signal,
      allowedOrigins,
    );
    if (!fetched.response.ok) {
      throw new ParseChainError("PARSE_HTTP_ERROR", `解析器 HTTP 状态 ${fetched.response.status}。` );
    }
    if (candidate.type === "redirect") {
      return {
        parse: 0,
        url: fetched.url,
        headers: mergeHeaders(request.headers, candidate.headers),
      };
    }
    const body = await readBoundedText(fetched.response, this.maxResponseBytes);
    if (candidate.type === "html-declared") return parseHtmlDeclared(body, request, candidate);
    if (candidate.type === "json" || candidate.type === "fixture") return parseJsonResult(body, request, candidate);
    throw new ParseChainError("PARSE_UNSUPPORTED_TYPE", `不支持的解析器类型：${candidate.type}` );
  }

  private async resolveSourceProvided(
    candidate: ParserCandidate,
    request: ParseRequest,
  ): Promise<SourceProvidedResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    this.activeControllers.add(controller);
    let timedOut = false;
    const timeoutMs = minPositive(candidate.timeout, request.timeout);
    const operation = Promise.resolve().then(() => this.sourceProvided!(candidate, {
      ...request,
      signal: controller.signal,
    }));
    operation.catch(() => undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ParseChainError("PARSE_TIMEOUT", "解析器请求超时。"));
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        if (!timedOut) reject(new ParseChainError("PARSE_CANCELLED", "解析已取消。"));
      }, { once: true });
    });
    try {
      return await Promise.race([operation, timeout, cancelled]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      request.signal?.removeEventListener("abort", onAbort);
      this.activeControllers.delete(controller);
    }
  }

  private async fetchWithRedirects(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    parentSignal: AbortSignal | undefined,
    allowedOrigins: ReadonlySet<string>,
  ): Promise<FetchResult> {
    let current = url;
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const response = await this.fetchWithTimeout(current, headers, timeoutMs, parentSignal);
      if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };
      if (redirect === this.maxRedirects) throw new ParseChainError("PARSE_REDIRECT_LIMIT", "解析器重定向次数超过限制。" );
      const location = response.headers.get("location");
      if (!location) throw new ParseChainError("PARSE_REDIRECT_INVALID", "解析器重定向缺少 Location。" );
      const next = ensureHttpUrl(new URL(location, current).toString(), "PARSE_PROTOCOL_BLOCKED");
      assertAllowedOrigin(next, allowedOrigins);
      current = next.toString();
    }
    throw new ParseChainError("PARSE_REDIRECT_LIMIT", "解析器重定向次数超过限制。" );
  }

  private async fetchWithTimeout(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    parentSignal: AbortSignal | undefined,
  ): Promise<Response> {
    this.assertNotCancelled(parentSignal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (parentSignal?.aborted || this.closed) throw new ParseChainError("PARSE_CANCELLED", "解析已取消。" );
      if (controller.signal.aborted) throw new ParseChainError("PARSE_TIMEOUT", "解析器请求超时。" );
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
      this.activeControllers.delete(controller);
    }
  }

  private allowedOrigins(
    original: URL,
    request: ParseRequest,
    candidates: readonly ParserCandidate[],
  ): ReadonlySet<string> {
    const origins = new Set<string>([original.origin, ...this.defaultAllowedOrigins]);
    for (const origin of request.allowedOrigins ?? []) origins.add(normalizeOrigin(origin));
    for (const candidate of candidates) {
      if (!candidate.endpoint) continue;
      try {
        origins.add(new URL(candidate.endpoint).origin);
      } catch {
        // The candidate is rejected when it is used.
      }
    }
    return origins;
  }

  private assertOpen(): void {
    if (this.closed) throw new ParseChainError("PARSE_RESOLVER_CLOSED", "解析器已关闭。" );
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    this.assertOpen();
    if (signal?.aborted) throw new ParseChainError("PARSE_CANCELLED", "解析已取消。" );
  }
}

function parseJsonResult(body: string, request: ParseRequest, candidate: ParserCandidate): CandidateValue {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ParseChainError("PARSE_JSON_INVALID", "解析器返回的 JSON 无效。" );
  }
  if (typeof value === "string") {
    return { parse: 0, url: value, headers: mergeHeaders(request.headers, candidate.headers) };
  }
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new ParseChainError("PARSE_MEDIA_NOT_FOUND", "解析器 JSON 未声明媒体 URL。" );
  }
  const parse = typeof value.parse === "number" ? value.parse : 0;
  return {
    parse,
    url: value.url,
    headers: mergeHeaders(
      request.headers,
      mergeHeaders(candidate.headers, headerRecord(value.headers ?? value.header)),
    ),
  };
}

function parseHtmlDeclared(body: string, request: ParseRequest, candidate: ParserCandidate): CandidateValue {
  const match = /(?:data-media-url|data-src|<source[^>]+src)\s*=\s*["']([^"']+)["']/i.exec(body);
  const url = match?.[1]?.replace(/&amp;/gi, "&");
  if (!url) throw new ParseChainError("PARSE_MEDIA_NOT_FOUND", "HTML 没有明确声明媒体 URL。" );
  return {
    parse: 0,
    url,
    headers: mergeHeaders(request.headers, candidate.headers),
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ParseChainError("PARSE_RESPONSE_TOO_LARGE", "解析器响应超过大小限制。" );
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ParseChainError("PARSE_RESPONSE_TOO_LARGE", "解析器响应超过大小限制。" );
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ParseChainError("PARSE_RESPONSE_TOO_LARGE", "解析器响应超过大小限制。" );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function diagnosticsFor(request: ParseRequest, candidates: readonly ParserCandidate[]): ParseDiagnostics {
  return {
    redacted: true,
    sourceId: safeLabel(request.sourceId),
    playbackSessionId: safeLabel(request.playbackSessionId),
    parserIds: candidates.map((candidate) => candidate.id),
    headerNames: Object.keys(request.headers).map((name) => name.toLowerCase()).sort(),
  };
}

function ensureHttpUrl(value: string, code: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParseChainError(code, "解析地址无效。" );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ParseChainError("PARSE_PROTOCOL_BLOCKED", "解析链只允许 HTTP 或 HTTPS。" );
  }
  return url;
}

function assertAllowedOrigin(value: URL, allowedOrigins: ReadonlySet<string>): void {
  if (!allowedOrigins.has(value.origin)) {
    throw new ParseChainError("PARSE_ORIGIN_BLOCKED", "解析地址不在允许的 origin 范围内。" );
  }
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function mergeHeaders(
  first: Readonly<Record<string, string>> | undefined,
  second: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return { ...(first ?? {}), ...(second ?? {}) };
}

function headerRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function cloneHeaders(value: Readonly<Record<string, string>>): Record<string, string> {
  return { ...value };
}

function safeAttemptMessage(value: string): string {
  return value
    .replace(/(authorization\s*:\s*)(bearer|basic)\s+[^\s]+/gi, "$1$2 [redacted]")
    .replace(/((?:cookie|set-cookie)\s*:\s*)(.*?)(?=\s+(?:authorization|cookie|set-cookie)\s*:|$)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]");
}

function safeLabel(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function toParseError(error: unknown): ParseChainError {
  if (error instanceof ParseChainError) return error;
  return new ParseChainError("PARSE_ERROR", error instanceof Error ? error.message : String(error));
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function minPositive(left: number, right: number): number {
  return Math.max(1, Math.min(positiveOrDefault(left, right), positiveOrDefault(right, left)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
