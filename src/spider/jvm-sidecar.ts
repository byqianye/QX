import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  createSpiderRequest,
  parseSpiderResponseLine,
  type SpiderMethod,
  type SpiderResponse,
} from "./rpc.js";

export interface JvmSidecarOptions {
  javaExecutable: string;
  hostJar: string;
  spiderJar: string;
  spiderClass: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

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
  private state: "new" | "starting" | "running" | "stopped" = "new";
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private destroyRequested = false;
  private terminationRequested = false;

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

  public get stderr(): string {
    return this.stderrBuffer;
  }

  public async start(): Promise<void> {
    if (this.state === "running") return;
    if (this.state !== "new") throw new Error("JVM sidecar cannot be restarted");

    this.state = "starting";
    this.destroyRequested = false;
    this.terminationRequested = false;
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
      this.rejectPending(new Error(`JVM sidecar exited (code=${code ?? "none"}, signal=${signal ?? "none"})`));
      this.rejectReady?.(new Error("JVM sidecar exited before ready"));
      this.resolveReady = null;
      this.rejectReady = null;
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await waitWithTimeout(this.readyPromise, this.options.startupTimeoutMs, "JVM sidecar startup timeout");
      this.state = "running";
    } catch (error) {
      this.terminate(toError(error));
      await this.waitForExit();
      throw error;
    }
  }

  public request(
    method: SpiderMethod,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    if (!this.isRunning || !this.child) throw new Error("JVM sidecar is not running");
    if (this.destroyRequested || this.terminationRequested) {
      throw new Error("JVM sidecar is shutting down");
    }

    const request = createSpiderRequest(method, params, randomUUID());
    return new Promise<SpiderResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const error = new Error(`JVM sidecar request timeout: ${method}`);
        error.name = "JvmSidecarTimeoutError";
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

  public async destroy(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }

    if (this.isRunning && !this.destroyRequested && !this.terminationRequested) {
      try {
        await this.request("destroy", {});
      } catch (error) {
        this.terminate(toError(error));
      }
    }

    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && !child.killed) child.kill();
    await this.waitForExit();
    this.rejectPending(new Error("JVM sidecar destroyed"));
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
      this.fail(new Error(`JVM sidecar emitted invalid JSON: ${String(error)}`));
      return;
    }

    if (isRecord(value) && value.type === "ready") {
      if (value.protocol !== "jvm-spider-rpc/1") {
        this.fail(new Error("JVM sidecar emitted an unsupported protocol"));
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
      this.fail(toError(error));
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      this.fail(new Error(`JVM sidecar returned an unknown response id: ${response.id}`));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (pending.method === "destroy") this.destroyRequested = true;
    pending.resolve(response);
  }

  private fail(error: Error): void {
    this.terminate(error);
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
