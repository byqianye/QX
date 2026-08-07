import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { renderWebControlHtml, WEB_CONTROL_APP_JS, WEB_CONTROL_STYLES } from "./web-control-ui.js";
import {
  WebSecurityManager,
  isLoopbackAddress,
  isSafeLanAddress,
  listSafeLanInterfaces,
  selectSafeLanInterface,
  type WebLanInterface,
  type WebSecuritySettingsStore,
  type WebSessionView,
} from "./web-security.js";
import {
  WEB_CONTROL_ROUTES,
  WebControlError,
  type WebControlPermission,
  type WebControlBackend,
  type WebControlBackendStatus,
  type WebControlRateClass,
  type WebControlRouteContract,
  type WebControlSnapshot,
} from "./web-control-types.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_MESSAGE_BYTES = 128 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const RATE_WINDOW_MS = 60_000;

export interface WebControlServiceOptions {
  backend: WebControlBackend;
  host?: string;
  port?: number;
  settings?: WebSecuritySettingsStore;
  security?: WebSecurityManager;
  lanEnabled?: boolean;
  lanHost?: string;
  lanInterfaceName?: string;
  lanInterfaces?: () => readonly WebLanInterface[];
  sessionTtlMs?: number;
  pinCooldownMs?: number;
  maxPinFailuresPerIp?: number;
  maxPinFailuresGlobal?: number;
  maxBodyBytes?: number;
  maxConnections?: number;
  maxMessageBytes?: number;
  idleTimeoutMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

interface WebSocketClient {
  socket: Socket;
  buffer: Buffer;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

interface PublicWebControlStatus extends WebControlBackendStatus {
  service: "web-control";
  host: string;
  port: number | null;
  listening: boolean;
}

export class WebControlService {
  private backend: WebControlBackend;
  private readonly maxBodyBytes: number;
  private readonly maxConnections: number;
  private readonly maxMessageBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly security: WebSecurityManager;
  private readonly lanInterfaces: () => readonly WebLanInterface[];
  private readonly lanHost: string | undefined;
  private readonly lanInterfaceName: string | undefined;
  private readonly configuredPort: number;
  private readonly csrfToken = randomBytes(32).toString("hex");
  private readonly clients = new Set<WebSocketClient>();
  private readonly rateWindows = new Map<string, RateWindow>();
  private server: Server | undefined;
  private boundPort: number | null = null;
  private preferredPort: number | null = null;
  private host: string = LOOPBACK_HOST;
  private allowLanValue: boolean;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private broadcasting = false;

  public constructor(options: WebControlServiceOptions) {
    if (options.host !== undefined && options.host !== LOOPBACK_HOST && !isSafeLanAddress(options.host)) {
      throw new WebControlError("WEB_BIND_FORBIDDEN", "Web 控制台只能监听 127.0.0.1", 400);
    }
    this.backend = options.backend;
    const securityOptions = {
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.sessionTtlMs ? { sessionTtlMs: options.sessionTtlMs } : {}),
      ...(options.pinCooldownMs ? { pinCooldownMs: options.pinCooldownMs } : {}),
      ...(options.maxPinFailuresPerIp ? { maxPinFailuresPerIp: options.maxPinFailuresPerIp } : {}),
      ...(options.maxPinFailuresGlobal ? { maxPinFailuresGlobal: options.maxPinFailuresGlobal } : {}),
    };
    this.security = options.security ?? new WebSecurityManager(securityOptions);
    this.allowLanValue = options.lanEnabled ?? this.security.allowLan;
    this.lanInterfaces = options.lanInterfaces ?? listSafeLanInterfaces;
    this.lanHost = options.lanHost ?? (options.host !== undefined && options.host !== LOOPBACK_HOST ? options.host : undefined);
    this.lanInterfaceName = options.lanInterfaceName;
    this.configuredPort = normalizePort(options.port ?? 0);
    this.maxBodyBytes = positiveInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
    this.maxConnections = positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS);
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this.heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    this.now = options.now ?? Date.now;
  }

  public get url(): string | null {
    return this.boundPort === null ? null : `http://${this.host}:${this.boundPort}/`;
  }

  public get allowLan(): boolean {
    return this.allowLanValue;
  }

  public get securityManager(): WebSecurityManager {
    return this.security;
  }

  public get port(): number | null {
    return this.boundPort;
  }

  public get listening(): boolean {
    return this.server !== undefined && this.boundPort !== null;
  }

  public get routeContracts(): readonly WebControlRouteContract[] {
    return WEB_CONTROL_ROUTES;
  }

  public setBackend(backend: WebControlBackend): void {
    this.backend = backend;
    void this.broadcastState();
  }

  public async start(): Promise<void> {
    if (this.server) return;
    this.host = this.resolveHost();
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket as Socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.preferredPort ?? this.configuredPort, this.host, resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new WebControlError("WEB_START_FAILED", "Web 控制台端口不可用", 503);
      this.boundPort = (address as AddressInfo).port;
      this.heartbeatTimer = setInterval(() => {
        void this.broadcastState();
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    } catch (error) {
      this.server = undefined;
      this.boundPort = null;
      await closeHttpServer(server);
      throw toPublicError(error, "WEB_START_FAILED", "Web 控制台启动失败", 503);
    }
  }

  public async close(): Promise<void> {
    await this.closeInternal(false);
  }

  public async configureLan(allowLan: boolean): Promise<void> {
    const nextHost = allowLan ? this.resolveLanHost() : LOOPBACK_HOST;
    const previousAllowLan = this.allowLanValue;
    const previousHost = this.host;
    const previousPort = this.boundPort;
    this.allowLanValue = allowLan;
    this.security.setAllowLan(allowLan);
    if (!this.server) {
      this.host = nextHost;
      return;
    }
    try {
      await this.closeInternal(true);
      this.host = nextHost;
      await this.start();
    } catch (error) {
      this.allowLanValue = previousAllowLan;
      this.security.setAllowLan(previousAllowLan);
      this.host = previousHost;
      this.preferredPort = previousPort;
      try { await this.start(); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private async closeInternal(preservePort: boolean): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const client of [...this.clients]) this.closeClient(client);
    const server = this.server;
    const previousPort = this.boundPort;
    this.server = undefined;
    this.boundPort = null;
    this.preferredPort = preservePort ? previousPort : null;
    this.rateWindows.clear();
    if (server) await closeHttpServer(server);
  }

  private resolveHost(): string {
    return this.allowLanValue ? this.resolveLanHost() : LOOPBACK_HOST;
  }

  private resolveLanHost(): string {
    if (this.lanHost) {
      if (!isSafeLanAddress(this.lanHost)) {
        throw new WebControlError("WEB_LAN_INTERFACE_FORBIDDEN", "LAN binding must use a private IPv4 interface", 400);
      }
      return this.lanHost;
    }
    const selected = selectSafeLanInterface(this.lanInterfaces(), this.lanInterfaceName);
    if (!selected) throw new WebControlError("WEB_LAN_NO_INTERFACE", "No safe private LAN interface is available", 503);
    return selected.address;
  }

  private async rebindLanAfterResponse(
    _allowLan: boolean,
    nextHost: string,
    previousAllowLan: boolean,
    previousHost: string,
  ): Promise<void> {
    const previousPort = this.boundPort;
    try {
      await this.closeInternal(true);
      this.host = nextHost;
      await this.start();
    } catch {
      this.allowLanValue = previousAllowLan;
      this.security.setAllowLan(previousAllowLan);
      this.host = previousHost;
      this.preferredPort = previousPort;
      try { await this.start(); } catch { /* retain the failure without a partial listener */ }
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.routeRequest(request, response);
    } catch (error) {
      const mapped = toPublicError(error, "WEB_REQUEST_FAILED", "Web 控制请求失败", 400);
      if (!response.headersSent && !response.destroyed) this.writeJson(response, request, { error: { code: mapped.code, message: mapped.message } }, mapped.status);
      else if (!response.destroyed) response.end();
    }
  }

  private async routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.baseUrl());
    if (request.method === "OPTIONS") {
      this.handleOptions(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      this.requireOrigin(request, false);
      this.writeText(response, request, renderWebControlHtml(this.csrfToken), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      this.requireOrigin(request, false);
      this.writeText(response, request, WEB_CONTROL_APP_JS, "application/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/styles.css") {
      this.requireOrigin(request, false);
      this.writeText(response, request, WEB_CONTROL_STYLES, "text/css; charset=utf-8");
      return;
    }

    if (await this.handleSecurityRoute(url, request, response)) return;

    const route = WEB_CONTROL_ROUTES.find((candidate) => candidate.method === request.method && candidate.path === url.pathname);
    if (!route) throw new WebControlError("WEB_ROUTE_NOT_FOUND", "Web 控制路由不存在", 404);
    this.requireOrigin(request, request.method === "POST");
    this.enforceRateLimit(request, route.rateClass);
    this.requirePermission(request, route.permission);

    if (request.method === "GET") {
      await this.handleGet(route, url, request, response);
      return;
    }
    const body = await readJson(request, this.maxBodyBytes);
    await this.handlePost(route, body, request, response);
  }

  private async handleSecurityRoute(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const path = url.pathname;
    const isSecurityPath = path.startsWith("/api/security/") || path.startsWith("/auth/");
    if (!isSecurityPath) return false;
    this.enforceRateLimit(request, path === "/auth/pin" ? "control" : "read");

    if (request.method === "GET" && path === "/api/security/status") {
      this.requireOrigin(request, false);
      const session = this.currentSession(request);
      this.writeJson(response, request, this.securityStatus(session, this.isLoopbackRequest(request)));
      return true;
    }
    if (request.method === "GET" && path === "/api/security/setup-pin") {
      this.requireOrigin(request, false);
      this.requireLoopback(request);
      const pin = this.security.consumeSetupPin();
      this.writeJson(response, request, { pin, available: pin !== null });
      return true;
    }
    if (request.method === "GET" && path === "/api/security/sessions") {
      this.requireOrigin(request, false);
      const session = this.requirePermission(request, "control");
      this.writeJson(response, request, { sessions: this.security.listSessions(session?.id) });
      return true;
    }
    if (request.method !== "POST") throw new WebControlError("WEB_ROUTE_NOT_FOUND", "Security route not found", 404);

    const body = await readJson(request, this.maxBodyBytes);
    if (path === "/auth/pin") {
      this.requireOrigin(request, true);
      ensureKeys(body, ["pin", "permissions"]);
      const permissions = webPermissions(body.permissions);
      const result = this.security.login(requiredString(body.pin, "pin", 6), request.socket.remoteAddress ?? "unknown", permissions);
      if (!result.ok) {
        throw new WebControlError(result.code, result.code === "WEB_PIN_RATE_LIMITED" ? "PIN login is temporarily rate limited" : "PIN is invalid", result.code === "WEB_PIN_RATE_LIMITED" ? 429 : 401);
      }
      this.writeJson(response, request, { authenticated: true, session: result.session, sessionToken: result.token }, 200, {
        "set-cookie": this.sessionCookie(result.token, result.session.expiresAt, request),
      });
      return true;
    }

    const session = this.currentSession(request);
    this.requireOrigin(request, true);
    this.requireCsrf(request);
    if (path === "/auth/logout") {
      if (session) this.security.revoke(session.id);
      this.writeJson(response, request, { authenticated: false }, 200, { "set-cookie": this.expiredSessionCookie(request) });
      return true;
    }
    if (path === "/api/security/regenerate-pin") {
      this.requireLoopback(request);
      const pin = this.security.regeneratePin();
      this.writeJson(response, request, { pin, expires: "until this response is dismissed" });
      return true;
    }
    if (path === "/api/security/settings") {
      this.requireLoopback(request);
      if (typeof body.allowLan !== "boolean") throw new WebControlError("WEB_SCHEMA_INVALID", "allowLan must be boolean", 400);
      const nextHost = body.allowLan ? this.resolveLanHost() : LOOPBACK_HOST;
      const previousAllowLan = this.allowLanValue;
      const previousHost = this.host;
      this.allowLanValue = body.allowLan;
      this.security.setAllowLan(body.allowLan);
      this.writeJson(response, request, this.securityStatus(this.currentSession(request), true));
      if (this.server && (previousAllowLan !== body.allowLan || previousHost !== nextHost)) {
        response.once("finish", () => {
          setTimeout(() => { void this.rebindLanAfterResponse(body.allowLan as boolean, nextHost, previousAllowLan, previousHost); }, 0);
        });
      } else {
        this.host = nextHost;
      }
      return true;
    }
    if (path === "/api/security/sessions/revoke") {
      this.requirePermission(request, "control");
      ensureKeys(body, ["id"]);
      this.security.revoke(requiredString(body.id, "id", 128));
      this.writeJson(response, request, { sessions: this.security.listSessions(session?.id) });
      return true;
    }
    if (path === "/api/security/sessions/revoke-all") {
      this.requirePermission(request, "control");
      this.security.revokeAll();
      this.writeJson(response, request, { sessions: [] }, 200, { "set-cookie": this.expiredSessionCookie(request) });
      return true;
    }
    throw new WebControlError("WEB_ROUTE_NOT_FOUND", "Security route not found", 404);
  }

  private async handleGet(
    route: WebControlRouteContract,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    switch (route.path) {
      case "/api/now-playing":
        this.writeJson(response, request, { nowPlaying: (await this.snapshot()).nowPlaying });
        return;
      case "/api/search": {
        const query = queryValue(url.searchParams.get("q"));
        this.writeJson(response, request, { search: await this.backend.search(query) });
        return;
      }
      case "/api/detail": {
        const id = requiredString(url.searchParams.get("id"), "id", 256);
        this.writeJson(response, request, { detail: await this.backend.detail(id) });
        return;
      }
      case "/api/live-channels":
        this.writeJson(response, request, { live: await this.backend.liveChannels() });
        return;
      case "/api/downloads":
        this.writeJson(response, request, { downloads: await this.backend.downloads() });
        return;
      case "/api/cast-devices":
        this.writeJson(response, request, { cast: await this.backend.castDevices() });
        return;
      case "/api/safe-status":
        this.writeJson(response, request, { status: this.publicStatus(await this.backend.safeStatus()) });
        return;
      default:
        throw new WebControlError("WEB_ROUTE_NOT_FOUND", "Web 控制路由不存在", 404);
    }
  }

  private async handlePost(
    route: WebControlRouteContract,
    body: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.requireCsrf(request);
    switch (route.path) {
      case "/api/play":
        ensureKeys(body, ["flag", "id", "vipFlags"]);
        await this.backend.play({ flag: requiredString(body.flag, "flag", 128), id: requiredString(body.id, "id", 256), vipFlags: stringList(body.vipFlags, "vipFlags", 8, 128) });
        this.writeJson(response, request, { nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      case "/api/pause":
        ensureKeys(body, []);
        await this.backend.pause();
        this.writeJson(response, request, { nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      case "/api/stop":
        ensureKeys(body, []);
        await this.backend.stop();
        this.writeJson(response, request, { nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      case "/api/seek":
        ensureKeys(body, ["position"]);
        await this.backend.seek(finiteNumber(body.position, "position", 0, 86_400));
        this.writeJson(response, request, { nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      case "/api/volume": {
        ensureKeys(body, ["volume", "muted"]);
        const muted = body.muted === undefined ? undefined : booleanValue(body.muted, "muted");
        await this.backend.volume(finiteNumber(body.volume, "volume", 0, 1), muted);
        this.writeJson(response, request, { nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      }
      case "/api/play-episode":
        ensureKeys(body, ["lineIndex", "episodeIndex", "vipFlags"]);
        await this.backend.playEpisode({
          lineIndex: integerValue(body.lineIndex, "lineIndex", 0, 1_000),
          episodeIndex: integerValue(body.episodeIndex, "episodeIndex", 0, 100_000),
          vipFlags: stringList(body.vipFlags, "vipFlags", 8, 128),
        });
        this.writeJson(response, request, { nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      case "/api/live-channel": {
        ensureKeys(body, ["channelId", "streamId"]);
        const input = { channelId: requiredString(body.channelId, "channelId", 256) };
        if (body.streamId !== undefined) Object.assign(input, { streamId: requiredString(body.streamId, "streamId", 256) });
        await this.backend.playLive(input);
        const state = await this.afterMutation();
        this.writeJson(response, request, { live: state.live, nowPlaying: state.nowPlaying });
        return;
      }
      case "/api/push": {
        ensureKeys(body, ["url", "title"]);
        const url = requiredString(body.url, "url", 2_048);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new WebControlError("WEB_PUSH_URL_INVALID", "Push 只允许 HTTP(S) 地址", 400);
        }
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
          throw new WebControlError("WEB_PUSH_URL_INVALID", "Push 只允许不带凭据的 HTTP(S) 地址", 400);
        }
        const title = body.title === undefined ? undefined : requiredString(body.title, "title", 200);
        const result = await this.backend.push({ url: parsed.toString(), ...(title === undefined ? {} : { title }) });
        this.writeJson(response, request, { push: result, nowPlaying: (await this.afterMutation()).nowPlaying });
        return;
      }
      case "/api/cast":
        ensureKeys(body, ["deviceId"]);
        await this.backend.cast(requiredString(body.deviceId, "deviceId", 256));
        this.writeJson(response, request, { cast: (await this.afterMutation()).cast });
        return;
      default:
        throw new WebControlError("WEB_ROUTE_NOT_FOUND", "Web 控制路由不存在", 404);
    }
  }

  private async afterMutation(): Promise<WebControlSnapshot & { status: PublicWebControlStatus }> {
    const snapshot = await this.snapshot();
    void this.broadcastState();
    return snapshot;
  }

  private async snapshot(): Promise<WebControlSnapshot & { status: PublicWebControlStatus }> {
    const snapshot = await this.backend.snapshot();
    return { ...snapshot, status: this.publicStatus(snapshot.status) };
  }

  private publicStatus(status: WebControlBackendStatus): PublicWebControlStatus {
    return {
      service: "web-control",
      host: this.host,
      port: this.boundPort,
      listening: this.listening,
      uiReady: status.uiReady,
      capabilities: { ...status.capabilities },
      lanControl: this.allowLanValue ? "enabled" : "disabled",
    };
  }

  private securityStatus(session: WebSessionView | null, includeSessions: boolean): Record<string, unknown> {
    return {
      allowLan: this.allowLanValue,
      host: this.host,
      port: this.boundPort,
      listening: this.listening,
      pinConfigured: this.security.pinConfigured,
      setupPinAvailable: includeSessions && this.security.setupPinAvailable,
      authenticated: session !== null,
      session,
      ...(includeSessions ? { sessions: this.security.listSessions(session?.id) } : {}),
    };
  }

  private currentSession(request: IncomingMessage): WebSessionView | null {
    return this.security.authenticate(readCookie(request, "qx_web_session"));
  }

  private requirePermission(request: IncomingMessage, permission: WebControlPermission): WebSessionView | null {
    if (this.isLoopbackRequest(request) || !this.allowLanValue) return null;
    const session = this.currentSession(request);
    if (!session) throw new WebControlError("WEB_AUTH_REQUIRED", "LAN control requires a valid PIN session", 401);
    if (!this.security.hasPermission(session, permission)) {
      throw new WebControlError("WEB_PERMISSION_FORBIDDEN", `This session does not have ${permission} permission`, 403);
    }
    return session;
  }

  private requireLoopback(request: IncomingMessage): void {
    if (!this.isLoopbackRequest(request)) throw new WebControlError("WEB_LOCAL_ONLY", "This security action is local-only", 403);
  }

  private isLoopbackRequest(request: IncomingMessage): boolean {
    return isLoopbackAddress(request.socket.remoteAddress);
  }

  private sessionCookie(token: string, expiresAt: number, request: IncomingMessage): string {
    const maxAge = Math.max(0, Math.ceil((expiresAt - this.now()) / 1000));
    return `qx_web_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${isHttpsRequest(request) ? "; Secure" : ""}`;
  }

  private expiredSessionCookie(request: IncomingMessage): string {
    return `qx_web_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${isHttpsRequest(request) ? "; Secure" : ""}`;
  }

  private handleOptions(request: IncomingMessage, response: ServerResponse): void {
    this.requireOrigin(request, false);
    this.writeHead(response, request, 204, {
      allow: "GET, POST, OPTIONS",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-csrf-token",
      "access-control-allow-credentials": "true",
      "content-length": "0",
    });
    response.end();
  }

  private requireOrigin(request: IncomingMessage, stateChanging: boolean): void {
    const origin = header(request, "origin");
    if (origin !== undefined && origin !== this.origin()) {
      throw new WebControlError("WEB_ORIGIN_FORBIDDEN", "Web 控制请求来源不被允许", 403);
    }
    if (stateChanging && origin !== this.origin()) {
      throw new WebControlError("WEB_ORIGIN_REQUIRED", "状态变更请求必须带有本地 Origin", 403);
    }
  }

  private requireCsrf(request: IncomingMessage): void {
    if (header(request, "x-csrf-token") !== this.csrfToken) {
      throw new WebControlError("WEB_CSRF_INVALID", "Web 控制请求缺少有效 CSRF 校验", 403);
    }
  }

  private enforceRateLimit(request: IncomingMessage, rateClass: WebControlRateClass): void {
    const limits: Record<WebControlRateClass, number> = { read: 120, control: 60, search: 30 };
    const key = `${request.socket.remoteAddress ?? "local"}:${rateClass}`;
    const current = this.rateWindows.get(key);
    const now = this.now();
    if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
      this.rateWindows.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= (limits[rateClass] ?? 0)) throw new WebControlError("WEB_RATE_LIMITED", "Web 控制请求过于频繁", 429);
    current.count += 1;
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket): void {
    try {
      this.requirePermission(request, "read");
      const url = new URL(request.url ?? "/", this.baseUrl());
      if (url.pathname !== "/ws") throw new WebControlError("WEB_WS_NOT_FOUND", "WebSocket 路由不存在", 404);
      this.requireOrigin(request, true);
      if (header(request, "sec-websocket-version") !== "13") throw new WebControlError("WEB_WS_VERSION_UNSUPPORTED", "WebSocket 版本不受支持", 400);
      const key = header(request, "sec-websocket-key");
      if (!key || key.length > 128) throw new WebControlError("WEB_WS_KEY_INVALID", "WebSocket 握手无效", 400);
      if (this.clients.size >= this.maxConnections) throw new WebControlError("WEB_WS_CONNECTION_LIMIT", "WebSocket 连接数已达上限", 503);
      const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"));
      const client: WebSocketClient = { socket, buffer: Buffer.alloc(0) };
      this.clients.add(client);
      socket.setNoDelay(true);
      socket.setTimeout(this.idleTimeoutMs, () => this.closeClient(client));
      socket.on("data", (chunk) => this.readWebSocket(client, chunk));
      socket.once("close", () => this.clients.delete(client));
      socket.once("error", () => this.closeClient(client));
      void this.sendSnapshot(client);
    } catch (error) {
      const mapped = toPublicError(error, "WEB_WS_HANDSHAKE_FAILED", "WebSocket 握手失败", 400);
      socket.end(`HTTP/1.1 ${mapped.status} ${statusText(mapped.status)}\r\nConnection: close\r\n\r\n`);
    }
  }

  private readWebSocket(client: WebSocketClient, chunk: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    client.socket.setTimeout(this.idleTimeoutMs, () => this.closeClient(client));
    while (client.buffer.length >= 2 && this.clients.has(client)) {
      const first = client.buffer[0] ?? 0;
      const second = client.buffer[1] ?? 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (client.buffer.length < 4) return;
        length = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (client.buffer.length < 10) return;
        const high = client.buffer.readUInt32BE(2);
        const low = client.buffer.readUInt32BE(6);
        if (high !== 0 || low > this.maxMessageBytes) {
          this.closeClient(client);
          return;
        }
        length = low;
        offset = 10;
      }
      if (!masked || length > this.maxMessageBytes) {
        this.closeClient(client);
        return;
      }
      if (client.buffer.length < offset + 4 + length) return;
      const mask = client.buffer.subarray(offset, offset + 4);
      const payload = client.buffer.subarray(offset + 4, offset + 4 + length);
      client.buffer = client.buffer.subarray(offset + 4 + length);
      const decoded = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) decoded[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      if (opcode === 0x8) {
        this.closeClient(client);
      } else if (opcode === 0x9) {
        this.sendFrame(client, 0x0a, decoded);
      } else if (opcode !== 0x1) {
        this.closeClient(client);
      } else {
        try {
          JSON.parse(decoded.toString("utf8"));
        } catch {
          this.closeClient(client);
        }
      }
    }
  }

  private async sendSnapshot(client: WebSocketClient): Promise<void> {
    if (!this.clients.has(client)) return;
    try {
      this.sendJsonFrame(client, { type: "state", snapshot: await this.snapshot() });
    } catch {
      this.closeClient(client);
    }
  }

  private async broadcastState(): Promise<void> {
    if (this.broadcasting || this.clients.size === 0) return;
    this.broadcasting = true;
    try {
      const snapshot = await this.snapshot();
      for (const client of this.clients) this.sendJsonFrame(client, { type: "state", snapshot });
    } catch {
      // A disconnected or unavailable backend must not take down the HTTP server.
    } finally {
      this.broadcasting = false;
    }
  }

  private sendJsonFrame(client: WebSocketClient, value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.byteLength > this.maxMessageBytes) {
      this.closeClient(client);
      return;
    }
    this.sendFrame(client, 0x01, payload);
  }

  private sendFrame(client: WebSocketClient, opcode: number, payload: Buffer): void {
    if (!this.clients.has(client) || client.socket.destroyed) return;
    let header: Buffer;
    if (payload.byteLength < 126) {
      header = Buffer.from([0x80 | opcode, payload.byteLength]);
    } else if (payload.byteLength <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.byteLength, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.byteLength, 6);
    }
    client.socket.write(Buffer.concat([header, payload]));
  }

  private closeClient(client: WebSocketClient): void {
    this.clients.delete(client);
    if (!client.socket.destroyed) {
      try { this.sendFrame(client, 0x08, Buffer.alloc(0)); } catch { /* socket is already closing */ }
      client.socket.end();
    }
  }

  private writeText(response: ServerResponse, request: IncomingMessage, value: string, contentType: string): void {
    this.writeHead(response, request, 200, {
      "content-type": contentType,
      "content-length": Buffer.byteLength(value, "utf8").toString(),
      "cache-control": "no-store",
    });
    response.end(value);
  }

  private writeJson(
    response: ServerResponse,
    request: IncomingMessage,
    value: unknown,
    status = 200,
    extraHeaders: Record<string, string | string[]> = {},
  ): void {
    const serialized = JSON.stringify(value);
    this.writeHead(response, request, status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(serialized, "utf8").toString(),
      "cache-control": "no-store",
      ...extraHeaders,
    });
    response.end(serialized);
  }

  private writeHead(
    response: ServerResponse,
    request: IncomingMessage,
    status: number,
    headers: Record<string, string | string[]>,
  ): void {
    const origin = header(request, "origin");
    response.writeHead(status, {
      ...headers,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      vary: "Origin",
      ...(origin === this.origin() ? { "access-control-allow-origin": origin } : {}),
    });
  }

  private baseUrl(): string {
    return this.url ?? `http://${this.host}:${this.configuredPort || 80}/`;
  }

  private origin(): string {
    return this.url ? new URL(this.url).origin : `http://${this.host}:${this.configuredPort || 80}`;
  }
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new WebControlError("WEB_PORT_INVALID", "Web 控制台端口无效", 400);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const raw = header(request, "cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function isHttpsRequest(request: IncomingMessage): boolean {
  return Boolean((request.socket as Socket & { encrypted?: boolean }).encrypted);
}

function webPermissions(value: unknown): readonly WebControlPermission[] {
  if (value === undefined) return ["read"];
  if (!Array.isArray(value) || value.length > 3) {
    throw new WebControlError("WEB_SCHEMA_INVALID", "permissions must be a short list", 400);
  }
  const allowed = new Set<WebControlPermission>(["read", "control", "push"]);
  const result = [...new Set(value)].filter((permission): permission is WebControlPermission => typeof permission === "string" && allowed.has(permission as WebControlPermission));
  if (result.length !== value.length || result.length === 0) {
    throw new WebControlError("WEB_SCHEMA_INVALID", "permissions contains an unsupported value", 400);
  }
  return result;
}

function queryValue(value: string | null): string {
  return value === null ? "" : requiredString(value, "q", 120);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new WebControlError("WEB_SCHEMA_INVALID", `${field} 字段无效`, 400);
  }
  return value.trim();
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new WebControlError("WEB_SCHEMA_INVALID", `${field} 字段无效`, 400);
  return value.map((item) => requiredString(item, field, maxLength));
}

function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new WebControlError("WEB_SCHEMA_INVALID", `${field} 字段无效`, 400);
  }
  return value;
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new WebControlError("WEB_SCHEMA_INVALID", `${field} 字段无效`, 400);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new WebControlError("WEB_SCHEMA_INVALID", `${field} 字段无效`, 400);
  return value;
}

function ensureKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new WebControlError("WEB_SCHEMA_INVALID", "请求字段不在 Web 控制白名单内", 400);
  }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new WebControlError("WEB_BODY_TOO_LARGE", "请求体超过 Web 控制台限制", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WebControlError("WEB_JSON_INVALID", "请求体不是有效 JSON", 400);
  }
  if (!isRecord(value)) throw new WebControlError("WEB_JSON_INVALID", "请求体必须是 JSON 对象", 400);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPublicError(error: unknown, fallbackCode: string, fallbackMessage: string, fallbackStatus: number): WebControlError {
  if (error instanceof WebControlError) return error;
  const code = isRecord(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : fallbackCode;
  return new WebControlError(code, fallbackMessage, fallbackStatus);
}

function statusText(status: number): string {
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 429) return "Too Many Requests";
  if (status === 503) return "Service Unavailable";
  return "Bad Request";
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
