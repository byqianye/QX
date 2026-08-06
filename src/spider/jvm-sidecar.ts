import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  createSpiderRequest,
  parseSpiderResponseLine,
  type SpiderMethod,
  type SpiderResponse,
} from "./rpc.js";
import { validateJvmSpiderArtifact } from "./jvm-artifact.js";
import {
  JvmEngineError,
  JvmSidecarTimeoutError,
} from "./jvm-errors.js";

export interface JvmSidecarOptions {
  javaExecutable: string;
  hostJar: string;
  spiderJar: string;
  spiderClass: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export type JvmSidecarState = "new" | "starting" | "running" | "stopped";

interface PendingResponse {
  method: SpiderMethod;
  resolve: (response: SpiderResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class JvmSidecar {
  private readonly options: Required<JvmSidecarOptions>;
  private readonly pending = new Map<string, PendingResponse>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: JvmSidecarState = "new";
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private destroyRequested = false;
  private terminationRequested = false;
  private startPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private lastErrorValue: JvmEngineError | null = null;

  public constructor(options: JvmSidecarOptions) {
    this.options = {
      requestTimeoutMs: 1_000,
      startupTimeoutMs: 5_000,
      ...options,
    };
  }

  public get isRunning(): boolean {
    return this.state === "running"
      && !this.terminationRequested
      && this.child !== null
      && this.child.exitCode === null
      && !this.child.killed;
  }

  public get pid(): number | null {
    return this.child?.pid ?? null;
  }

  public get status(): JvmSidecarState {
    return this.state;
  }

  public get stderr(): string {
    return this.stderrBuffer;
  }

  public get lastError(): JvmEngineError | null {
    return this.lastErrorValue;
  }

  public start(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.state !== "new") throw new JvmEngineError(
      "JVM_SIDECAR_START_FAILED",
      "JVM sidecar cannot be restarted after it has stopped",
    );

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    try {
      validateJvmSpiderArtifact(this.options.spiderJar);
    } catch (error) {
      if (error instanceof JvmEngineError) this.lastErrorValue = error;
      throw error;
    }

    this.state = "starting";
    this.destroyRequested = false;
    this.terminationRequested = false;
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

    const child = spawn(
      this.options.javaExecutable,
      [
        "-cp",
        this.options.hostJar,
        "com.qx.spike.host.JvmSpiderHost",
        "--spider",
        this.options.spiderJar,
        "--class",
        this.options.spiderClass,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.state = "stopped";
      const expectedTermination = this.terminationRequested || this.destroyRequested;
      const exitError = this.lastErrorValue ?? new JvmEngineError(
        expectedTermination ? "JVM_SIDECAR_DESTROYED" : "JVM_SIDECAR_CRASHED",
        `JVM sidecar exited (code=${code ?? "none"}, signal=${signal ?? "none"})`,
      );
      if (!expectedTermination) this.lastErrorValue = exitError;
      this.rejectPending(exitError);
      this.rejectReady?.(exitError);
      this.resolveReady = null;
      this.rejectReady = null;
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await waitWithTimeout(this.readyPromise, this.options.startupTimeoutMs, "JVM sidecar startup timeout");
      this.state = "running";
    } catch (error) {
      const normalized = toJvmError(error, "JVM_SIDECAR_START_FAILED");
      this.lastErrorValue = normalized;
      this.terminate(normalized);
      await this.waitForExit();
      throw normalized;
    }
  }

  public request(
    method: SpiderMethod,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    if (!this.isRunning || !this.child) {
      if (this.lastErrorValue) throw this.lastErrorValue;
      if (this.terminationRequested || this.state === "stopped") {
        throw new JvmEngineError("JVM_SIDECAR_DESTROYED", "JVM sidecar is not running");
      }
      throw new JvmEngineError("JVM_SPIDER_NOT_INITIALIZED", "JVM sidecar is not running");
    }
    if (this.destroyRequested || this.terminationRequested) {
      throw new JvmEngineError("JVM_SIDECAR_DESTROYED", "JVM sidecar is shutting down");
    }

    const request = createSpiderRequest(method, params, randomUUID());
    return new Promise<SpiderResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const error = new JvmSidecarTimeoutError(method);
        this.lastErrorValue = error;
        reject(error);
        this.terminate(error);
      }, timeoutMs);
      this.pending.set(request.id, { method, resolve, reject, timer });

      try {
        this.child?.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(toError(error));
      }
    });
  }

  public init(ext: string, timeoutMs = this.options.requestTimeoutMs): Promise<SpiderResponse> {
    return this.request("init", { ext }, timeoutMs);
  }

  public homeContent(filter = false, timeoutMs = this.options.requestTimeoutMs): Promise<SpiderResponse> {
    return this.request("home", { filter }, timeoutMs);
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    return this.request("category", { typeId, page, filter, extend }, timeoutMs);
  }

  public detailContent(
    ids: string[],
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    return this.request("detail", { ids }, timeoutMs);
  }

  public searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    return this.request("search", { key, quick, page }, timeoutMs);
  }

  public playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    return this.request("player", { flag, id, vipFlags }, timeoutMs);
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Preserve the startup error for the caller that initiated start().
      }
    }

    const child = this.child;
    if (!child) {
      this.state = "stopped";
      this.terminationRequested = true;
      return;
    }

    if (this.isRunning && !this.destroyRequested && !this.terminationRequested) {
      try {
        await this.request("destroy", {});
      } catch (error) {
        const normalized = toJvmError(error, "JVM_SIDECAR_CRASHED");
        this.lastErrorValue ??= normalized;
        this.terminate(normalized);
      }
    }

    this.terminationRequested = true;
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && !child.killed) child.kill();
    await this.waitForExit();
    this.rejectPending(new JvmEngineError("JVM_SIDECAR_DESTROYED", "JVM sidecar destroyed"));
    this.child = null;
    this.state = "stopped";
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
      this.fail(new JvmEngineError(
        "JVM_SIDECAR_PROTOCOL_ERROR",
        `JVM sidecar emitted invalid JSON: ${String(error)}`,
        { cause: error },
      ));
      return;
    }

    if (isRecord(value) && value.type === "ready") {
      if (value.protocol !== "jvm-spider-rpc/1") {
        this.fail(new JvmEngineError(
          "JVM_SIDECAR_PROTOCOL_ERROR",
          "JVM sidecar emitted an unsupported protocol",
        ));
        return;
      }
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }

    let response: SpiderResponse;
    try {
      response = parseSpiderResponseLine(line);
    } catch (error) {
      this.fail(new JvmEngineError(
        "JVM_SIDECAR_PROTOCOL_ERROR",
        toError(error).message,
        { cause: error },
      ));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      this.fail(new JvmEngineError(
        "JVM_SIDECAR_PROTOCOL_ERROR",
        `JVM sidecar returned an unknown response id: ${response.id}`,
      ));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (pending.method === "destroy") this.destroyRequested = true;
    pending.resolve(response);
  }

  private fail(error: Error): void {
    const normalized = toJvmError(error, "JVM_SIDECAR_CRASHED");
    const reason = this.lastErrorValue ?? normalized;
    this.lastErrorValue = reason;
    this.terminate(reason);
  }

  private terminate(reason: Error): void {
    this.terminationRequested = true;
    this.rejectPending(reason);
    this.rejectReady?.(reason);
    this.resolveReady = null;
    this.rejectReady = null;
    if (this.child && this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async waitForExit(): Promise<void> {
    if (!this.exitPromise) return;
    try {
      await waitWithTimeout(this.exitPromise, 1_000, "JVM sidecar exit timeout");
    } catch {
      if (this.child && this.child.exitCode === null && !this.child.killed) this.child.kill();
    }
  }
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toJvmError(error: unknown, fallbackCode: "JVM_SIDECAR_START_FAILED" | "JVM_SIDECAR_CRASHED"): JvmEngineError {
  if (error instanceof JvmEngineError) return error;
  return new JvmEngineError(fallbackCode, toError(error).message, { cause: error });
}
