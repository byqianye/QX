import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import type { DownloadBackendKind, DownloadStatus } from "./download-types.js";

export interface DownloadBackendAddInput {
  url: string;
  targetDirectory: string;
  filename: string;
}

export interface DownloadBackendSnapshot {
  backendId: string;
  status: DownloadStatus;
  totalBytes: number | null;
  completedBytes: number | null;
  speed: number | null;
  error: string | null;
}

export interface DownloadBackend {
  readonly kind: DownloadBackendKind;
  readonly available: boolean;
  add(input: DownloadBackendAddInput): Promise<DownloadBackendSnapshot>;
  pause(backendId: string): Promise<DownloadBackendSnapshot>;
  resume(backendId: string): Promise<DownloadBackendSnapshot>;
  cancel(backendId: string): Promise<DownloadBackendSnapshot>;
  retry(backendId: string): Promise<DownloadBackendSnapshot>;
  remove(backendId: string): Promise<DownloadBackendSnapshot>;
  status(backendId: string): Promise<DownloadBackendSnapshot>;
  shutdown(): Promise<void>;
}

export type DownloadErrorCode =
  | "ARIA2_UNAVAILABLE"
  | "ARIA2_RPC_FAILED"
  | "ARIA2_PROCESS_EXITED"
  | "DOWNLOAD_BACKEND_CLOSED"
  | "FAKE_ARIA2_CRASHED";

export class DownloadError extends Error {
  public readonly code: DownloadErrorCode;

  public constructor(code: DownloadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DownloadError";
    this.code = code;
  }
}

export interface FakeDownloadBackendOptions {
  autoComplete?: boolean;
  completeOnStatus?: boolean;
  totalBytes?: number;
}

interface FakeRecord extends DownloadBackendSnapshot {
  url: string;
  targetDirectory: string;
  filename: string;
}

/** Deterministic backend contract used by tests and local packaged E2E. */
export class FakeDownloadBackend implements DownloadBackend {
  public readonly kind = "fake" as const;
  public readonly available = true;
  private readonly autoComplete: boolean;
  private readonly completeOnStatus: boolean;
  private readonly totalBytes: number;
  private readonly records = new Map<string, FakeRecord>();
  private closed = false;
  private crashed = false;

  public constructor(options: FakeDownloadBackendOptions = {}) {
    this.autoComplete = options.autoComplete ?? false;
    this.completeOnStatus = options.completeOnStatus ?? false;
    this.totalBytes = positiveInteger(options.totalBytes, 1_024);
  }

  public async add(input: DownloadBackendAddInput): Promise<DownloadBackendSnapshot> {
    this.ensureUsable();
    const backendId = `fake-${randomUUID()}`;
    const completed = this.autoComplete;
    const record: FakeRecord = {
      backendId,
      status: completed ? "completed" : "downloading",
      totalBytes: this.totalBytes,
      completedBytes: completed ? this.totalBytes : 0,
      speed: completed ? 0 : 256,
      error: null,
      ...input,
    };
    this.records.set(backendId, record);
    return cloneSnapshot(record);
  }

  public async pause(backendId: string): Promise<DownloadBackendSnapshot> {
    const record = this.record(backendId);
    if (record.status === "downloading" || record.status === "starting" || record.status === "queued") {
      record.status = "paused";
      record.speed = 0;
    }
    return cloneSnapshot(record);
  }

  public async resume(backendId: string): Promise<DownloadBackendSnapshot> {
    const record = this.record(backendId);
    if (record.status === "paused" || record.status === "queued" || record.status === "starting") {
      record.status = "downloading";
      record.speed = 256;
      record.error = null;
    }
    return cloneSnapshot(record);
  }

  public async cancel(backendId: string): Promise<DownloadBackendSnapshot> {
    const record = this.record(backendId);
    if (record.status !== "completed" && record.status !== "removed") {
      record.status = "cancelled";
      record.speed = 0;
    }
    return cloneSnapshot(record);
  }

  public async retry(backendId: string): Promise<DownloadBackendSnapshot> {
    const record = this.record(backendId);
    if (record.status === "failed" || record.status === "cancelled" || record.status === "paused") {
      record.status = this.autoComplete ? "completed" : "downloading";
      record.completedBytes = this.autoComplete ? record.totalBytes : 0;
      record.speed = this.autoComplete ? 0 : 256;
      record.error = null;
    }
    return cloneSnapshot(record);
  }

  public async remove(backendId: string): Promise<DownloadBackendSnapshot> {
    const record = this.record(backendId);
    record.status = "removed";
    record.speed = 0;
    return cloneSnapshot(record);
  }

  public async status(backendId: string): Promise<DownloadBackendSnapshot> {
    this.ensureUsable();
    const record = this.record(backendId);
    if (this.completeOnStatus && record.status === "downloading") {
      record.status = "completed";
      record.completedBytes = record.totalBytes;
      record.speed = 0;
    }
    return cloneSnapshot(record);
  }

  public async shutdown(): Promise<void> {
    if (this.closed) return;
    for (const record of this.records.values()) {
      if (record.status === "downloading" || record.status === "starting" || record.status === "queued") {
        record.status = "paused";
        record.speed = 0;
      }
    }
    this.closed = true;
  }

  /** Test-only deterministic state transitions; never exposed through the UI API. */
  public complete(backendId: string): DownloadBackendSnapshot {
    const record = this.record(backendId);
    record.status = "completed";
    record.completedBytes = record.totalBytes;
    record.speed = 0;
    record.error = null;
    return cloneSnapshot(record);
  }

  /** Test-only crash contract for managed-backend cleanup tests. */
  public crash(): void {
    this.crashed = true;
    for (const record of this.records.values()) {
      if (record.status === "downloading" || record.status === "starting" || record.status === "queued") {
        record.status = "failed";
        record.speed = 0;
        record.error = "FAKE_ARIA2_CRASHED";
      }
    }
  }

  private ensureUsable(): void {
    if (this.closed) throw new DownloadError("DOWNLOAD_BACKEND_CLOSED", "Download backend is closed");
    if (this.crashed) throw new DownloadError("FAKE_ARIA2_CRASHED", "Fake aria2 exited");
  }

  private record(backendId: string): FakeRecord {
    this.ensureUsable();
    const record = this.records.get(backendId);
    if (!record) throw new DownloadError("ARIA2_RPC_FAILED", "Download task is missing in the backend");
    return record;
  }
}

export interface Aria2ProcessPort {
  readonly pid?: number | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type Aria2Spawn = (
  file: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true; stdio: ["ignore", "ignore", "ignore"] },
) => Aria2ProcessPort;

export interface Aria2BackendOptions {
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  runtimeDirectory?: string;
  exists?: (path: string) => boolean;
  spawnProcess?: Aria2Spawn;
  fetchImpl?: typeof fetch;
  rpcPort?: number;
  rpcSecret?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface Aria2JsonRpcResponse {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** Localhost-only aria2 JSON-RPC adapter. The executable is always externally configured. */
export class Aria2Backend implements DownloadBackend {
  public readonly kind = "aria2" as const;
  public readonly available: boolean;
  private readonly executablePath: string | null;
  private readonly spawnProcess: Aria2Spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly rpcPort: number;
  private readonly rpcSecret: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private process: Aria2ProcessPort | undefined;
  private processExited = false;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private readonly requests = new Map<string, DownloadBackendAddInput>();

  public constructor(options: Aria2BackendOptions = {}) {
    this.executablePath = resolveAria2Path(options);
    this.available = this.executablePath !== null;
    this.spawnProcess = options.spawnProcess ?? defaultAria2Spawn;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.rpcPort = positiveInteger(options.rpcPort, randomInt(30_000, 60_000));
    this.rpcSecret = options.rpcSecret ?? randomBytes(32).toString("hex");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 5_000);
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs, 1_000);
  }

  public get path(): string | null {
    return this.executablePath;
  }

  public async add(input: DownloadBackendAddInput): Promise<DownloadBackendSnapshot> {
    await this.ensureStarted();
    const backendId = await this.addUri(input);
    this.requests.set(backendId, { ...input });
    return {
      backendId,
      status: "starting",
      totalBytes: null,
      completedBytes: 0,
      speed: 0,
      error: null,
    };
  }

  public async pause(backendId: string): Promise<DownloadBackendSnapshot> {
    await this.ensureStarted();
    await this.rpc("aria2.pause", [backendId]);
    return this.status(backendId);
  }

  public async resume(backendId: string): Promise<DownloadBackendSnapshot> {
    await this.ensureStarted();
    await this.rpc("aria2.unpause", [backendId]);
    return this.status(backendId);
  }

  public async cancel(backendId: string): Promise<DownloadBackendSnapshot> {
    await this.ensureStarted();
    await this.rpc("aria2.forceRemove", [backendId]);
    return {
      backendId,
      status: "cancelled",
      totalBytes: null,
      completedBytes: null,
      speed: 0,
      error: null,
    };
  }

  public async retry(backendId: string): Promise<DownloadBackendSnapshot> {
    this.resetExitedProcessForExplicitRetry();
    await this.ensureStarted();
    const current = await this.status(backendId).catch(() => null);
    if (current && (current.status === "paused" || current.status === "queued")) {
      await this.rpc("aria2.unpause", [backendId]);
      return this.status(backendId);
    }
    if (current && (current.status === "completed" || current.status === "downloading" || current.status === "starting")) {
      return current;
    }
    const input = this.requests.get(backendId);
    if (!input) throw new DownloadError("ARIA2_RPC_FAILED", "aria2 retry metadata is unavailable");
    await this.rpc("aria2.removeDownloadResult", [backendId]).catch(() => undefined);
    const newBackendId = await this.addUri(input);
    this.requests.delete(backendId);
    this.requests.set(newBackendId, { ...input });
    return {
      backendId: newBackendId,
      status: "starting",
      totalBytes: null,
      completedBytes: 0,
      speed: 0,
      error: null,
    };
  }

  public async remove(backendId: string): Promise<DownloadBackendSnapshot> {
    await this.ensureStarted();
    await this.rpc("aria2.forceRemove", [backendId]);
    return {
      backendId,
      status: "removed",
      totalBytes: null,
      completedBytes: null,
      speed: null,
      error: null,
    };
  }

  public async status(backendId: string): Promise<DownloadBackendSnapshot> {
    await this.ensureStarted();
    const result = await this.rpc("aria2.tellStatus", [backendId, [
      "status",
      "totalLength",
      "completedLength",
      "downloadSpeed",
      "errorMessage",
    ]]);
    if (!isRecord(result)) throw new DownloadError("ARIA2_RPC_FAILED", "aria2 returned an invalid task status");
    return {
      backendId,
      status: mapAria2Status(result.status),
      totalBytes: numberOrNull(result.totalLength),
      completedBytes: numberOrNull(result.completedLength),
      speed: numberOrNull(result.downloadSpeed),
      error: typeof result.errorMessage === "string" && result.errorMessage.length > 0
        ? "ARIA2_DOWNLOAD_FAILED"
        : null,
    };
  }

  public async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const process = this.process;
    if (!process || this.processExited) return;
    await this.rpc("aria2.pauseAll", []).catch(() => undefined);
    await this.rpc("aria2.shutdown", []).catch(() => undefined);
    await waitForProcessExit(process, this.shutdownTimeoutMs, () => this.processExited);
    if (!this.processExited) {
      try {
        process.kill();
      } catch {
        // Shutdown is idempotent; the process may already be gone.
      }
    }
    this.processExited = true;
  }

  private async addUri(input: DownloadBackendAddInput): Promise<string> {
    const result = await this.rpc("aria2.addUri", [[input.url], {
      dir: input.targetDirectory,
      out: input.filename,
      "allow-overwrite": "false",
      "auto-file-renaming": "false",
    }]);
    return stringResult(result, "ARIA2_RPC_FAILED");
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new DownloadError("DOWNLOAD_BACKEND_CLOSED", "Download backend is closed");
    if (!this.executablePath) throw new DownloadError("ARIA2_UNAVAILABLE", "aria2 is not configured; set QX_ARIA2_PATH");
    if (this.process) {
      if (this.processExited) throw new DownloadError("ARIA2_PROCESS_EXITED", "aria2 process exited");
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = Promise.resolve().then(async () => {
      const process = this.spawnProcess(this.executablePath!, [
        "--enable-rpc=true",
        "--rpc-listen-all=false",
        `--rpc-listen-port=${this.rpcPort}`,
        `--rpc-secret=${this.rpcSecret}`,
        "--console-log-level=warn",
        "--log-level=warn",
      ], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      this.process = process;
      this.processExited = false;
      process.on("exit", () => { this.processExited = true; });
      process.on("error", () => { this.processExited = true; });
      await this.waitForRpcReady();
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private resetExitedProcessForExplicitRetry(): void {
    if (this.process && this.processExited) {
      this.process = undefined;
      this.processExited = false;
    }
  }

  private async waitForRpcReady(): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.rpc("aria2.getVersion", []);
        return;
      } catch (error) {
        lastError = error;
        if (this.processExited) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new DownloadError("ARIA2_RPC_FAILED", "aria2 JSON-RPC listener did not become ready");
  }

  private async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    if (!this.process || this.processExited) {
      throw new DownloadError("ARIA2_PROCESS_EXITED", "aria2 process exited");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.rpcPort}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params: [`token:${this.rpcSecret}`, ...params],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as Aria2JsonRpcResponse;
      if (payload.error) throw new Error("aria2 RPC returned an error");
      return payload.result;
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError("ARIA2_RPC_FAILED", "aria2 JSON-RPC request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class UnavailableDownloadBackend implements DownloadBackend {
  public readonly kind = "unavailable" as const;
  public readonly available = false;

  public add(_input: DownloadBackendAddInput): Promise<DownloadBackendSnapshot> {
    return Promise.reject(new DownloadError("ARIA2_UNAVAILABLE", "aria2 is not configured; set QX_ARIA2_PATH"));
  }
  public pause(_backendId: string): Promise<DownloadBackendSnapshot> { return this.unavailable(); }
  public resume(_backendId: string): Promise<DownloadBackendSnapshot> { return this.unavailable(); }
  public cancel(_backendId: string): Promise<DownloadBackendSnapshot> { return this.unavailable(); }
  public retry(_backendId: string): Promise<DownloadBackendSnapshot> { return this.unavailable(); }
  public remove(_backendId: string): Promise<DownloadBackendSnapshot> { return this.unavailable(); }
  public status(_backendId: string): Promise<DownloadBackendSnapshot> { return this.unavailable(); }
  public async shutdown(): Promise<void> {}

  private unavailable(): Promise<DownloadBackendSnapshot> {
    return Promise.reject(new DownloadError("ARIA2_UNAVAILABLE", "aria2 is not configured; set QX_ARIA2_PATH"));
  }
}

export function resolveAria2Path(options: Pick<Aria2BackendOptions, "executablePath" | "env" | "runtimeDirectory" | "exists"> = {}): string | null {
  const exists = options.exists ?? existsSync;
  const configured = options.executablePath?.trim() || options.env?.QX_ARIA2_PATH?.trim() || process.env.QX_ARIA2_PATH?.trim();
  if (configured && exists(configured)) return configured;
  const runtimeDirectory = options.runtimeDirectory?.trim() || options.env?.QX_RUNTIME_DIRECTORY?.trim() || process.env.QX_RUNTIME_DIRECTORY?.trim();
  const bundled = runtimeDirectory ? join(runtimeDirectory, "aria2", "aria2c.exe") : null;
  return bundled && exists(bundled) ? bundled : null;
}

function defaultAria2Spawn(
  file: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true; stdio: ["ignore", "ignore", "ignore"] },
): Aria2ProcessPort {
  return nodeSpawn(file, [...args], options) as ChildProcess as Aria2ProcessPort;
}

function cloneSnapshot(value: DownloadBackendSnapshot): DownloadBackendSnapshot {
  return { ...value };
}

function mapAria2Status(value: unknown): DownloadStatus {
  switch (value) {
    case "active": return "downloading";
    case "waiting": return "queued";
    case "paused": return "paused";
    case "complete": return "completed";
    case "error": return "failed";
    case "removed": return "removed";
    default: return "starting";
  }
}

function stringResult(value: unknown, code: DownloadErrorCode): string {
  if (typeof value !== "string" || value.length === 0) throw new DownloadError(code, "aria2 returned an invalid task id");
  return value;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForProcessExit(
  process: Aria2ProcessPort,
  timeoutMs: number,
  exited: () => boolean,
): Promise<boolean> {
  if (exited()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(exited()), timeoutMs);
    process.on("exit", () => finish(true));
  });
}
