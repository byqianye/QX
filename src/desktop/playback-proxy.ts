import { createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";
import {
  PlaybackRuleError,
  PlaybackRuleEngine,
  type PlaybackRule,
} from "./playback-rules.js";

export interface PlaybackProxySource {
  parse: number;
  url: string;
  headers: Record<string, string>;
  sourceId?: string;
  playbackSessionId?: string;
  episodeId?: string;
}

export interface PlaybackProxyServerOptions {
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  allowedUpstreamHeaders?: readonly string[];
  sessionTtlMs?: number;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  totalRequestTimeoutMs?: number;
  maxPlaylistBytes?: number;
  maxErrorBytes?: number;
  maxMediaBytes?: number;
  maxConcurrentRequests?: number;
  now?: () => number;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  fetchImpl?: typeof fetch;
  rules?: readonly PlaybackRule[];
}

export interface PlaybackProxySession {
  readonly id?: string;
  readonly originalUrl?: string;
  readonly headers?: Record<string, string>;
  readonly createdAt?: number;
  readonly sourceKey?: string;
  readonly episodeId?: string;
  readonly url: string;
  readonly token: string;
  readonly expiresAt: number;
  close(): Promise<void>;
}

export class PlaybackProxyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PlaybackProxyError";
    this.code = code;
  }
}

interface ProxySessionState {
  token: string;
  origin: string;
  origins: Set<string>;
  headers: Record<string, string>;
  createdAt: number;
  expiresAt: number;
  resources: Map<string, string>;
  resourceIds: Map<string, string>;
  activeControllers: Set<AbortController>;
  activeRequests: number;
  revoked: boolean;
  sourceId: string;
  playbackSessionId: string;
  segmentCrypto: Map<string, SegmentCrypto>;
}

interface SegmentCrypto {
  keyUrl?: string;
  iv?: Buffer;
  sequence: number;
}

interface UpstreamResponse {
  response: Response;
  url: string;
}

const PROXY_PREFIX = "/__qx_playback/";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
] as const;
const FORBIDDEN_UPSTREAM_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
]);
const DEFAULT_UPSTREAM_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "pragma",
  "x-requested-with",
];
const DEFAULTS = {
  host: "127.0.0.1",
  port: 0,
  sessionTtlMs: 10 * 60_000,
  requestTimeoutMs: 15_000,
  maxPlaylistBytes: 2 * 1024 * 1024,
  maxErrorBytes: 64 * 1024,
  maxMediaBytes: 128 * 1024 * 1024,
  maxConcurrentRequests: 8,
} as const;

export class PlaybackProxyServer {
  private readonly host: string;
  private readonly port: number;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly allowedUpstreamHeaders: ReadonlySet<string>;
  private readonly sessionTtlMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly firstByteTimeoutMs: number;
  private readonly totalRequestTimeoutMs: number;
  private readonly maxPlaylistBytes: number;
  private readonly maxErrorBytes: number;
  private readonly maxMediaBytes: number;
  private readonly maxConcurrentRequests: number;
  private readonly now: () => number;
  private readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  private readonly fetchImpl: typeof fetch;
  private readonly ruleEngine: PlaybackRuleEngine;
  private readonly sessions = new Map<string, ProxySessionState>();
  private server: Server | undefined;
  private boundUrl = "";

  public constructor(options: PlaybackProxyServerOptions = {}) {
    const host = options.host ?? DEFAULTS.host;
    if (host !== DEFAULTS.host) {
      throw new PlaybackProxyError("PLAYBACK_PROXY_BIND_FORBIDDEN", "The playback proxy must bind to 127.0.0.1.");
    }
    this.host = host;
    this.port = options.port ?? DEFAULTS.port;
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
    this.allowedUpstreamHeaders = new Set([
      ...DEFAULT_UPSTREAM_HEADERS,
      ...(options.allowedUpstreamHeaders ?? []),
    ].map((header) => header.toLowerCase()));
    this.sessionTtlMs = positiveOrDefault(options.sessionTtlMs, DEFAULTS.sessionTtlMs);
    this.connectionTimeoutMs = positiveOrDefault(options.connectionTimeoutMs, DEFAULTS.requestTimeoutMs);
    this.firstByteTimeoutMs = positiveOrDefault(options.firstByteTimeoutMs, DEFAULTS.requestTimeoutMs);
    this.totalRequestTimeoutMs = positiveOrDefault(
      options.totalRequestTimeoutMs ?? options.requestTimeoutMs,
      DEFAULTS.requestTimeoutMs,
    );
    this.maxPlaylistBytes = positiveOrDefault(options.maxPlaylistBytes, DEFAULTS.maxPlaylistBytes);
    this.maxErrorBytes = positiveOrDefault(options.maxErrorBytes, DEFAULTS.maxErrorBytes);
    this.maxMediaBytes = positiveOrDefault(options.maxMediaBytes, DEFAULTS.maxMediaBytes);
    this.maxConcurrentRequests = positiveOrDefault(
      options.maxConcurrentRequests,
      DEFAULTS.maxConcurrentRequests,
    );
    this.now = options.now ?? Date.now;
    this.resolveAddresses = options.resolveAddresses ?? resolveHostAddresses;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ruleEngine = new PlaybackRuleEngine(options.rules ?? []);
  }

  public get url(): string {
    if (!this.boundUrl) throw new Error("Playback proxy server is not running");
    return this.boundUrl;
  }

  public get activeSessionCount(): number {
    return [...this.sessions.values()].filter((session) => !session.revoked && this.now() < session.expiresAt).length;
  }

  public async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.host, resolve);
      });
      const address = server.address() as AddressInfo;
      this.boundUrl = `http://${this.host}:${address.port}/`;
    } catch (error) {
      this.server = undefined;
      await closeServer(server);
      throw error;
    }
  }

  public async createSession(source: PlaybackProxySource): Promise<PlaybackProxySession> {
    const playbackSessionId = source.playbackSessionId ?? randomToken(12);
    const normalized = await this.validateSource({ ...source, playbackSessionId });
    await this.start();
    this.removeExpiredSessions();

    const token = randomToken(32);
    const rootResource = randomToken(18);
    const createdAt = this.now();
    const state: ProxySessionState = {
      token,
      origin: normalized.origin,
      origins: new Set([normalized.origin]),
      headers: normalized.headers,
      createdAt,
      expiresAt: createdAt + this.sessionTtlMs,
      resources: new Map([[rootResource, normalized.url]]),
      resourceIds: new Map([[normalized.url, rootResource]]),
      activeControllers: new Set(),
      activeRequests: 0,
      revoked: false,
      sourceId: source.sourceId ?? "",
      playbackSessionId,
      segmentCrypto: new Map(),
    };
    this.sessions.set(token, state);

    let closed = false;
    return {
      id: playbackSessionId,
      originalUrl: normalized.url,
      headers: { ...normalized.headers },
      createdAt,
      sourceKey: source.sourceId ?? "",
      episodeId: source.episodeId ?? "",
      url: this.resourceUrl(token, rootResource, normalized.url),
      token,
      expiresAt: state.expiresAt,
      close: async () => {
        if (closed) return;
        closed = true;
        this.revoke(token);
      },
    };
  }

  public async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) revokeState(session);
    const server = this.server;
    this.server = undefined;
    this.boundUrl = "";
    if (!server) return;
    await closeServer(server);
  }

  private async validateSource(source: PlaybackProxySource): Promise<{ url: string; origin: string; headers: Record<string, string> }> {
    if (source.parse !== 0) {
      throw new PlaybackProxyError("PLAYBACK_PARSE_UNSUPPORTED", "LocalProxy only supports parse=0 media.");
    }
    const parsed = parseHttpUrl(source.url);
    const rules = this.ruleEngine.applySource(
      { url: parsed.toString(), headers: source.headers },
      {
        sourceId: source.sourceId ?? "",
        playbackSessionId: source.playbackSessionId ?? "",
        url: parsed.toString(),
      },
    );
    const ruledUrl = parseHttpUrl(rules.url);
    const headers = normalizeUpstreamHeaders(rules.headers, this.allowedUpstreamHeaders);
    await this.assertSafeUrl(ruledUrl, ruledUrl.origin);
    return { url: ruledUrl.toString(), origin: ruledUrl.origin, headers };
  }

  private async assertSafeUrl(value: URL, expectedOrigin: string): Promise<void> {
    if (value.origin !== expectedOrigin) {
      throw new PlaybackProxyError("PLAYBACK_PROXY_ORIGIN_BLOCKED", "The playback URL is outside the proxy session origin.");
    }
    if (this.allowedOrigins.has(value.origin)) return;

    const hostname = stripIpv6Brackets(value.hostname);
    if (isBlockedAddress(hostname)) {
      throw new PlaybackProxyError("PLAYBACK_PRIVATE_ADDRESS_BLOCKED", "The playback origin is not allowed.");
    }
    try {
      const addresses = await this.resolveAddresses(hostname);
      if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
        throw new PlaybackProxyError("PLAYBACK_PRIVATE_ADDRESS_BLOCKED", "The playback origin is not allowed.");
      }
    } catch (error) {
      if (error instanceof PlaybackProxyError) throw error;
      throw new PlaybackProxyError("PLAYBACK_DNS_RESOLUTION_FAILED", "The playback origin could not be validated.");
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    writeCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeProxyError(response, 405, "PLAYBACK_PROXY_METHOD_UNSUPPORTED");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(request.url ?? "/", this.url);
    } catch {
      writeProxyError(response, 400, "PLAYBACK_PROXY_REQUEST_INVALID");
      return;
    }
    if (parsed.search) {
      writeProxyError(response, 400, "PLAYBACK_PROXY_QUERY_FORBIDDEN");
      return;
    }
    const parts = parsed.pathname.split("/");
    if (parts.length !== 4 || `/${parts[1] ?? ""}/` !== PROXY_PREFIX) {
      writeProxyError(response, 404, "PLAYBACK_PROXY_NOT_FOUND");
      return;
    }
    const token = parts[2] ?? "";
    const resourceId = stripResourceSuffix(parts[3] ?? "");
    const session = this.sessions.get(token);
    if (!session) {
      writeProxyError(response, 404, "PLAYBACK_PROXY_NOT_FOUND");
      return;
    }
    if (session.revoked) {
      writeProxyError(response, 410, "PLAYBACK_PROXY_REVOKED");
      return;
    }
    if (this.now() >= session.expiresAt) {
      this.revoke(token);
      writeProxyError(response, 410, "PLAYBACK_PROXY_EXPIRED");
      return;
    }
    if (session.activeRequests >= this.maxConcurrentRequests) {
      writeProxyError(response, 429, "PLAYBACK_PROXY_CONCURRENCY_LIMIT");
      return;
    }
    const upstreamUrl = session.resources.get(resourceId);
    if (!upstreamUrl) {
      writeProxyError(response, 404, "PLAYBACK_PROXY_RESOURCE_NOT_FOUND");
      return;
    }

    session.activeRequests += 1;
    const controller = new AbortController();
    session.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.totalRequestTimeoutMs);
    let completed = false;
    const abortIfClientCloses = () => {
      if (!completed && !response.writableEnded) controller.abort();
    };
    request.once("aborted", abortIfClientCloses);
    response.once("close", abortIfClientCloses);
    try {
      await this.proxyRequest(request, response, session, upstreamUrl, controller);
      completed = true;
    } catch (error) {
      completed = true;
      this.writeFailure(response, error);
    } finally {
      clearTimeout(timeout);
      session.activeControllers.delete(controller);
      session.activeRequests -= 1;
    }
  }

  private async proxyRequest(
    request: IncomingMessage,
    response: ServerResponse,
    session: ProxySessionState,
    initialUrl: string,
    controller: AbortController,
  ): Promise<void> {
    const upstream = await this.fetchFollowingRedirects(
      request.method ?? "GET",
      session,
      initialUrl,
      request.headers,
      controller,
    );
    const responseStatus = upstream.response.status;
    if (responseStatus >= 400) {
      await this.readResponse(upstream.response, this.maxErrorBytes, controller);
      writeProxyError(response, responseStatus, `PLAYBACK_UPSTREAM_${responseStatus}`);
      return;
    }
    if (request.method === "HEAD") {
      writeUpstreamHeaders(response, upstream.response, responseStatus);
      response.end();
      return;
    }
    if (isPlaylistResponse(upstream.response, upstream.url)) {
      const body = normalizePlaylistBody(
        (await this.readResponse(upstream.response, this.maxPlaylistBytes, controller)).toString("utf8"),
      );
      const ruled = this.ruleEngine.applyPlaylist(
        body,
        upstream.url,
        {
          sourceId: session.sourceId,
          playbackSessionId: session.playbackSessionId,
          url: upstream.url,
        },
      );
      const rewritten = await this.rewritePlaylist(session, upstream.url, ruled.body);
      writeUpstreamHeaders(response, upstream.response, responseStatus, Buffer.byteLength(rewritten, "utf8"));
      response.end(rewritten);
      return;
    }
    const contentLength = Number(upstream.response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxMediaBytes) {
      await upstream.response.body?.cancel();
      writeProxyError(response, 413, "PLAYBACK_MEDIA_TOO_LARGE");
      return;
    }
    const segmentPlan = session.segmentCrypto.get(initialUrl) ?? session.segmentCrypto.get(upstream.url);
    if (segmentPlan && isMpegTsCandidate(upstream.response, upstream.url)) {
      const body = await this.readResponse(upstream.response, this.maxMediaBytes, controller);
      const transformed = await this.maybeNormalizeMpegTs(session, segmentPlan, body, controller);
      const output = transformed ?? body;
      writeUpstreamHeaders(response, upstream.response, responseStatus, output.length);
      response.end(output);
      return;
    }
    writeUpstreamHeaders(response, upstream.response, responseStatus);
    await this.streamResponse(upstream.response, response, this.maxMediaBytes, controller);
  }

  private async readResponse(
    response: Response,
    limit: number,
    controller: AbortController,
  ): Promise<Buffer> {
    const timeout = setTimeout(() => controller.abort(), this.firstByteTimeoutMs);
    try {
      const body = await readLimited(
        response,
        limit,
        () => clearTimeout(timeout),
        controller.signal,
      );
      if (controller.signal.aborted) throw timeoutError();
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async streamResponse(
    response: Response,
    target: ServerResponse,
    limit: number,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(() => controller.abort(), this.firstByteTimeoutMs);
    try {
      await streamLimited(
        response,
        target,
        limit,
        () => clearTimeout(timeout),
        controller.signal,
      );
      if (controller.signal.aborted) {
        target.destroy();
        throw timeoutError();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        target.destroy();
        throw timeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchFollowingRedirects(
    method: string,
    session: ProxySessionState,
    initialUrl: string,
    incomingHeaders: IncomingMessage["headers"],
    controller: AbortController,
  ): Promise<UpstreamResponse> {
    const signal = controller.signal;
    let url = parseHttpUrl(initialUrl);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await this.assertSessionUrl(session, url);
      const headers = new Headers(session.headers);
      if (url.origin !== session.origin) {
        headers.delete("cookie");
        headers.delete("authorization");
        headers.delete("origin");
      }
      const range = incomingHeaders.range;
      if (typeof range === "string") headers.set("range", range);
      const ifRange = incomingHeaders["if-range"];
      if (typeof ifRange === "string") headers.set("if-range", ifRange);
      let response: Response;
      const connectionTimeout = setTimeout(() => controller.abort(), this.connectionTimeoutMs);
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new PlaybackProxyError("PLAYBACK_PROXY_TIMEOUT", "The upstream playback request timed out.");
        throw new PlaybackProxyError("PLAYBACK_UPSTREAM_UNAVAILABLE", "The upstream playback request failed.");
      } finally {
        clearTimeout(connectionTimeout);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return { response, url: url.toString() };
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new PlaybackProxyError("PLAYBACK_PROXY_REDIRECT_INVALID", "The upstream redirect has no location.");
      url = new URL(location, url);
    }
    throw new PlaybackProxyError("PLAYBACK_PROXY_REDIRECT_LIMIT", "The upstream redirect limit was exceeded.");
  }

  private async rewritePlaylist(
    session: ProxySessionState,
    upstreamUrl: string,
    body: string,
  ): Promise<string> {
    const lines = body.split(/\r?\n/);
    const rewritten: string[] = [];
    const serverDecryptsTs = !lines.some((line) => line.trim().startsWith("#EXT-X-MAP:"))
      && lines.some((line) => line.trim() && !line.trim().startsWith("#"))
      && lines
        .filter((line) => line.trim() && !line.trim().startsWith("#"))
        .every((line) => {
          try {
            return new URL(line.trim(), upstreamUrl).pathname.toLowerCase().endsWith(".ts");
          } catch {
            return false;
          }
        });
    let sequence = parseMediaSequence(body);
    let crypto: SegmentCrypto | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        sequence = parseIntegerTag(trimmed.slice("#EXT-X-MEDIA-SEQUENCE:".length), sequence);
      }
      if (trimmed.startsWith("#EXT-X-KEY:")) {
        crypto = await this.parseSegmentCrypto(session, upstreamUrl, trimmed, sequence);
        if (crypto?.keyUrl && serverDecryptsTs) {
          rewritten.push("#EXT-X-KEY:METHOD=NONE");
          continue;
        }
      }
      if (!trimmed || trimmed.startsWith("#")) {
        rewritten.push(await this.rewriteUriAttributes(session, upstreamUrl, line));
        continue;
      }
      const normalized = new URL(trimmed, upstreamUrl).toString();
      rewritten.push(await this.registerResourceUrl(session, normalized));
      session.segmentCrypto.set(normalized, crypto ? { ...crypto, ...(crypto.iv ? { iv: Buffer.from(crypto.iv) } : {}) } : { sequence });
      sequence += 1;
    }
    return rewritten.join("\n");
  }

  private async parseSegmentCrypto(
    session: ProxySessionState,
    upstreamUrl: string,
    line: string,
    sequence: number,
  ): Promise<SegmentCrypto | undefined> {
    const method = line.match(/METHOD=([^,\s]+)/u)?.[1]?.toUpperCase();
    if (!method || method === "NONE") return undefined;
    if (method !== "AES-128") return undefined;
    const keyValue = line.match(/URI="([^"]+)"/u)?.[1];
    if (!keyValue) return undefined;
    const keyUrl = new URL(keyValue, upstreamUrl).toString();
    await this.assertSessionUrl(session, new URL(keyUrl));
    const ivValue = line.match(/IV=0x([0-9a-f]+)/iu)?.[1];
    return {
      keyUrl,
      sequence,
      ...(ivValue ? { iv: hexIv(ivValue) } : {}),
    };
  }

  private async maybeNormalizeMpegTs(
    session: ProxySessionState,
    plan: SegmentCrypto,
    body: Buffer,
    controller: AbortController,
  ): Promise<Buffer | undefined> {
    let clear = body;
    let decrypted = false;
    if (plan.keyUrl) {
      try {
        const keyResponse = await this.fetchFollowingRedirects("GET", session, plan.keyUrl, {}, controller);
        const key = await this.readResponse(keyResponse.response, 64, controller);
        if (key.length !== 16) return undefined;
        const decipher = createDecipheriv("aes-128-cbc", key, plan.iv ?? sequenceIv(plan.sequence));
        clear = Buffer.concat([decipher.update(body), decipher.final()]);
        decrypted = true;
      } catch {
        return undefined;
      }
    }
    return normalizeMpegTsForBrowser(clear) ?? (decrypted ? clear : undefined);
  }

  private async rewriteUriAttributes(
    session: ProxySessionState,
    upstreamUrl: string,
    line: string,
  ): Promise<string> {
    if (!line.startsWith("#") || !line.includes("URI=")) return line;
    const pattern = /URI="([^"]*)"/g;
    let result = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const value = match[1] ?? "";
      const nextUrl = new URL(value, upstreamUrl).toString();
      const proxyUrl = await this.registerResourceUrl(session, nextUrl);
      result += line.slice(cursor, match.index) + `URI="${proxyUrl}"`;
      cursor = match.index + match[0].length;
    }
    return result ? result + line.slice(cursor) : line;
  }

  private async registerResourceUrl(session: ProxySessionState, value: string): Promise<string> {
    const url = parseHttpUrl(value);
    url.hash = "";
    await this.assertSessionUrl(session, url);
    const normalized = url.toString();
    let resourceId = session.resourceIds.get(normalized);
    if (!resourceId) {
      resourceId = randomToken(18);
      session.resourceIds.set(normalized, resourceId);
      session.resources.set(resourceId, normalized);
    }
    return this.resourceUrl(session.token, resourceId, normalized);
  }

  private async assertSessionUrl(session: ProxySessionState, value: URL): Promise<void> {
    if (session.origins.has(value.origin)) return;
    await this.assertSafeUrl(value, value.origin);
    session.origins.add(value.origin);
  }

  private resourceUrl(token: string, resourceId: string, upstreamUrl: string): string {
    return `${this.url}__qx_playback/${token}/${resourceId}${resourceSuffix(upstreamUrl)}`;
  }

  private revoke(token: string): void {
    const session = this.sessions.get(token);
    if (!session) return;
    revokeState(session);
  }

  private removeExpiredSessions(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (now >= session.expiresAt) this.revoke(token);
    }
  }

  private writeFailure(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    const proxyError = error instanceof PlaybackProxyError
      ? error
      : error instanceof PlaybackRuleError
        ? new PlaybackProxyError(error.code, error.message)
      : new PlaybackProxyError("PLAYBACK_PROXY_ERROR", "The playback proxy request failed.");
    const status = statusForProxyError(proxyError.code);
    writeProxyError(response, status, proxyError.code);
  }
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlaybackProxyError("PLAYBACK_URL_INVALID", "The playback URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PlaybackProxyError("PLAYBACK_PROTOCOL_UNSUPPORTED", "Only HTTP and HTTPS playback URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new PlaybackProxyError("PLAYBACK_URL_INVALID", "Playback URLs cannot contain credentials.");
  }
  return url;
}

/**
 * Some real-world Spider sources return the HLS text as decimal UTF-8 byte
 * values separated by whitespace. Decode that transport wrapper before the
 * normal playlist URI rewrite; ordinary playlists pass through unchanged.
 */
function normalizePlaylistBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || !/^(?:\d{1,3}\s+)*\d{1,3}$/u.test(trimmed)) return body;
  const tokens = trimmed.split(/\s+/u);
  const bytes = Buffer.allocUnsafe(tokens.length);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = Number(tokens[index]);
    if (!Number.isInteger(value) || value < 0 || value > 255) return body;
    bytes[index] = value;
  }
  const decoded = bytes.toString("utf8");
  return decoded.replace(/^\uFEFF/u, "").startsWith("#EXTM3U") ? decoded : body;
}

/**
 * Some HLS providers put malformed multi-channel AAC in MPEG-TS segments.
 * Chromium's MSE rejects those segments even though the H.264 video is valid.
 * Keep ordinary/stereo streams byte-for-byte identical; only rebuild a TS
 * segment after detecting an AAC channel configuration above stereo.
 */
export function normalizeMpegTsForBrowser(input: Buffer): Buffer | undefined {
  if (input.length < 188 || input[0] !== 0x47) return undefined;
  const packets = parseTsPackets(input);
  const pat = packets.find((packet) => packet.pid === 0 && packet.payloadStart);
  if (!pat) return undefined;
  const patSection = sectionFromPacket(pat);
  if (!patSection || patSection.length < 12) return undefined;
  const pmtPid = ((patSection[10]! & 0x1f) << 8) | patSection[11]!;
  const pmt = packets.find((packet) => packet.pid === pmtPid && packet.payloadStart);
  if (!pmt) return undefined;
  const pmtSection = sectionFromPacket(pmt);
  if (!pmtSection || pmtSection.length < 16) return undefined;
  const programInfoLength = ((pmtSection[10]! & 0x0f) << 8) | pmtSection[11]!;
  const entries: Buffer[] = [];
  for (let cursor = 12 + programInfoLength; cursor + 5 <= pmtSection.length - 4;) {
    const infoLength = ((pmtSection[cursor + 3]! & 0x0f) << 8) | pmtSection[cursor + 4]!;
    const end = cursor + 5 + infoLength;
    if (end > pmtSection.length - 4) break;
    entries.push(pmtSection.subarray(cursor, end));
    cursor = end;
  }
  const audioPids = new Set<number>();
  let multiChannelAudio = false;
  for (const entry of entries) {
    const streamType = entry[0]!;
    if (streamType !== 0x0f && streamType !== 0x11) continue;
    const pid = ((entry[1]! & 0x1f) << 8) | entry[2]!;
    audioPids.add(pid);
    if (packets.some((packet) => packet.pid === pid && hasMultiChannelAac(packet.packet, packet.cursor))) {
      multiChannelAudio = true;
    }
  }
  if (!multiChannelAudio || audioPids.size === 0) return undefined;

  const keptEntries = entries.filter((entry) => !audioPids.has(((entry[1]! & 0x1f) << 8) | entry[2]!));
  const prefix = pmtSection.subarray(0, 12 + programInfoLength);
  const body = Buffer.concat([prefix, ...keptEntries]);
  const sectionLength = body.length + 1;
  const nextSection = Buffer.alloc(body.length + 4);
  body.copy(nextSection);
  nextSection[1] = (nextSection[1]! & 0xf0) | ((sectionLength >> 8) & 0x0f);
  nextSection[2] = sectionLength & 0xff;
  nextSection.writeUInt32BE(mpegTsCrc32(nextSection.subarray(0, body.length)), body.length);
  replaceSectionInPacket(pmt, nextSection);

  const videoPids = new Set(keptEntries.map((entry) => ((entry[1]! & 0x1f) << 8) | entry[2]!));
  const output = packets
    .filter((packet) => packet.pid === 0 || packet.pid === pmtPid || packet.pid === 17 || videoPids.has(packet.pid))
    .map((packet) => packet.packet);
  return Buffer.concat(output);
}

interface TsPacket {
  packet: Buffer;
  pid: number;
  payloadStart: boolean;
  cursor: number;
}

function parseTsPackets(input: Buffer): TsPacket[] {
  const packets: TsPacket[] = [];
  for (let offset = 0; offset + 188 <= input.length; offset += 188) {
    if (input[offset] !== 0x47) return [];
    const packet = Buffer.from(input.subarray(offset, offset + 188));
    const adaptation = (packet[3]! >> 4) & 3;
    const cursor = adaptation === 2 || adaptation === 3 ? 5 + packet[4]! : 4;
    if (cursor > 188) return [];
    packets.push({
      packet,
      pid: ((packet[1]! & 0x1f) << 8) | packet[2]!,
      payloadStart: (packet[1]! & 0x40) !== 0,
      cursor,
    });
  }
  return packets;
}

function sectionFromPacket(packet: TsPacket): Buffer | undefined {
  if (packet.cursor >= packet.packet.length) return undefined;
  const payload = packet.packet.subarray(packet.cursor);
  const start = packet.payloadStart ? payload[0]! + 1 : 0;
  if (start + 3 > payload.length) return undefined;
  const length = ((payload[start + 1]! & 0x0f) << 8) | payload[start + 2]!;
  const end = start + 3 + length;
  return end <= payload.length ? payload.subarray(start, end) : undefined;
}

function replaceSectionInPacket(packet: TsPacket, section: Buffer): void {
  packet.packet.fill(0xff, packet.cursor);
  packet.packet[packet.cursor] = 0;
  section.copy(packet.packet, packet.cursor + 1);
}

function hasMultiChannelAac(packet: Buffer, cursor: number): boolean {
  for (let index = cursor; index + 7 < packet.length; index += 1) {
    if (packet[index] !== 0xff || (packet[index + 1]! & 0xf6) !== 0xf0) continue;
    const channelConfiguration = ((packet[index + 2]! & 0x01) << 2) | ((packet[index + 3]! & 0xc0) >> 6);
    // channel_configuration=0 delegates the layout to a Program Config
    // Element. In the real Jianpian segments this is a 5.1 layout, which
    // Chromium rejects while the H.264 video remains decodable.
    return channelConfiguration === 0 || channelConfiguration > 2;
  }
  return false;
}

function mpegTsCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0
        ? ((crc << 1) ^ 0x04c11db7) >>> 0
        : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function hexIv(value: string): Buffer {
  const normalized = value.padStart(32, "0").slice(-32);
  return Buffer.from(normalized, "hex");
}

function sequenceIv(sequence: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(Math.max(0, sequence)), 8);
  return iv;
}

function parseMediaSequence(body: string): number {
  const value = body.match(/#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/u)?.[1];
  return parseIntegerTag(value, 0);
}

function parseIntegerTag(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isMpegTsCandidate(response: Response, url: string): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("mpegts")
    || contentType.includes("mp2t")
    || new URL(url).pathname.toLowerCase().endsWith(".ts");
}

function normalizeOrigin(value: string): string {
  return parseHttpUrl(value).origin;
}

function normalizeUpstreamHeaders(
  input: Record<string, string>,
  allowedHeaders: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(rawName) || /[\r\n]/.test(value)) {
      throw new PlaybackProxyError("PLAYBACK_HEADER_INVALID", "The playback request headers are invalid.");
    }
    if (FORBIDDEN_UPSTREAM_HEADERS.has(name) || name.startsWith("proxy-")) {
      throw new PlaybackProxyError("PLAYBACK_HEADER_FORBIDDEN", "A hop-by-hop or proxy header is not allowed.");
    }
    if (!isInjectedHeaderAllowed(name, allowedHeaders)) {
      throw new PlaybackProxyError("PLAYBACK_HEADER_NOT_ALLOWED", "The playback request header is not allowed.");
    }
    result[name] = value;
  }
  return result;
}

function isInjectedHeaderAllowed(name: string, allowedHeaders: ReadonlySet<string>): boolean {
  return name === "user-agent"
    || name === "referer"
    || name === "origin"
    || name === "cookie"
    || name === "authorization"
    || allowedHeaders.has(name);
}

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isBlockedAddress(value: string): boolean {
  const address = stripIpv6Brackets(value).toLowerCase();
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b !== undefined && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && b !== undefined && b >= 18 && b <= 19)
      || (a === 198 && b === 51)
      || (a === 203 && b === 0 && parts[2] === 113);
  }
  if (version === 6) {
    const normalized = address.replace(/^\[|\]$/g, "");
    const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalized);
    if (mappedIpv4?.[1]) return isBlockedAddress(mappedIpv4[1]);
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return address === "localhost" || address.endsWith(".localhost") || address.endsWith(".local");
}

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[|\]$/g, "");
}

function stripResourceSuffix(value: string): string {
  return value.replace(/\.m3u8$/i, "");
}

function resourceSuffix(value: string): string {
  return new URL(value).pathname.toLowerCase().endsWith(".m3u8") ? ".m3u8" : "";
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isPlaylistResponse(response: Response, url: string): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("mpegurl")
    || contentType.includes("m3u")
    || new URL(url).pathname.toLowerCase().endsWith(".m3u8");
}

async function readLimited(
  response: Response,
  limit: number,
  onFirstByte: () => void,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done || result.value.byteLength > 0) onFirstByte();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > limit) throw new PlaybackProxyError("PLAYBACK_RESPONSE_TOO_LARGE", "The upstream response is too large.");
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function streamLimited(
  response: Response,
  target: ServerResponse,
  limit: number,
  onFirstByte: () => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done || result.value.byteLength > 0) onFirstByte();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > limit) {
        target.destroy();
        throw new PlaybackProxyError("PLAYBACK_MEDIA_TOO_LARGE", "The upstream media is too large.");
      }
      if (!target.write(chunk)) await onceDrain(target);
    }
    target.end();
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function timeoutError(): PlaybackProxyError {
  return new PlaybackProxyError("PLAYBACK_PROXY_TIMEOUT", "The upstream playback request timed out.");
}

function writeUpstreamHeaders(
  target: ServerResponse,
  response: Response,
  status: number,
  contentLength?: number,
): void {
  const headers: Record<string, string | number> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  writeCorsHeaders(target);
  target.writeHead(status, headers);
}

function writeProxyError(response: ServerResponse, status: number, code: string): void {
  if (response.writableEnded) return;
  const body = `${code}\n`;
  writeCorsHeaders(response);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  response.setHeader("access-control-allow-headers", "Range, If-Range, Content-Type");
  response.setHeader("access-control-expose-headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
}

function statusForProxyError(code: string): number {
  if (code === "PLAYBACK_RULE_INVALID") return 422;
  if (code.includes("TIMEOUT")) return 504;
  if (code.includes("TOO_LARGE")) return 413;
  if (code.includes("ORIGIN") || code.includes("PRIVATE") || code.includes("DNS") || code.includes("PROTOCOL")) return 403;
  if (code.includes("EXPIRED") || code.includes("REVOKED")) return 410;
  if (code.includes("QUERY") || code.includes("REQUEST") || code.includes("METHOD")) return 400;
  return 502;
}

function revokeState(session: ProxySessionState): void {
  session.revoked = true;
  for (const controller of session.activeControllers) controller.abort();
  session.activeControllers.clear();
  session.resources.clear();
  session.resourceIds.clear();
}

function onceDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => response.once("drain", resolve));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
