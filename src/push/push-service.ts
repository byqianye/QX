import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";

import type { SettingsRepository } from "../data/repositories.js";
import {
  EMPTY_PUSH_UI_STATE,
  PUSH_REQUEST_TYPES,
  type PushConfirmationPolicy,
  type PushConflictMode,
  type PushConfirmationPreview,
  type PushLiveChannelReference,
  type PushPlaybackSessionSnapshot,
  type PushRecentRecord,
  type PushRequest,
  type PushRequestBase,
  type PushRequestType,
  type PushRequester,
  type PushSourceReference,
  type PushUiState,
} from "./push-types.js";

export const PUSH_SETTINGS_KEY = "push.settings";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RECENT = 20;
const MAX_PENDING = 12;
const MAX_QUEUE = 20;
const MAX_REDIRECTS = 5;

const HEADER_ALLOWLIST = new Map<string, string>([
  ["accept", "Accept"],
  ["accept-language", "Accept-Language"],
  ["origin", "Origin"],
  ["referer", "Referer"],
  ["user-agent", "User-Agent"],
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PushServiceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PushServiceError";
    this.code = code;
  }
}

export interface PushPlaybackPort {
  getActiveSession(): PushPlaybackSessionSnapshot | null;
  play(request: PushRequest): Promise<PushPlaybackSessionSnapshot>;
}

export interface PushUrlValidationOptions {
  allowedOrigins?: readonly string[];
  trustedLocalOrigins?: readonly string[];
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export interface PushServiceOptions {
  playback: PushPlaybackPort;
  settings?: SettingsRepository;
  host?: string;
  port?: number;
  enabled?: boolean;
  confirmationPolicy?: PushConfirmationPolicy;
  conflictMode?: PushConflictMode;
  allowedOrigins?: readonly string[];
  trustedLocalOrigins?: readonly string[];
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  resolveRedirectChain?: (url: string) => Promise<readonly string[]>;
  resolveFixtureUrl?: (fixtureId: string) => string | undefined | Promise<string | undefined>;
  now?: () => number;
}

export interface PushConfigurePatch {
  enabled?: boolean;
  port?: number;
  confirmationPolicy?: PushConfirmationPolicy;
  conflictMode?: PushConflictMode;
}

export type PushSubmissionResult =
  | {
      kind: "confirmation-required";
      preview: PushConfirmationPreview;
    }
  | {
      kind: "accepted";
      recent: PushRecentRecord;
      session: PushPlaybackSessionSnapshot;
    }
  | {
      kind: "queued";
      recent: PushRecentRecord;
    };

export interface PushConfirmationResult {
  kind: "rejected" | "accepted" | "queued";
  recent: PushRecentRecord;
  session?: PushPlaybackSessionSnapshot;
}

interface PendingPush {
  preview: PushConfirmationPreview;
  request: PushRequest;
}

interface QueuedPush {
  id: string;
  request: PushRequest;
}

interface PersistedPushSettings {
  enabled: boolean;
  port: number;
  confirmationPolicy: PushConfirmationPolicy;
  conflictMode: PushConflictMode;
}

const DEFAULT_SETTINGS: PersistedPushSettings = {
  enabled: true,
  port: 0,
  confirmationPolicy: "ask",
  conflictMode: "replace",
};

export class PushService {
  private readonly playback: PushPlaybackPort;
  private readonly settingsRepository: SettingsRepository | undefined;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly trustedLocalOrigins: ReadonlySet<string>;
  private readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  private readonly resolveRedirectChain: ((url: string) => Promise<readonly string[]>) | undefined;
  private readonly resolveFixtureUrl: ((fixtureId: string) => string | undefined | Promise<string | undefined>) | undefined;
  private readonly now: () => number;
  private readonly host = "127.0.0.1" as const;
  private configuredPort: number;
  private enabledValue: boolean;
  private confirmationPolicyValue: PushConfirmationPolicy;
  private conflictModeValue: PushConflictMode;
  private server: Server | undefined;
  private boundPort: number | null = null;
  private errorValue: { code: string; message: string } | null = null;
  private readonly pending = new Map<string, PendingPush>();
  private readonly queue: QueuedPush[] = [];
  private recentValue: PushRecentRecord[] = [];
  private draining = false;
  private playbackTail: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;

  public constructor(options: PushServiceOptions) {
    if (options.host !== undefined && options.host !== this.host) {
      throw new PushServiceError("PUSH_BIND_FORBIDDEN", "Push 服务只能监听 127.0.0.1。", undefined);
    }
    this.playback = options.playback;
    this.settingsRepository = options.settings;
    const stored = readStoredSettings(options.settings?.get<unknown>(PUSH_SETTINGS_KEY));
    this.configuredPort = normalizePort(options.port ?? stored.port);
    this.enabledValue = options.enabled ?? stored.enabled;
    this.confirmationPolicyValue = options.confirmationPolicy ?? stored.confirmationPolicy;
    this.conflictModeValue = options.conflictMode ?? stored.conflictMode;
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin).filter(isString));
    this.trustedLocalOrigins = new Set((options.trustedLocalOrigins ?? []).map(normalizeOrigin).filter(isString));
    this.resolveAddresses = options.resolveAddresses ?? resolveHostAddresses;
    this.resolveRedirectChain = options.resolveRedirectChain;
    this.resolveFixtureUrl = options.resolveFixtureUrl;
    this.now = options.now ?? Date.now;
  }

  public get url(): string | null {
    return this.server && this.boundPort !== null
      ? `http://${this.host}:${this.boundPort}/push`
      : null;
  }

  public get port(): number | null {
    return this.boundPort;
  }

  public get listening(): boolean {
    return this.server !== undefined && this.boundPort !== null;
  }

  public uiState(): PushUiState {
    let activeSession: PushPlaybackSessionSnapshot | null = null;
    try {
      activeSession = cloneSession(this.playback.getActiveSession());
    } catch {
      activeSession = null;
    }
    return {
      ...EMPTY_PUSH_UI_STATE,
      enabled: this.enabledValue,
      configuredPort: this.configuredPort,
      port: this.boundPort,
      listening: this.listening,
      endpoint: this.url,
      confirmationPolicy: this.confirmationPolicyValue,
      conflictMode: this.conflictModeValue,
      pending: [...this.pending.values()].map((entry) => clonePreview(entry.preview)),
      recent: this.recentValue.map(cloneRecent),
      activeSession,
      error: this.errorValue ? { ...this.errorValue } : null,
    };
  }

  public async start(): Promise<void> {
    if (!this.enabledValue || this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.configuredPort, this.host, resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new PushServiceError("PUSH_START_FAILED", "Push 服务端口不可用。");
      this.boundPort = (address as AddressInfo).port;
      this.errorValue = null;
    } catch (error) {
      this.server = undefined;
      this.boundPort = null;
      await closeServer(server);
      const mapped = error instanceof PushServiceError
        ? error
        : new PushServiceError("PUSH_START_FAILED", "localhost Push 服务启动失败。", { cause: error });
      this.errorValue = { code: mapped.code, message: mapped.message };
      throw mapped;
    }
  }

  public async close(): Promise<void> {
    this.lifecycleGeneration += 1;
    for (const id of this.pending.keys()) this.updateRecent(id, { status: "cancelled", error: null });
    this.pending.clear();
    for (const item of this.queue.splice(0)) this.updateRecent(item.id, { status: "cancelled", error: null });
    const server = this.server;
    this.server = undefined;
    this.boundPort = null;
    if (server) await closeServer(server);
  }

  public async configure(patch: PushConfigurePatch): Promise<PushUiState> {
    const next: PersistedPushSettings = {
      enabled: patch.enabled ?? this.enabledValue,
      port: patch.port === undefined ? this.configuredPort : normalizePort(patch.port),
      confirmationPolicy: patch.confirmationPolicy ?? this.confirmationPolicyValue,
      conflictMode: patch.conflictMode ?? this.conflictModeValue,
    };
    const restart = next.enabled !== this.enabledValue
      || next.port !== this.configuredPort;
    this.enabledValue = next.enabled;
    this.configuredPort = next.port;
    this.confirmationPolicyValue = next.confirmationPolicy;
    this.conflictModeValue = next.conflictMode;
    this.settingsRepository?.set(PUSH_SETTINGS_KEY, next);
    if (restart) {
      await this.close();
      if (this.enabledValue) await this.start();
    }
    return this.uiState();
  }

  public async submitUri(
    uri: string,
    options: { requestedBy?: PushRequester; conflictMode?: PushConflictMode } = {},
  ): Promise<PushSubmissionResult> {
    const request = parsePushUri(uri, options.requestedBy ?? "localhost");
    return this.submit(request, options);
  }

  public async submit(
    request: PushRequest,
    options: { confirmed?: boolean; conflictMode?: PushConflictMode } = {},
  ): Promise<PushSubmissionResult> {
    if (!this.enabledValue) throw new PushServiceError("PUSH_DISABLED", "Push 服务已关闭。", undefined);
    const normalized = await this.normalizeRequest(request);
    const confirmed = options.confirmed === true
      || (normalized.requestedBy === "trusted-local" && this.confirmationPolicyValue === "allow-trusted-local");
    if (!confirmed) {
      if (this.pending.size >= MAX_PENDING) {
        throw new PushServiceError("PUSH_CONFIRMATION_LIMIT", "待确认的 Push 请求过多。", undefined);
      }
      const preview = createPreview(normalized, this.now());
      this.pending.set(preview.id, { preview, request: normalized });
      this.addRecent({
        id: preview.id,
        type: preview.type,
        title: preview.title,
        status: "pending-confirmation",
        requestedBy: preview.requestedBy,
        createdAt: preview.createdAt,
        sessionId: null,
        error: null,
      });
      return { kind: "confirmation-required", preview: clonePreview(preview) };
    }
    return this.accept(normalized, options.conflictMode ?? this.conflictModeValue);
  }

  public async confirm(
    id: string,
    decision: "play" | "reject",
    conflictMode?: PushConflictMode,
  ): Promise<PushConfirmationResult> {
    const pending = this.pending.get(id);
    if (!pending) throw new PushServiceError("PUSH_CONFIRMATION_NOT_FOUND", "Push 确认请求不存在或已过期。", undefined);
    this.pending.delete(id);
    if (decision === "reject") {
      const recent = this.updateRecent(id, {
        status: "rejected",
        error: null,
      });
      return { kind: "rejected", recent };
    }
    const result = await this.accept(pending.request, conflictMode ?? this.conflictModeValue, id);
    return result.kind === "accepted"
      ? { kind: "accepted", recent: result.recent, session: result.session }
      : { kind: "queued", recent: result.recent };
  }

  public cancel(id: string): PushRecentRecord {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      return this.updateRecent(id, { status: "cancelled", error: null });
    }
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
      return this.updateRecent(id, { status: "cancelled", error: null });
    }
    throw new PushServiceError("PUSH_REQUEST_NOT_FOUND", "Push 请求不存在或已完成。", undefined);
  }

  public clearRecent(): PushUiState {
    this.recentValue = [];
    return this.uiState();
  }

  public async drainQueue(): Promise<void> {
    if (this.draining || !this.enabledValue) return;
    this.draining = true;
    try {
      await this.serializePlayback(async () => {
        const generation = this.lifecycleGeneration;
        while (this.queue.length > 0 && !this.playback.getActiveSession()) {
          if (!this.enabledValue || generation !== this.lifecycleGeneration) break;
          const item = this.queue.shift();
          if (!item) break;
          try {
            const session = await this.playback.play(item.request);
            if (!this.enabledValue || generation !== this.lifecycleGeneration) {
              this.updateRecent(item.id, { status: "cancelled", sessionId: null, error: null });
            } else {
              this.updateRecent(item.id, { status: "accepted", sessionId: session.id, error: null });
            }
          } catch (error) {
            const mapped = mapPlaybackError(error);
            if (!this.enabledValue || generation !== this.lifecycleGeneration) {
              this.updateRecent(item.id, { status: "cancelled", sessionId: null, error: null });
            } else {
              this.updateRecent(item.id, { status: "failed", error: { code: mapped.code, message: mapped.message } });
            }
          }
        }
      });
    } finally {
      this.draining = false;
    }
  }

  private async accept(
    request: PushRequest,
    conflictMode: PushConflictMode,
    existingId?: string,
  ): Promise<Exclude<PushSubmissionResult, { kind: "confirmation-required" }>> {
    return this.serializePlayback(() => this.acceptUnlocked(request, conflictMode, existingId));
  }

  private async acceptUnlocked(
    request: PushRequest,
    conflictMode: PushConflictMode,
    existingId?: string,
  ): Promise<Exclude<PushSubmissionResult, { kind: "confirmation-required" }>> {
    if (!this.enabledValue) throw new PushServiceError("PUSH_DISABLED", "Push 服务已关闭。", undefined);
    const generation = this.lifecycleGeneration;
    const id = existingId ?? randomUUID();
    const active = this.playback.getActiveSession();
    if (active) {
      if (conflictMode === "reject") {
        const recent = this.updateRecent(id, {
          id,
          type: request.type,
          title: displayTitle(request),
          status: "rejected",
          requestedBy: request.requestedBy,
          createdAt: this.now(),
          sessionId: null,
          error: { code: "PUSH_CONFLICT", message: "当前已有播放会话。" },
        });
        throw new PushServiceError("PUSH_CONFLICT", "当前已有播放会话。", undefined);
      }
      if (conflictMode === "queue") {
        if (this.queue.length >= MAX_QUEUE) throw new PushServiceError("PUSH_QUEUE_LIMIT", "Push 队列已满。", undefined);
        this.queue.push({ id, request });
        const recent = this.updateRecent(id, {
          id,
          type: request.type,
          title: displayTitle(request),
          status: "queued",
          requestedBy: request.requestedBy,
          createdAt: this.now(),
          sessionId: null,
          error: null,
        });
        return { kind: "queued", recent };
      }
    }
    try {
      const session = await this.playback.play(request);
      if (!this.enabledValue || generation !== this.lifecycleGeneration) {
        this.updateRecent(id, { status: "cancelled", sessionId: null, error: null });
        throw new PushServiceError("PUSH_DISABLED", "Push 服务已关闭。", undefined);
      }
      const recent = this.updateRecent(id, {
        id,
        type: request.type,
        title: displayTitle(request),
        status: "accepted",
        requestedBy: request.requestedBy,
        createdAt: this.now(),
        sessionId: session.id,
        error: null,
      });
      return { kind: "accepted", recent, session: cloneSession(session)! };
    } catch (error) {
      const mapped = mapPlaybackError(error);
      if (!this.enabledValue || generation !== this.lifecycleGeneration) {
        this.updateRecent(id, { status: "cancelled", sessionId: null, error: null });
        throw new PushServiceError("PUSH_DISABLED", "Push 服务已关闭。", undefined);
      }
      const recent = this.updateRecent(id, {
        id,
        type: request.type,
        title: displayTitle(request),
        status: "failed",
        requestedBy: request.requestedBy,
        createdAt: this.now(),
        sessionId: null,
        error: { code: mapped.code, message: mapped.message },
      });
      throw new PushServiceError(mapped.code, mapped.message, { cause: error });
    }
  }

  private async normalizeRequest(request: PushRequest): Promise<PushRequest> {
    const base = normalizeBase(request);
    if (request.type === "url") {
      const url = await this.validateUrl(request.url);
      return { ...request, ...base, url: url.toString() };
    }
    if (request.type === "fixture") {
      if (!request.fixtureId.trim()) throw new PushServiceError("PUSH_REQUEST_INVALID", "fixture 标识不能为空。", undefined);
      let fixtureUrl = request.url;
      if (!fixtureUrl && this.resolveFixtureUrl) {
        try {
          fixtureUrl = await this.resolveFixtureUrl(request.fixtureId.trim());
        } catch (error) {
          throw new PushServiceError("PUSH_FIXTURE_UNAVAILABLE", "Push fixture 地址不可用。", { cause: error });
        }
      }
      if (!fixtureUrl) return { ...request, ...base, fixtureId: request.fixtureId.trim() };
      const url = await this.validateUrl(fixtureUrl);
      return { ...request, ...base, fixtureId: request.fixtureId.trim(), url: url.toString() };
    }
    if (request.type === "source-item") {
      if (Object.keys(base.headers).length > 0) throw new PushServiceError("PUSH_HEADERS_UNSUPPORTED", "source-item 不接受外部请求头。", undefined);
      const reference = normalizeSourceReference(request.sourceReference);
      return { ...request, ...base, sourceReference: reference };
    }
    if (request.type === "local-file") {
      if (Object.keys(base.headers).length > 0) throw new PushServiceError("PUSH_HEADERS_UNSUPPORTED", "local-file 不接受外部请求头。", undefined);
      const itemId = normalizeIdentifier(request.localFileReference?.itemId, "本地媒体标识");
      return { ...request, ...base, localFileReference: { itemId } };
    }
    if (Object.keys(base.headers).length > 0) throw new PushServiceError("PUSH_HEADERS_UNSUPPORTED", "live-channel 不接受外部请求头。", undefined);
    const reference = request.sourceReference;
    const channelId = normalizeIdentifier(reference?.channelId, "直播频道标识");
    const streamId = optionalIdentifier(reference?.streamId);
    return {
      ...request,
      ...base,
      sourceReference: streamId ? { channelId, streamId } : { channelId },
    };
  }

  private async validateUrl(value: string): Promise<URL> {
    const url = await validatePushUrl(value, {
      allowedOrigins: [...this.allowedOrigins],
      trustedLocalOrigins: [...this.trustedLocalOrigins],
      resolveAddresses: this.resolveAddresses,
    });
    if (!this.resolveRedirectChain) return url;
    const redirects = await this.resolveRedirectChain(url.toString());
    if (redirects.length > MAX_REDIRECTS) {
      throw new PushServiceError("PUSH_REDIRECT_LIMIT", "Push 重定向次数超过限制。", undefined);
    }
    const chain = [url.toString(), ...redirects];
    return validatePushRedirectChain(chain, {
      allowedOrigins: [...this.allowedOrigins],
      trustedLocalOrigins: [...this.trustedLocalOrigins],
      resolveAddresses: this.resolveAddresses,
    });
  }

  private addRecent(record: PushRecentRecord): void {
    this.recentValue = [record, ...this.recentValue.filter((item) => item.id !== record.id)].slice(0, MAX_RECENT);
  }

  private updateRecent(id: string, patch: Partial<PushRecentRecord> & Pick<PushRecentRecord, "status">): PushRecentRecord {
    const previous = this.recentValue.find((item) => item.id === id);
    const next: PushRecentRecord = {
      id,
      type: previous?.type ?? "fixture",
      title: previous?.title ?? "Push 请求",
      status: patch.status,
      requestedBy: previous?.requestedBy ?? "localhost",
      createdAt: previous?.createdAt ?? this.now(),
      sessionId: patch.sessionId === undefined ? previous?.sessionId ?? null : patch.sessionId,
      error: patch.error === undefined ? previous?.error ?? null : patch.error,
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.requestedBy ? { requestedBy: patch.requestedBy } : {}),
      ...(patch.createdAt ? { createdAt: patch.createdAt } : {}),
    };
    this.addRecent(next);
    return cloneRecent(next);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackRequest(request)) {
        writeJson(response, { error: "PUSH_LOOPBACK_ONLY", errorCode: "PUSH_LOOPBACK_ONLY" }, 403);
        return;
      }
      const url = new URL(request.url ?? "/", `http://${this.host}`);
      if (request.method !== "POST") {
        writeJson(response, { error: "PUSH_METHOD_UNSUPPORTED", errorCode: "PUSH_METHOD_UNSUPPORTED" }, 405);
        return;
      }
      const body = await readJson(request);
      const requester = this.requesterForOrigin(request);
      if (url.pathname === "/push") {
        const mode = conflictModeValue(body.mode);
        const result = mode
          ? await this.submit(parsePushRequestBody(body, requester), { conflictMode: mode })
          : await this.submit(parsePushRequestBody(body, requester));
        writeJson(response, result.kind === "confirmation-required" ? result : {
          ...result,
          recent: cloneRecent(result.recent),
        }, result.kind === "confirmation-required" ? 202 : 200);
        return;
      }
      if (url.pathname === "/push/confirm") {
        if (body.decision !== "play" && body.decision !== "reject") {
          throw new PushServiceError("PUSH_DECISION_INVALID", "Push 确认决定无效。", undefined);
        }
        const result = await this.confirm(
          stringValue(body.id),
          body.decision,
          conflictModeValue(body.mode),
        );
        writeJson(response, result, 200);
        return;
      }
      if (url.pathname === "/push/cancel") {
        writeJson(response, { recent: this.cancel(stringValue(body.id)) }, 200);
        return;
      }
      writeJson(response, { error: "PUSH_ROUTE_NOT_FOUND", errorCode: "PUSH_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      const mapped = mapPushError(error);
      const status = mapped.code === "PUSH_CONFLICT" ? 409
        : mapped.code === "PUSH_CONFIRMATION_NOT_FOUND" || mapped.code === "PUSH_REQUEST_NOT_FOUND" ? 404
          : 400;
      writeJson(response, { error: mapped.message, errorCode: mapped.code }, status);
    }
  }

  private requesterForOrigin(request: IncomingMessage): PushRequester {
    const rawOrigin = request.headers.origin;
    const origin = typeof rawOrigin === "string" ? normalizeOrigin(rawOrigin) : null;
    return origin && this.trustedLocalOrigins.has(origin) ? "trusted-local" : "localhost";
  }

  private async serializePlayback<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.playbackTail;
    let release: () => void = () => undefined;
    this.playbackTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function parsePushUri(uri: string, requestedBy: PushRequester = "localhost"): PushRequest {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new PushServiceError("PUSH_URI_INVALID", "Push URI 无法解析。", { cause: error });
  }
  if (parsed.protocol !== "push:") throw new PushServiceError("PUSH_URI_INVALID", "只允许 push:// URI。", undefined);
  const type = parsed.hostname as PushRequestType;
  if (!PUSH_REQUEST_TYPES.includes(type)) throw new PushServiceError("PUSH_TYPE_INVALID", "Push 类型不受支持。", undefined);
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeUriPart);
  const title = optionalText(parsed.searchParams.get("title"), 200);
  const base = {
    requestedBy,
    ...(title ? { title } : {}),
  } satisfies PushRequestBase;
  if (type === "url") {
    const url = parsed.searchParams.get("url") ?? segments.join("/");
    if (!url) throw new PushServiceError("PUSH_REQUEST_INVALID", "URL Push 缺少目标地址。", undefined);
    return { ...base, type, url };
  }
  if (type === "source-item") {
    const contentId = parsed.searchParams.get("contentId") ?? segments[1] ?? segments[0] ?? "";
    const sourceId = parsed.searchParams.get("sourceId") ?? segments[0];
    if (!contentId) throw new PushServiceError("PUSH_REQUEST_INVALID", "source-item 缺少内容标识。", undefined);
    const episodeId = parsed.searchParams.get("episodeId") ?? undefined;
    const flag = parsed.searchParams.get("flag") ?? undefined;
    return {
      ...base,
      type,
      sourceReference: {
        contentId,
        ...(sourceId ? { sourceId } : {}),
        ...(episodeId ? { episodeId } : {}),
        ...(flag ? { flag } : {}),
      },
    };
  }
  if (type === "local-file") {
    const itemId = parsed.searchParams.get("itemId") ?? segments[0] ?? "";
    if (!itemId) throw new PushServiceError("PUSH_REQUEST_INVALID", "local-file 缺少媒体标识。", undefined);
    return { ...base, type, localFileReference: { itemId } };
  }
  if (type === "live-channel") {
    const channelId = parsed.searchParams.get("channelId") ?? segments[0] ?? "";
    const streamId = parsed.searchParams.get("streamId") ?? segments[1] ?? undefined;
    if (!channelId) throw new PushServiceError("PUSH_REQUEST_INVALID", "live-channel 缺少频道标识。", undefined);
    return {
      ...base,
      type,
      sourceReference: streamId ? { channelId, streamId } : { channelId },
    };
  }
  const fixtureId = parsed.searchParams.get("fixtureId") ?? segments[0] ?? "";
  if (!fixtureId) throw new PushServiceError("PUSH_REQUEST_INVALID", "fixture 缺少标识。", undefined);
  const url = parsed.searchParams.get("url") ?? undefined;
  return { ...base, type, fixtureId, ...(url ? { url } : {}) };
}

export async function validatePushUrl(
  value: string,
  options: PushUrlValidationOptions = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new PushServiceError("PUSH_URL_INVALID", "Push 地址无法解析。", { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PushServiceError("PUSH_URL_SCHEME_BLOCKED", "Push 地址只允许 HTTP 或 HTTPS。", undefined);
  }
  if (parsed.username || parsed.password) {
    throw new PushServiceError("PUSH_URL_CREDENTIALS_BLOCKED", "Push 地址不得包含凭据。", undefined);
  }
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin).filter(isString));
  const trustedOrigins = new Set((options.trustedLocalOrigins ?? []).map(normalizeOrigin).filter(isString));
  const trustedLocal = trustedOrigins.has(parsed.origin);
  if (allowedOrigins.size > 0 && !allowedOrigins.has(parsed.origin) && !trustedLocal) {
    throw new PushServiceError("PUSH_ORIGIN_BLOCKED", "Push 地址来源不在允许范围内。", undefined);
  }
  const hostname = stripIpv6Brackets(parsed.hostname).toLowerCase();
  if (isLocalHostname(hostname) && !trustedLocal) {
    throw new PushServiceError("PUSH_PRIVATE_ADDRESS_BLOCKED", "Push 地址不得指向未信任的本机或局域网。", undefined);
  }
  const addresses = isIP(hostname) > 0
    ? [hostname]
    : await (options.resolveAddresses ?? resolveHostAddresses)(hostname).catch((error: unknown) => {
        throw new PushServiceError("PUSH_DNS_RESOLUTION_FAILED", "Push 地址域名无法完成安全校验。", { cause: error });
      });
  if (!trustedLocal && addresses.some(isBlockedAddress)) {
    throw new PushServiceError("PUSH_PRIVATE_ADDRESS_BLOCKED", "Push 地址不得指向私有、回环或链路本地地址。", undefined);
  }
  if (addresses.length === 0) throw new PushServiceError("PUSH_DNS_RESOLUTION_FAILED", "Push 地址没有可用解析结果。", undefined);
  return parsed;
}

export async function validatePushRedirectChain(
  chain: readonly string[],
  options: PushUrlValidationOptions = {},
): Promise<URL> {
  if (chain.length === 0 || chain.length > MAX_REDIRECTS + 1) {
    throw new PushServiceError("PUSH_REDIRECT_LIMIT", "Push 重定向次数超过限制。", undefined);
  }
  let previous: URL | null = null;
  let final: URL | null = null;
  for (const value of chain) {
    const current = await validatePushUrl(value, options);
    if (previous && current.origin !== previous.origin) {
      throw new PushServiceError("PUSH_REDIRECT_ORIGIN_BLOCKED", "Push 重定向不得跨越来源。", undefined);
    }
    previous = current;
    final = current;
  }
  if (!final) throw new PushServiceError("PUSH_URL_INVALID", "Push 地址无效。", undefined);
  return final;
}

export function normalizePushHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new PushServiceError("PUSH_HEADERS_INVALID", "Push 请求头格式无效。", undefined);
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const canonical = HEADER_ALLOWLIST.get(key.toLowerCase());
    if (!canonical) throw new PushServiceError("PUSH_HEADER_FORBIDDEN", "Push 请求头不在白名单内。", undefined);
    if (typeof rawValue !== "string" || rawValue.length > 2_048 || /[\r\n]/.test(rawValue)) {
      throw new PushServiceError("PUSH_HEADER_INJECTION", "Push 请求头包含非法内容。", undefined);
    }
    headers[canonical] = rawValue;
  }
  return headers;
}

function normalizeBase(request: PushRequest): PushRequestBase & { headers: Record<string, string> } {
  const title = optionalText(request.title, 200);
  const headers = normalizePushHeaders(request.headers);
  return {
    requestedBy: request.requestedBy,
    ...(title ? { title } : {}),
    headers,
  };
}

function normalizeSourceReference(value: PushSourceReferenceLike): PushSourceReference {
  const sourceId = optionalIdentifier(value?.sourceId);
  const episodeId = optionalIdentifier(value?.episodeId);
  const flag = optionalIdentifier(value?.flag);
  return {
    contentId: normalizeIdentifier(value?.contentId, "来源内容标识"),
    ...(sourceId ? { sourceId } : {}),
    ...(episodeId ? { episodeId } : {}),
    ...(flag ? { flag } : {}),
  };
}

type PushSourceReferenceLike = { contentId?: unknown; sourceId?: unknown; episodeId?: unknown; flag?: unknown } | null | undefined;

function parseSourceReference(value: Record<string, unknown>): PushSourceReference {
  const contentId = normalizeIdentifier(value.contentId, "来源内容标识");
  const sourceId = optionalIdentifier(value.sourceId);
  const episodeId = optionalIdentifier(value.episodeId);
  const flag = optionalIdentifier(value.flag);
  return {
    contentId,
    ...(sourceId ? { sourceId } : {}),
    ...(episodeId ? { episodeId } : {}),
    ...(flag ? { flag } : {}),
  };
}

function parseLocalFileReference(value: Record<string, unknown>): { itemId: string } {
  return { itemId: normalizeIdentifier(value.itemId, "本地媒体标识") };
}

function parseLiveChannelReference(value: Record<string, unknown>): PushLiveChannelReference {
  const channelId = normalizeIdentifier(value.channelId, "直播频道标识");
  const streamId = optionalIdentifier(value.streamId);
  return streamId ? { channelId, streamId } : { channelId };
}

function parsePushRequestBody(body: Record<string, unknown>, requestedBy: PushRequester = "localhost"): PushRequest {
  if (typeof body.uri === "string") return parsePushUri(body.uri, requestedBy);
  const input = isRecord(body.request) ? body.request : body;
  if (!isRecord(input)) throw new PushServiceError("PUSH_REQUEST_INVALID", "Push 请求体无效。", undefined);
  const type = input.type as PushRequestType;
  if (typeof type !== "string" || !PUSH_REQUEST_TYPES.includes(type as PushRequestType)) {
    throw new PushServiceError("PUSH_TYPE_INVALID", "Push 类型不受支持。", undefined);
  }
  const base = {
    requestedBy,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(input.headers !== undefined ? { headers: normalizePushHeaders(input.headers) } : {}),
  } satisfies PushRequestBase;
  if (type === "url") {
    if (typeof input.url !== "string") throw new PushServiceError("PUSH_REQUEST_INVALID", "URL Push 缺少地址。", undefined);
    return { ...base, type, url: input.url };
  }
  if (type === "source-item") {
    if (!isRecord(input.sourceReference)) throw new PushServiceError("PUSH_REQUEST_INVALID", "source-item 缺少引用。", undefined);
    return { ...base, type, sourceReference: parseSourceReference(input.sourceReference) };
  }
  if (type === "local-file") {
    if (!isRecord(input.localFileReference)) throw new PushServiceError("PUSH_REQUEST_INVALID", "local-file 缺少引用。", undefined);
    return { ...base, type, localFileReference: parseLocalFileReference(input.localFileReference) };
  }
  if (type === "live-channel") {
    if (!isRecord(input.sourceReference)) throw new PushServiceError("PUSH_REQUEST_INVALID", "live-channel 缺少引用。", undefined);
    return { ...base, type, sourceReference: parseLiveChannelReference(input.sourceReference) };
  }
  if (typeof input.fixtureId !== "string") throw new PushServiceError("PUSH_REQUEST_INVALID", "fixture 缺少标识。", undefined);
  return {
    ...base,
    type,
    fixtureId: input.fixtureId,
    ...(typeof input.url === "string" ? { url: input.url } : {}),
  };
}

function displayTitle(request: PushRequest): string {
  return request.title?.trim() || (request.type === "live-channel" ? "直播频道" : request.type === "local-file" ? "本地媒体" : "Push 请求");
}

function createPreview(request: PushRequest, createdAt: number): PushConfirmationPreview {
  let targetHost: string | null = null;
  if (request.type === "url" || (request.type === "fixture" && request.url)) {
    try {
      targetHost = new URL(request.url ?? "").hostname;
    } catch {
      targetHost = null;
    }
  }
  return {
    id: randomUUID(),
    type: request.type,
    title: displayTitle(request),
    targetHost,
    requestedBy: request.requestedBy,
    createdAt,
  };
}

function mapPushError(error: unknown): { code: string; message: string } {
  if (error instanceof PushServiceError) return { code: error.code, message: error.message };
  return { code: "PUSH_PLAYBACK_FAILED", message: "Push 播放失败。" };
}

function mapPlaybackError(error: unknown): { code: string; message: string } {
  if (error instanceof PushServiceError) {
    return { code: error.code, message: safePlaybackMessage(error.code) };
  }
  return { code: "PUSH_PLAYBACK_FAILED", message: "Push 播放失败。" };
}

function safePlaybackMessage(code: string): string {
  switch (code) {
    case "PUSH_DISABLED": return "Push 服务已关闭。";
    case "PUSH_CONFLICT": return "当前已有播放会话。";
    case "PUSH_FIXTURE_UNAVAILABLE": return "Push fixture 地址不可用。";
    case "PUSH_PLAYBACK_UNAVAILABLE": return "当前没有可用的播放会话。";
    case "PUSH_SOURCE_UNAVAILABLE": return "Push 来源不可用。";
    case "PUSH_LIVE_UNAVAILABLE": return "直播播放服务不可用。";
    default: return "Push 播放失败。";
  }
}

function readStoredSettings(value: unknown): PersistedPushSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    port: safePort(value.port, DEFAULT_SETTINGS.port),
    confirmationPolicy: value.confirmationPolicy === "allow-trusted-local" ? "allow-trusted-local" : "ask",
    conflictMode: value.conflictMode === "queue" || value.conflictMode === "reject" ? value.conflictMode : "replace",
  };
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new PushServiceError("PUSH_PORT_INVALID", "Push 端口必须是 0 到 65535 的整数。", undefined);
  }
  return value;
}

function safePort(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : fallback;
}

function conflictModeValue(value: unknown): PushConflictMode | undefined {
  return value === "replace" || value === "queue" || value === "reject" ? value : undefined;
}

function normalizeIdentifier(value: unknown, label: string): string {
  const normalized = optionalIdentifier(value);
  if (!normalized) throw new PushServiceError("PUSH_REQUEST_INVALID", `${label}不能为空。`, undefined);
  return normalized;
}

function optionalIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 240 ? normalized : undefined;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return null;
  }
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal";
}

export function isBlockedAddress(value: string): boolean {
  const address = stripIpv6Brackets(value).toLowerCase();
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0)
      || (first === 198 && second >= 18 && second <= 19)
      || first >= 224;
  }
  if (isIP(address) === 6) {
    const mappedIpv4 = mappedIpv4Address(address);
    if (mappedIpv4) return isBlockedAddress(mappedIpv4);
    const compact = address.replace(/^0+:0+:0+:0+:0+:0+:0+:/, "::");
    return address === "::"
      || address === "::1"
      || compact === "::"
      || compact === "::1"
      || address.startsWith("fc")
      || address.startsWith("fd")
      || address.startsWith("fe8")
      || address.startsWith("fe9")
      || address.startsWith("fea")
      || address.startsWith("feb")
      || address.startsWith("ff")
      || address.startsWith("::ffff:127.");
  }
  return false;
}

function mappedIpv4Address(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups || groups.length !== 8 || groups[0] !== "0000" || groups[1] !== "0000" || groups[2] !== "0000"
    || groups[3] !== "0000" || groups[4] !== "0000" || groups[5] !== "ffff") return null;
  const high = Number.parseInt(groups[6]!, 16);
  const low = Number.parseInt(groups[7]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function expandIpv6(address: string): string[] | null {
  const parts = address.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const normalizedTail = [...tail];
  const dotted = normalizedTail.at(-1);
  if (dotted?.includes(".")) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    normalizedTail.splice(-1, 1, ((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  const missing = parts.length === 2 ? 8 - head.length - normalizedTail.length : 0;
  if (missing < 0 || (parts.length === 1 && head.length !== 8)) return null;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...normalizedTail]
    .map((group) => group.padStart(4, "0").toLowerCase());
}

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function cloneSession(value: PushPlaybackSessionSnapshot | null): PushPlaybackSessionSnapshot | null {
  return value ? { ...value } : null;
}

function clonePreview(value: PushConfirmationPreview): PushConfirmationPreview {
  return { ...value };
}

function cloneRecent(value: PushRecentRecord): PushRecentRecord {
  return { ...value, error: value.error ? { ...value.error } : null };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new PushServiceError("PUSH_REQUEST_INVALID", "Push 标识不能为空。", undefined);
  return value.trim();
}

function decodeUriPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new PushServiceError("PUSH_URI_INVALID", "Push URI 编码无效。", { cause: error });
  }
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress?.toLowerCase();
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new PushServiceError("PUSH_BODY_TOO_LARGE", "Push 请求体过大。", undefined);
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new PushServiceError("PUSH_BODY_INVALID", "Push 请求体不是有效 JSON。", { cause: error });
  }
  if (!isRecord(parsed)) throw new PushServiceError("PUSH_BODY_INVALID", "Push 请求体格式无效。", undefined);
  return parsed;
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
