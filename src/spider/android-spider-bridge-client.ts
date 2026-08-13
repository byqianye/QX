import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";

import type { AndroidDeviceManagerPort } from "./android-device-manager.js";

export const androidSpiderHostMethods = [
  "health",
  "runtimeInfo",
  "loadJar",
  "resolveClass",
  "setSpiderCredential",
  "clearSpiderCredential",
  "credentialStatus",
  "unloadJar",
  "createSpider",
  "destroySpider",
  "init",
  "homeContent",
  "homeVideoContent",
  "categoryContent",
  "searchContent",
  "detailContent",
  "playerContent",
  "proxy",
  "destroyAll",
] as const;

export type AndroidSpiderHostMethod = (typeof androidSpiderHostMethods)[number];

export interface AndroidSpiderHostErrorPayload {
  code: string;
  message: string;
  stage?: string;
  diagnostics?: Record<string, unknown>;
  debugStack?: string;
}

export interface AndroidSpiderHostResponse<T = unknown> {
  id: string;
  protocolVersion: number;
  success: boolean;
  result?: T;
  error?: AndroidSpiderHostErrorPayload;
}

export interface AndroidSpiderBridgeClientOptions {
  deviceManager: AndroidDeviceManagerPort;
  localPort?: number;
  remotePort?: number;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  operationTimeoutMs?: number;
  artifactRemoteDirectory?: string;
  siteKey?: string;
  sourceName?: string;
  artifactUrl?: string;
  artifactRegistry?: AndroidArtifactRegistry;
}

export interface AndroidArtifactSession {
  sha256: string;
  jarId: string;
  path: string;
  artifactUrl?: string;
  refCount: number;
}

/** Process-wide artifact registry. The Host remains authoritative after a restart. */
export class AndroidArtifactRegistry {
  private readonly entries = new Map<string, AndroidArtifactSession>();
  private readonly pending = new Map<string, Promise<AndroidArtifactSession>>();

  public get(sha256: string): AndroidArtifactSession | undefined {
    return this.entries.get(sha256);
  }

  public set(session: AndroidArtifactSession): void {
    this.entries.set(session.sha256, session);
  }

  public delete(sha256: string): void {
    this.entries.delete(sha256);
  }

  public async load(
    sha256: string,
    loader: () => Promise<AndroidArtifactSession>,
  ): Promise<{ session: AndroidArtifactSession; reused: boolean }> {
    const existing = this.entries.get(sha256);
    if (existing) return { session: existing, reused: true };
    const pending = this.pending.get(sha256);
    if (pending) return { session: await pending, reused: true };
    const promise = loader().then((session) => {
      this.entries.set(sha256, session);
      return session;
    }).finally(() => {
      if (this.pending.get(sha256) === promise) this.pending.delete(sha256);
    });
    this.pending.set(sha256, promise);
    return { session: await promise, reused: false };
  }

  public clear(): void {
    this.entries.clear();
  }
}

export interface AndroidSpiderBridgeRequestOptions {
  signal?: AbortSignal;
}

let nextEmergencyPort = 19_000;
// A freshly started Android process can accept the forwarded TCP connection
// before its RPC loop is ready to answer the first health request. Keep this
// bounded, but cover the cold-boot window observed on the managed AVD.
const HOST_STARTUP_ATTEMPTS = 20;
const HOST_STARTUP_RETRY_DELAY_MS = 500;

export class AndroidSpiderBridgeClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly stage?: string,
    public readonly diagnostics?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AndroidSpiderBridgeClientError";
  }
}

interface PendingRequest {
  method: AndroidSpiderHostMethod;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

interface SessionState {
  jarParams?: Record<string, unknown>;
  jarLocalPath?: string;
  jarId?: string;
  createParams?: Record<string, unknown>;
  spiderId?: string;
  initParams?: Record<string, unknown>;
}

export class AndroidSpiderBridgeClient {
  private readonly options: Required<Pick<AndroidSpiderBridgeClientOptions, "localPort" | "remotePort" | "requestTimeoutMs" | "healthTimeoutMs" | "operationTimeoutMs" | "artifactRemoteDirectory">> & AndroidSpiderBridgeClientOptions;
  private socket: net.Socket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ignoredResponseIds = new Set<string>();
  private receiveBuffer = "";
  private connectPromise: Promise<Record<string, unknown>> | null = null;
  private session: SessionState = {};
  private closed = false;
  private recoveryUsed = false;
  private hostAvailable = false;

  public constructor(options: AndroidSpiderBridgeClientOptions) {
    this.options = {
      localPort: 8765,
      remotePort: 8765,
      requestTimeoutMs: 10_000,
      healthTimeoutMs: 3_000,
      operationTimeoutMs: 15_000,
      artifactRemoteDirectory: "/data/local/tmp",
      ...options,
    };
  }

  public get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && !this.closed;
  }

  public get androidHostAvailable(): boolean {
    return this.hostAvailable && this.isConnected;
  }

  public async connect(): Promise<Record<string, unknown>> {
    if (this.closed) throw this.error("HOST_OFFLINE", "Android Spider Bridge Client is closed", "connect");
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    this.connectPromise = promise;
    return promise;
  }

  public async health(): Promise<Record<string, unknown>> {
    if (!this.isConnected) return this.connect();
    return this.request("health", {}, this.options.healthTimeoutMs) as Promise<Record<string, unknown>>;
  }

  public runtimeInfo(): Promise<unknown> {
    return this.request("runtimeInfo", {});
  }

  public async loadJar(localPath: string, artifactUrl = this.options.artifactUrl): Promise<Record<string, unknown>> {
    const file = await stat(localPath).catch((error: unknown) => {
      throw this.error("ARTIFACT_FILE_MISSING", `Unable to read Spider artifact: ${localPath}`, "loadJar", { localPath }, error);
    });
    if (!file.isFile()) throw this.error("ARTIFACT_FILE_MISSING", `Spider artifact is not a file: ${localPath}`, "loadJar", { localPath });
    const sha256 = await sha256File(localPath);
    const remotePath = `${this.options.artifactRemoteDirectory.replace(/\/+$/u, "")}/qx-spider-${sha256}.jar`;
    const load = this.options.artifactRegistry
      ? await this.options.artifactRegistry.load(sha256, async () => {
        await this.options.deviceManager.push(localPath, remotePath);
        try {
          const result = await this.request("loadJar", {
            sourcePath: remotePath,
            sha256,
            ...(artifactUrl ? { artifactUrl } : {}),
          }) as Record<string, unknown>;
          const remoteSha = typeof result.sha256 === "string" ? result.sha256.toLowerCase() : "";
          if (remoteSha !== sha256) {
            throw this.error("JAR_TRANSFER_HASH_MISMATCH", "Android Host artifact SHA-256 does not match Windows artifact", "loadJar", {
              localPath,
              remotePath,
              expectedSha256: sha256,
              actualSha256: remoteSha || "missing",
            });
          }
          const jarId = typeof result.jarId === "string" ? result.jarId : "";
          if (!jarId) throw this.error("JAR_ID_MISSING", "Android Host did not return a jarId", "loadJar", { sha256 });
          return {
            sha256,
            jarId,
            path: localPath,
            ...(artifactUrl ? { artifactUrl } : {}),
            refCount: 0,
          };
        } finally {
          try {
            await this.options.deviceManager.shell(["rm", "-f", remotePath]);
          } catch {
            // The cached copy is already private to the Host; cleanup is best effort.
          }
        }
      })
      : undefined;
    if (load) {
      this.session.jarParams = { sourcePath: remotePath, sha256, ...(artifactUrl ? { artifactUrl } : {}) };
      this.session.jarLocalPath = localPath;
      this.session.jarId = load.session.jarId;
      return { ...load.session, cacheHit: load.reused, reused: load.reused };
    }
    await this.options.deviceManager.push(localPath, remotePath);
    try {
      const result = await this.request("loadJar", {
        sourcePath: remotePath,
        sha256,
        ...(artifactUrl ? { artifactUrl } : {}),
      }) as Record<string, unknown>;
      const remoteSha = typeof result.sha256 === "string" ? result.sha256.toLowerCase() : "";
      if (remoteSha !== sha256) {
        throw this.error("JAR_TRANSFER_HASH_MISMATCH", "Android Host artifact SHA-256 does not match Windows artifact", "loadJar", {
          localPath,
          remotePath,
          expectedSha256: sha256,
          actualSha256: remoteSha || "missing",
        });
      }
      this.session.jarParams = { sourcePath: remotePath, sha256, ...(artifactUrl ? { artifactUrl } : {}) };
      this.session.jarLocalPath = localPath;
      if (typeof result.jarId === "string") this.session.jarId = result.jarId;
      else delete this.session.jarId;
      return result;
    } finally {
      try {
        await this.options.deviceManager.shell(["rm", "-f", remotePath]);
      } catch {
        // The cached copy is already private to the Host; cleanup is best effort.
      }
    }
  }

  public resolveClass(api: string): Promise<Record<string, unknown>> {
    return this.request("resolveClass", { api, ...(this.session.jarId ? { jarId: this.session.jarId } : {}) }) as Promise<Record<string, unknown>>;
  }

  public setSpiderCredential(provider: "uc", payload: string): Promise<Record<string, unknown>> {
    return this.request("setSpiderCredential", { provider, payload }) as Promise<Record<string, unknown>>;
  }

  public clearSpiderCredential(provider: "uc" = "uc"): Promise<Record<string, unknown>> {
    return this.request("clearSpiderCredential", { provider }) as Promise<Record<string, unknown>>;
  }

  public credentialStatus(provider: "uc" = "uc"): Promise<Record<string, unknown>> {
    return this.request("credentialStatus", { provider }) as Promise<Record<string, unknown>>;
  }

  public async unloadJar(jarId = this.session.jarId ?? ""): Promise<unknown> {
    const result = await this.request("unloadJar", { jarId });
    if (jarId === this.session.jarId) this.session = {};
    return result;
  }

  public async createSpider(api: string, expectedClass: string, siteKey = this.options.siteKey): Promise<Record<string, unknown>> {
    const params = {
      api,
      expectedClass,
      ...(this.session.jarId ? { jarId: this.session.jarId } : {}),
      ...(siteKey ? { siteKey } : {}),
    };
    const result = await this.request("createSpider", params) as Record<string, unknown>;
    this.session.createParams = params;
    if (typeof result.spiderId === "string") this.session.spiderId = result.spiderId;
    else delete this.session.spiderId;
    return result;
  }

  public async destroySpider(spiderId = this.session.spiderId ?? ""): Promise<unknown> {
    const result = await this.request("destroySpider", { spiderId });
    if (spiderId === this.session.spiderId) {
      delete this.session.spiderId;
      delete this.session.createParams;
      delete this.session.initParams;
    }
    return result;
  }

  public async init(ext: unknown): Promise<Record<string, unknown>> {
    const params = {
      ...(this.session.spiderId ? { spiderId: this.session.spiderId } : {}),
      ext,
    };
    const result = await this.request("init", params) as Record<string, unknown>;
    this.session.initParams = params;
    return result;
  }

  public homeContent(filter = false): Promise<unknown> {
    return this.request("homeContent", { spiderId: this.session.spiderId ?? "", filter });
  }

  public homeVideoContent(): Promise<unknown> {
    return this.request("homeVideoContent", { spiderId: this.session.spiderId ?? "" });
  }

  public categoryContent(typeId: string, page = 1, filter = false, extend: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("categoryContent", {
      spiderId: this.session.spiderId ?? "",
      typeId,
      page,
      filter,
      extend,
    });
  }

  public searchContent(keyword: string, quick = false, page = 1): Promise<unknown> {
    return this.request("searchContent", {
      spiderId: this.session.spiderId ?? "",
      keyword,
      quick,
      page,
    });
  }

  public detailContent(ids: readonly string[]): Promise<unknown> {
    return this.request("detailContent", { spiderId: this.session.spiderId ?? "", ids: [...ids] });
  }

  public playerContent(flag: string, id: string, vipFlags: readonly string[] = []): Promise<unknown> {
    return this.request("playerContent", {
      spiderId: this.session.spiderId ?? "",
      flag,
      id,
      vipFlags: [...vipFlags],
    });
  }

  public proxy(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("proxy", { spiderId: this.session.spiderId ?? "", ...params });
  }

  public async destroyAll(): Promise<void> {
    if (this.isConnected) {
      try {
        await this.request("destroyAll", {}, this.options.requestTimeoutMs, false);
      } catch {
        // Host shutdown must not crash Electron.
      }
    }
    this.session = {};
    await this.close();
  }

  public destroy(): Promise<void> {
    return this.destroySession();
  }

  private async destroySession(): Promise<void> {
    const spiderId = this.session.spiderId;
    const jarId = this.session.jarId;
    const sha256 = typeof this.session.jarParams?.sha256 === "string" ? this.session.jarParams.sha256 : undefined;
    if (this.isConnected) {
      try {
        if (spiderId) await this.request("destroySpider", { spiderId }, this.options.requestTimeoutMs, false);
        if (jarId) await this.request("unloadJar", { jarId }, this.options.requestTimeoutMs, false);
      } catch {
        await this.forceDestroySession(spiderId, jarId);
      }
    }
    // The Host has unloaded this session's jar. Do not let the process-wide
    // registry hand a future client a jarId that no longer exists on Host.
    if (sha256) this.options.artifactRegistry?.delete(sha256);
    this.session = {};
    await this.close();
  }

  private async forceDestroySession(spiderId: string | undefined, jarId: string | undefined): Promise<void> {
    if (!spiderId && !jarId) return;
    const rescue = new AndroidSpiderBridgeClient({
      deviceManager: this.options.deviceManager,
      localPort: nextEmergencyPort++,
      remotePort: this.options.remotePort,
      requestTimeoutMs: this.options.requestTimeoutMs,
      healthTimeoutMs: this.options.healthTimeoutMs,
      operationTimeoutMs: this.options.operationTimeoutMs,
      artifactRemoteDirectory: this.options.artifactRemoteDirectory,
    });
    try {
      await rescue.connect();
      if (spiderId) await rescue.request("destroySpider", { spiderId }, this.options.requestTimeoutMs, false);
      if (jarId) await rescue.request("unloadJar", { jarId }, this.options.requestTimeoutMs, false);
    } catch {
      // The Host may be unavailable; the next health/recovery cycle owns cleanup.
    } finally {
      await rescue.close();
    }
  }

  public search(keyword: string, quick = false, page = 1): Promise<unknown> {
    return this.searchContent(keyword, quick, page);
  }

  public detail(ids: readonly string[]): Promise<unknown> {
    return this.detailContent(ids);
  }

  public player(flag: string, id: string, vipFlags: readonly string[] = []): Promise<unknown> {
    return this.playerContent(flag, id, vipFlags);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.hostAvailable = false;
    this.rejectPending(this.error("HOST_OFFLINE", "Android Spider Bridge Client closed", "close"));
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    try {
      await this.options.deviceManager.removeForward(this.options.localPort);
    } catch {
      // Forward cleanup is best effort when the device has gone away.
    }
  }

  public async request(
    method: AndroidSpiderHostMethod,
    params: Record<string, unknown>,
    timeoutMs = this.timeoutFor(method),
    allowRecovery = true,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal, method);
    if (!this.isConnected) await this.connect();
    throwIfAborted(signal, method);
    const requestParams = this.withSessionIds(params);
    try {
      return await this.requestRaw(method, requestParams, timeoutMs, signal);
    } catch (error) {
      if (!allowRecovery
        || !isRecoverable(error)
        || this.options.artifactRegistry !== undefined
        || method === "destroyAll"
        || method === "destroySpider"
        || this.recoveryUsed) throw error;
      this.recoveryUsed = true;
      await this.recoverOnce(signal);
      return this.requestRaw(method, this.withSessionIds(params), timeoutMs, signal);
    }
  }

  private async connectInternal(): Promise<Record<string, unknown>> {
    try {
      await this.options.deviceManager.requireDevice();
      await this.options.deviceManager.forward(this.options.localPort, this.options.remotePort);
      let lastError: unknown;
      for (let attempt = 0; attempt < HOST_STARTUP_ATTEMPTS; attempt += 1) {
        try {
          await this.connectTransport();
          const health = await this.requestRaw("health", {}, this.options.healthTimeoutMs);
          if (!isRecord(health) || (health.status !== "ok" && health.status !== "online")) {
            throw this.error("HOST_OFFLINE", "Android Spider Host health check failed", "health", { health });
          }
          this.hostAvailable = true;
          this.recoveryUsed = false;
          return health;
        } catch (error) {
          lastError = error;
          await this.closeTransport();
          if (!(error instanceof AndroidSpiderBridgeClientError) || error.code !== "HOST_OFFLINE" || attempt === HOST_STARTUP_ATTEMPTS - 1) {
            throw error;
          }
          await delay(HOST_STARTUP_RETRY_DELAY_MS);
        }
      }
      throw lastError ?? this.error("HOST_OFFLINE", "Android Spider Host is not reachable", "connect");
    } catch (error) {
      this.hostAvailable = false;
      await this.closeTransport();
      if (isManagerError(error)) throw error;
      if (error instanceof AndroidSpiderBridgeClientError) throw error;
      throw this.error("HOST_OFFLINE", "Android Spider Host is not reachable", "connect", undefined, error);
    }
  }

  private async connectTransport(): Promise<void> {
    if (this.isConnected) return;
    const socket = new net.Socket();
    this.socket = socket;
    this.receiveBuffer = "";
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer | string) => this.consumeData(socket, String(chunk)));
    socket.on("error", (error: Error) => this.handleSocketFailure(socket, error));
    socket.on("close", () => this.handleSocketFailure(socket, new Error("Android Spider Host socket closed")));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(this.error("HOST_OFFLINE", "Android Spider Host TCP connection timed out", "connect"));
      }, this.options.healthTimeoutMs);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(this.error("HOST_OFFLINE", `Unable to connect to Android Spider Host: ${error.message}`, "connect", undefined, error));
      });
      socket.connect(this.options.localPort, "127.0.0.1");
    });
  }

  private async recoverOnce(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "recover");
    await this.closeTransport();
    try {
      this.options.artifactRegistry?.clear();
      await this.options.deviceManager.stopHost();
    } catch {
      // The process may already be dead.
    }
    try {
      await this.options.deviceManager.startHost();
      await this.options.deviceManager.forward(this.options.localPort, this.options.remotePort);
      await this.connectTransport();
      await this.requestRaw("health", {}, this.options.healthTimeoutMs, signal);
      this.hostAvailable = true;
      if (this.session.jarParams) {
        if (this.session.jarLocalPath) {
          await this.options.deviceManager.push(this.session.jarLocalPath, String(this.session.jarParams.sourcePath));
        }
        const jar = await this.requestRaw("loadJar", this.session.jarParams, this.options.requestTimeoutMs, signal) as Record<string, unknown>;
        if (typeof jar.jarId === "string") this.session.jarId = jar.jarId;
      }
      if (this.session.createParams) {
        const created = await this.requestRaw("createSpider", {
          ...this.session.createParams,
          ...(this.session.jarId ? { jarId: this.session.jarId } : {}),
        }, this.options.requestTimeoutMs, signal) as Record<string, unknown>;
        if (typeof created.spiderId === "string") this.session.spiderId = created.spiderId;
      }
      if (this.session.initParams) {
        this.session.initParams = {
          ...this.session.initParams,
          ...(this.session.spiderId ? { spiderId: this.session.spiderId } : {}),
        };
        await this.requestRaw("init", this.session.initParams, this.options.operationTimeoutMs, signal);
      }
    } catch (error) {
      await this.closeTransport();
      if (error instanceof AndroidSpiderBridgeClientError) throw error;
      throw this.error("HOST_OFFLINE", "Android Spider Host recovery failed", "recover", undefined, error);
    }
  }

  private requestRaw(
    method: AndroidSpiderHostMethod,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(this.error("HOST_OFFLINE", "Android Spider Host socket is unavailable", method));
    if (signal?.aborted) return Promise.reject(this.error("ANDROID_BRIDGE_ABORTED", `Android Spider Host request aborted: ${method}`, method));
    const id = randomUUID();
    const request = JSON.stringify({ id, protocolVersion: 1, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        this.ignoredResponseIds.add(id);
        pending?.abortCleanup?.();
        reject(this.error("ANDROID_BRIDGE_TIMEOUT", `Android Spider Host request timed out: ${method}`, method));
      }, Math.max(1, timeoutMs));
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.ignoredResponseIds.add(id);
        reject(this.error("ANDROID_BRIDGE_ABORTED", `Android Spider Host request aborted: ${method}`, method));
      };
      const abortCleanup = signal ? () => signal.removeEventListener("abort", onAbort) : undefined;
      this.pending.set(id, { method, resolve, reject, timer, ...(abortCleanup ? { abortCleanup } : {}) });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        socket.write(`${request}\n`);
      } catch (error) {
        clearTimeout(timer);
        abortCleanup?.();
        this.pending.delete(id);
        reject(this.error("HOST_OFFLINE", `Unable to send Android Spider Host request: ${method}`, method, undefined, error));
      }
    });
  }

  private consumeData(source: net.Socket, chunk: string): void {
    this.receiveBuffer += chunk;
    while (true) {
      const newline = this.receiveBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.receiveBuffer.slice(0, newline).replace(/\r$/u, "");
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      this.consumeLine(source, line);
    }
  }

  private consumeLine(source: net.Socket, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.handleSocketFailure(source, this.error("PROTOCOL_INVALID_JSON", "Android Spider Host returned invalid JSON", "protocol", undefined, error));
      return;
    }
    if (!isRecord(value) || typeof value.id !== "string" || value.protocolVersion !== 1 || typeof value.success !== "boolean") {
      this.handleSocketFailure(source, this.error("PROTOCOL_INVALID_RESPONSE", "Android Spider Host response is invalid", "protocol"));
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending && this.ignoredResponseIds.delete(value.id)) return;
    if (!pending) {
      this.handleSocketFailure(source, this.error("PROTOCOL_UNKNOWN_RESPONSE", `Unknown Android Spider Host response id: ${value.id}`, "protocol"));
      return;
    }
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
    this.pending.delete(value.id);
    if (value.success) {
      pending.resolve(value.result);
      return;
    }
    const error = isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"
      ? new AndroidSpiderBridgeClientError(
        value.error.code,
        value.error.message,
        typeof value.error.stage === "string" ? value.error.stage : pending.method,
        isRecord(value.error.diagnostics) ? value.error.diagnostics : undefined,
      )
      : this.error("HOST_REMOTE_ERROR", `Android Spider Host ${pending.method} failed`, pending.method);
    pending.reject(error);
  }

  private handleSocketFailure(source: net.Socket, error: unknown): void {
    if (!this.socket || this.socket !== source) return;
    this.hostAvailable = false;
    const normalized = error instanceof AndroidSpiderBridgeClientError
      ? error
      : this.error("HOST_OFFLINE", error instanceof Error ? error.message : "Android Spider Host socket closed", "transport", undefined, error);
    const socket = this.socket;
    this.socket = null;
    if (!socket.destroyed) socket.destroy();
    this.rejectPending(normalized);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.abortCleanup?.();
      pending.reject(error);
    }
  }

  private async closeTransport(): Promise<void> {
    this.hostAvailable = false;
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(this.error("HOST_OFFLINE", "Android Spider Host connection closed", "transport"));
    if (socket && !socket.destroyed) socket.destroy();
  }

  private withSessionIds(params: Record<string, unknown>): Record<string, unknown> {
    return {
      ...params,
      ...(this.session.jarId && params.jarId !== undefined ? { jarId: this.session.jarId } : {}),
      ...(this.session.spiderId && params.spiderId !== undefined ? { spiderId: this.session.spiderId } : {}),
    };
  }

  private timeoutFor(method: AndroidSpiderHostMethod): number {
    return method === "health" ? this.options.healthTimeoutMs
      : method === "init" || method === "searchContent" || method === "detailContent" || method === "playerContent"
        ? this.options.operationTimeoutMs
        : this.options.requestTimeoutMs;
  }

  private error(code: string, message: string, stage: string, diagnostics?: Record<string, unknown>, cause?: unknown): AndroidSpiderBridgeClientError {
    return new AndroidSpiderBridgeClientError(code, message, stage, {
      ...(this.options.siteKey ? { siteKey: this.options.siteKey } : {}),
      ...(this.options.sourceName ? { sourceName: this.options.sourceName } : {}),
      ...(this.options.artifactUrl ? { artifactUrl: this.options.artifactUrl } : {}),
      ...diagnostics,
    }, cause === undefined ? undefined : { cause });
  }
}

function throwIfAborted(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) {
    throw new AndroidSpiderBridgeClientError("ANDROID_BRIDGE_ABORTED", `Android Spider Host request aborted: ${stage}`, stage);
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

function isRecoverable(error: unknown): boolean {
  if (!(error instanceof AndroidSpiderBridgeClientError)) return false;
  return error.code === "HOST_OFFLINE" || error.code === "ANDROID_BRIDGE_TIMEOUT" || error.code.startsWith("PROTOCOL_");
}

function isManagerError(error: unknown): error is Error & { code: string } {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === "string"
    && (error as unknown as { code: string }).code.startsWith("ANDROID_");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
