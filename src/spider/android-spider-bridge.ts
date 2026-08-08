import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { normalizeRuntimeError, runtimeErrorMessage, type RuntimeErrorInfo } from "./runtime-errors.js";

export type AndroidSpiderBridgeMethod =
  | "health"
  | "loadJar"
  | "createSpider"
  | "init"
  | "homeContent"
  | "categoryContent"
  | "searchContent"
  | "detailContent"
  | "playerContent"
  | "destroy";

export interface AndroidSpiderBridgeRemoteError {
  code: string;
  message: string;
  diagnostics?: Record<string, unknown>;
}

export interface AndroidSpiderBridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: AndroidSpiderBridgeRemoteError;
}

export interface AndroidSpiderBridgeOptions {
  hostExecutable: string;
  hostArgs?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  siteKey?: string;
  sourceName?: string;
  artifactUrl?: string;
  artifactPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}

export type AndroidSpiderBridgeState = "new" | "starting" | "running" | "stopped";

export class AndroidSpiderBridgeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: RuntimeErrorInfo,
    options?: ErrorOptions,
    public readonly diagnostics?: Readonly<Record<string, unknown>>,
  ) {
    super(message, options);
    this.name = "AndroidSpiderBridgeError";
  }
}

interface PendingResponse {
  method: AndroidSpiderBridgeMethod;
  resolve: (response: AndroidSpiderBridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * @deprecated Legacy Windows child-process bridge retained for pre-APK tests only.
 * The real Android DEX PoC uses AndroidSpiderBridgeClient plus ADB/AndroidDeviceManager.
 */
export class AndroidSpiderBridge {
  private readonly options: Required<Pick<AndroidSpiderBridgeOptions, "hostArgs" | "requestTimeoutMs" | "startupTimeoutMs">> & AndroidSpiderBridgeOptions;
  private readonly pending = new Map<string, PendingResponse>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stateValue: AndroidSpiderBridgeState = "new";
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private terminationRequested = false;
  private destroyRequested = false;
  private lastErrorValue: AndroidSpiderBridgeError | null = null;

  public constructor(options: AndroidSpiderBridgeOptions) {
    this.options = {
      hostArgs: [],
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 5_000,
      ...options,
    };
  }

  public get state(): AndroidSpiderBridgeState { return this.stateValue; }
  public get isRunning(): boolean {
    return this.stateValue === "running"
      && !this.terminationRequested
      && this.child !== null
      && this.child.exitCode === null
      && !this.child.killed;
  }
  public get pid(): number | null { return this.child?.pid ?? null; }
  public get stderr(): string { return this.stderrBuffer; }
  public get lastError(): AndroidSpiderBridgeError | null { return this.lastErrorValue; }

  public start(): Promise<void> {
    if (this.stateValue === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.stateValue !== "new") {
      return Promise.reject(this.error("ANDROID_BRIDGE_START_FAILED", "Android Spider Bridge cannot be restarted after it stopped"));
    }
    const promise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  public health(timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    return this.request("health", {}, timeoutMs);
  }

  public loadJar(jarPath: string, artifactUrl?: string, timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    if (!existsSync(jarPath)) {
      throw this.errorFromMissingPath("artifact_file_missing", jarPath, artifactUrl);
    }
    return this.request("loadJar", { jarPath, ...(artifactUrl ? { artifactUrl } : {}) }, timeoutMs);
  }

  public createSpider(
    api: string,
    siteKey: string,
    expectedClass: string,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<AndroidSpiderBridgeResponse> {
    return this.request("createSpider", { api, siteKey, expectedClass }, timeoutMs);
  }

  public init(ext: string, timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    return this.request("init", { ext }, timeoutMs);
  }

  public homeContent(filter = false, timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    return this.request("homeContent", { filter }, timeoutMs);
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<AndroidSpiderBridgeResponse> {
    return this.request("categoryContent", { typeId, page, filter, extend }, timeoutMs);
  }

  public searchContent(key: string, quick = false, page = 1, timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    return this.request("searchContent", { key, quick, page }, timeoutMs);
  }

  public detailContent(ids: string[], timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    return this.request("detailContent", { ids }, timeoutMs);
  }

  public playerContent(flag: string, id: string, vipFlags: string[] = [], timeoutMs = this.options.requestTimeoutMs): Promise<AndroidSpiderBridgeResponse> {
    return this.request("playerContent", { flag, id, vipFlags }, timeoutMs);
  }

  public request(
    method: AndroidSpiderBridgeMethod,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<AndroidSpiderBridgeResponse> {
    if (!this.isRunning || !this.child) {
      return Promise.reject(this.lastErrorValue ?? this.error(
        this.terminationRequested ? "ANDROID_BRIDGE_DESTROYED" : "ANDROID_BRIDGE_NOT_INITIALIZED",
        "Android Spider Bridge is not running",
      ));
    }
    if (this.destroyRequested || this.terminationRequested) {
      return Promise.reject(this.error("ANDROID_BRIDGE_DESTROYED", "Android Spider Bridge is shutting down"));
    }
    const request = { id: randomUUID(), method, params };
    return new Promise<AndroidSpiderBridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const error = this.error("ANDROID_BRIDGE_TIMEOUT", `Android Spider Bridge request timeout: ${method}`);
        this.lastErrorValue = error;
        reject(error);
        void this.terminate(error);
      }, Math.max(1, timeoutMs));
      this.pending.set(request.id, { method, resolve, reject, timer });
      try {
        this.child?.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        const normalized = this.normalize(error, "ANDROID_BRIDGE_CRASHED");
        this.lastErrorValue = normalized;
        reject(normalized);
        void this.terminate(normalized);
      }
    });
  }

  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    const promise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    this.destroyPromise = promise;
    return promise;
  }

  private async startInternal(): Promise<void> {
    this.stateValue = "starting";
    this.terminationRequested = false;
    this.destroyRequested = false;
    this.lastErrorValue = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.hostExecutable, [...this.options.hostArgs], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const normalized = this.normalize(error, "ANDROID_BRIDGE_HOST_MISSING");
      this.lastErrorValue = normalized;
      this.stateValue = "stopped";
      throw normalized;
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-64 * 1024);
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.stateValue = "stopped";
      const expected = this.terminationRequested || this.destroyRequested;
      const error = this.lastErrorValue ?? this.error(
        expected ? "ANDROID_BRIDGE_DESTROYED" : "ANDROID_BRIDGE_CRASHED",
        `Android Spider Bridge exited (code=${code ?? "none"}, signal=${signal ?? "none"})`,
      );
      if (!expected) this.lastErrorValue = error;
      this.rejectPending(error);
      this.rejectReady?.(error);
      this.resolveReady = null;
      this.rejectReady = null;
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await waitWithTimeout(this.readyPromise, this.options.startupTimeoutMs, "Android Spider Bridge startup timeout");
      this.stateValue = "running";
    } catch (error) {
      const normalized = this.normalize(error, "ANDROID_BRIDGE_START_FAILED");
      this.lastErrorValue = normalized;
      await this.terminate(normalized);
      await this.waitForExit();
      throw normalized;
    }
  }

  private async destroyInternal(): Promise<void> {
    if (this.startPromise) {
      try { await this.startPromise; } catch { /* Preserve the startup error. */ }
    }
    const child = this.child;
    if (!child) {
      this.terminationRequested = true;
      this.stateValue = "stopped";
      return;
    }
    if (this.isRunning && !this.destroyRequested && !this.terminationRequested) {
      try {
        await this.request("destroy", {});
      } catch (error) {
        const normalized = this.normalize(error, "ANDROID_BRIDGE_CRASHED");
        this.lastErrorValue ??= normalized;
        await this.terminate(normalized);
      }
    }
    this.terminationRequested = true;
    await terminateProcess(child);
    await this.waitForExit();
    this.rejectPending(this.error("ANDROID_BRIDGE_DESTROYED", "Android Spider Bridge destroyed"));
    this.child = null;
    this.stateValue = "stopped";
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.fail(this.normalize(error, "ANDROID_BRIDGE_PROTOCOL_ERROR"));
      return;
    }
    if (isRecord(value) && value.type === "ready") {
      if (value.protocol !== "android-spider-rpc/1") {
        this.fail(this.error("ANDROID_BRIDGE_PROTOCOL_ERROR", "Android Spider Bridge emitted an unsupported protocol"));
        return;
      }
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
      this.fail(this.error("ANDROID_BRIDGE_PROTOCOL_ERROR", "Android Spider Bridge response is invalid"));
      return;
    }
    const response: AndroidSpiderBridgeResponse = {
      id: value.id,
      ok: value.ok,
      ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
      ...(isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"
        ? {
            error: {
              code: value.error.code,
              message: value.error.message,
              ...(isRecord(value.error.diagnostics) ? { diagnostics: value.error.diagnostics } : {}),
            },
          }
        : {}),
    };
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.fail(this.error("ANDROID_BRIDGE_PROTOCOL_ERROR", `Unknown Android Bridge response id: ${response.id}`));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (pending.method === "destroy") this.destroyRequested = true;
    pending.resolve(response);
  }

  private fail(error: unknown): void {
    const normalized = error instanceof AndroidSpiderBridgeError ? error : this.normalize(error, "ANDROID_BRIDGE_CRASHED");
    this.lastErrorValue ??= normalized;
    void this.terminate(this.lastErrorValue);
  }

  private async terminate(reason: Error): Promise<void> {
    this.terminationRequested = true;
    this.rejectPending(reason);
    this.rejectReady?.(reason);
    this.resolveReady = null;
    this.rejectReady = null;
    if (this.child) await terminateProcess(this.child);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private error(code: string, message: string): AndroidSpiderBridgeError {
    const details = normalizeRuntimeError(new Error(message), this.diagnosticContext());
    return new AndroidSpiderBridgeError(code, runtimeErrorMessage(details), details);
  }

  private diagnosticContext(rootCause?: string) {
    return {
      runtimeKind: "android-dex",
      ...(this.options.siteKey ? { siteKey: this.options.siteKey } : {}),
      ...(this.options.sourceName ? { sourceName: this.options.sourceName } : {}),
      ...(this.options.artifactUrl ? { artifactUrl: this.options.artifactUrl } : {}),
      ...(this.options.artifactPath ? { artifactPath: this.options.artifactPath } : {}),
      workingDirectory: this.options.cwd ?? process.cwd(),
      ...(this.options.isPackaged === undefined ? {} : { isPackaged: this.options.isPackaged }),
      ...(this.options.resourcesPath ? { resourcesPath: this.options.resourcesPath } : {}),
      ...(rootCause ? { rootCause } : {}),
    };
  }

  private errorFromMissingPath(code: string, path: string, artifactUrl?: string): AndroidSpiderBridgeError {
    const raw = Object.assign(new Error(`Missing path: ${path}`), { code: "ENOENT", syscall: "open", path });
    const details = normalizeRuntimeError(raw, {
      ...this.diagnosticContext(code),
      ...(artifactUrl ? { artifactUrl } : {}),
      artifactPath: path,
    });
    return new AndroidSpiderBridgeError(details.code, runtimeErrorMessage(details), details, { cause: raw });
  }

  private normalize(error: unknown, fallbackCode: string): AndroidSpiderBridgeError {
    if (error instanceof AndroidSpiderBridgeError) return error;
    const rawCode = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
    const details = normalizeRuntimeError(error, this.diagnosticContext(
      fallbackCode === "ANDROID_BRIDGE_HOST_MISSING" || rawCode === "ENOENT" ? "runtime_host_missing" : undefined,
    ));
    return new AndroidSpiderBridgeError(details.code === "runtime_error" ? fallbackCode : details.code, runtimeErrorMessage(details), details, { cause: error });
  }

  private async waitForExit(): Promise<void> {
    if (!this.exitPromise) return;
    try {
      await waitWithTimeout(this.exitPromise, 1_000, "Android Spider Bridge exit timeout");
    } catch {
      if (this.child) await terminateProcess(this.child);
    }
  }
}

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  child.kill("SIGKILL");
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
