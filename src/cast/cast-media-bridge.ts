import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CastBridgeSource {
  url: string;
  headers?: Record<string, string>;
  contentType?: string;
  maxBytes?: number;
}

export interface CastMediaBridgeOptions {
  bindHost?: "127.0.0.1" | "0.0.0.0";
  advertisedHost?: string;
  port?: number;
  sessionTtlMs?: number;
  requestTimeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface CastBridgeSession {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: number;
  close(): Promise<void>;
}

export class CastMediaBridgeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CastMediaBridgeError";
    this.code = code;
  }
}

interface BridgeState {
  token: string;
  source: CastBridgeSource;
  expiresAt: number;
  controllers: Set<AbortController>;
}

const PREFIX = "/__qx_cast/";
const DEFAULT_SESSION_TTL_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const SAFE_REQUEST_HEADERS = new Set(["range", "if-range", "accept"]);
const FORBIDDEN_SOURCE_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
] as const;

export class CastMediaBridge {
  private readonly bindHost: "127.0.0.1" | "0.0.0.0";
  private readonly advertisedHost: string;
  private readonly port: number;
  private readonly sessionTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, BridgeState>();
  private server: Server | undefined;
  private baseUrl = "";

  public constructor(options: CastMediaBridgeOptions = {}) {
    this.bindHost = options.bindHost ?? "127.0.0.1";
    this.advertisedHost = options.advertisedHost ?? this.bindHost;
    this.port = positive(options.port, 0);
    this.sessionTtlMs = positive(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
    this.requestTimeoutMs = positive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public get activeSessionCount(): number {
    return [...this.sessions.values()].filter((session) => this.now() < session.expiresAt).length;
  }

  public async createSession(source: CastBridgeSource): Promise<CastBridgeSession> {
    validateSource(source);
    this.removeExpiredSessions();
    await this.start();
    const token = randomBytes(24).toString("base64url");
    const state: BridgeState = {
      token,
      source: {
        url: source.url,
        ...(source.headers ? { headers: sanitizeHeaders(source.headers) } : {}),
        ...(source.contentType ? { contentType: source.contentType } : {}),
        ...(source.maxBytes !== undefined ? { maxBytes: positive(source.maxBytes, this.maxBytes) } : {}),
      },
      expiresAt: this.now() + this.sessionTtlMs,
      controllers: new Set(),
    };
    this.sessions.set(token, state);
    let closed = false;
    return {
      token,
      expiresAt: state.expiresAt,
      url: `${this.baseUrl}${PREFIX}${token}/media`,
      close: async () => {
        if (closed) return;
        closed = true;
        await this.revoke(token);
      },
    };
  }

  public async close(): Promise<void> {
    const tokens = [...this.sessions.keys()];
    for (const token of tokens) await this.revoke(token, false);
    const server = this.server;
    this.server = undefined;
    this.baseUrl = "";
    if (server) await closeServer(server);
  }

  private async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.bindHost, resolve);
      });
      const address = server.address() as AddressInfo;
      this.baseUrl = `http://${formatHost(this.advertisedHost)}:${address.port}`;
    } catch (error) {
      this.server = undefined;
      await closeServer(server);
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = parsePath(request.url ?? "/");
    if (!parsed || (request.method !== "GET" && request.method !== "HEAD")) {
      writeError(response, 400, "DLNA_BRIDGE_REQUEST_INVALID");
      return;
    }
    const state = this.sessions.get(parsed.token);
    if (!state) {
      writeError(response, 404, "DLNA_BRIDGE_NOT_FOUND");
      return;
    }
    if (this.now() >= state.expiresAt) {
      void this.revoke(parsed.token);
      writeError(response, 410, "DLNA_BRIDGE_EXPIRED");
      return;
    }
    if (parsed.asset !== "media") {
      writeError(response, 404, "DLNA_BRIDGE_NOT_FOUND");
      return;
    }

    const controller = new AbortController();
    state.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      const upstream = await this.fetchUpstream(state.source, request, controller.signal);
      const length = Number(upstream.headers.get("content-length"));
      const maxBytes = state.source.maxBytes ?? this.maxBytes;
      if (Number.isFinite(length) && length > maxBytes) {
        writeError(response, 413, "DLNA_BRIDGE_MEDIA_TOO_LARGE");
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of SAFE_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      if (!headers["content-type"] && state.source.contentType) headers["content-type"] = state.source.contentType;
      headers["cache-control"] = "no-store";
      headers["access-control-allow-origin"] = "*";
      response.writeHead(upstream.status, headers);
      if (request.method === "HEAD" || !upstream.body) {
        response.end();
        return;
      }
      await streamResponse(upstream, response, maxBytes, controller.signal);
    } catch {
      if (!response.headersSent && !response.writableEnded) writeError(response, 502, "DLNA_BRIDGE_UPSTREAM_FAILED");
      else if (!response.writableEnded) response.destroy();
    } finally {
      clearTimeout(timer);
      response.removeListener("close", cancel);
      state.controllers.delete(controller);
    }
  }

  private async fetchUpstream(
    source: CastBridgeSource,
    request: IncomingMessage,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = new Headers(source.headers);
    for (const [name, value] of Object.entries(request.headers)) {
      const normalized = name.toLowerCase();
      if (!SAFE_REQUEST_HEADERS.has(normalized)) continue;
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && !/[\r\n]/u.test(first)) headers.set(name, first);
    }
    const response = await this.fetchImpl(source.url, {
      method: request.method ?? "GET",
      headers,
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || new URL(location, source.url).origin !== new URL(source.url).origin) {
        throw new CastMediaBridgeError("DLNA_BRIDGE_REDIRECT_BLOCKED", "Cast media redirect is outside its source origin.");
      }
      throw new CastMediaBridgeError("DLNA_BRIDGE_REDIRECT_BLOCKED", "Cast media redirects are not supported by this session.");
    }
    return response;
  }

  private removeExpiredSessions(): void {
    for (const [token, state] of this.sessions) {
      if (this.now() >= state.expiresAt) void this.revoke(token);
    }
  }

  private async revoke(token: string, closeWhenEmpty = true): Promise<void> {
    const state = this.sessions.get(token);
    if (!state) return;
    this.sessions.delete(token);
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
    if (!closeWhenEmpty || this.sessions.size > 0) return;
    const server = this.server;
    this.server = undefined;
    this.baseUrl = "";
    if (server) await closeServer(server);
  }
}

function parsePath(value: string): { token: string; asset: string } | null {
  const parsed = new URL(value, "http://cast.invalid");
  if (parsed.search || parsed.hash) return null;
  const match = new RegExp(`^${PREFIX}([^/]+)/([^/]+)$`, "u").exec(parsed.pathname);
  if (!match || !match[1] || !match[2]) return null;
  return { token: match[1], asset: match[2] };
}

function validateSource(source: CastBridgeSource): void {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new CastMediaBridgeError("DLNA_BRIDGE_SOURCE_INVALID", "Cast media source is invalid.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new CastMediaBridgeError("DLNA_BRIDGE_SOURCE_INVALID", "Cast media source must be an HTTP URL without credentials.");
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (FORBIDDEN_SOURCE_HEADERS.has(name.toLowerCase()) || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw new CastMediaBridgeError("DLNA_BRIDGE_HEADER_INVALID", "Cast media headers are invalid.");
    }
    result[name] = value;
  }
  return result;
}

async function streamResponse(
  upstream: Response,
  target: ServerResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  if (!upstream.body) {
    target.end();
    return;
  }
  const reader = upstream.body.getReader();
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new CastMediaBridgeError("DLNA_BRIDGE_MEDIA_TOO_LARGE", "Cast media is too large.");
      if (!target.write(Buffer.from(chunk.value))) await onceDrain(target);
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

function writeError(response: ServerResponse, status: number, code: string): void {
  if (response.writableEnded) return;
  const body = `${code}\n`;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function onceDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => response.once("drain", resolve));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
