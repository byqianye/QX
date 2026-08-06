import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  createSpiderRequest,
  parseSpiderResponseLine,
  type SpiderMethod,
  type SpiderResponse,
} from "./rpc.js";
import { PythonEngineError } from "./python-errors.js";

export interface PythonSidecarOptions {
  pythonExecutable: string;
  script: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export type PythonSidecarState = "new" | "starting" | "running" | "stopped";

interface PendingResponse {
  method: SpiderMethod;
  resolve: (response: SpiderResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PythonSidecar {
  private readonly options: PythonSidecarOptions & {
    args: readonly string[];
    requestTimeoutMs: number;
    startupTimeoutMs: number;
  };
  private readonly pending = new Map<string, PendingResponse>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stateValue: PythonSidecarState = "new";
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
  private lastErrorValue: PythonEngineError | null = null;
  private scriptPath: string | undefined;
  private scriptTempDirectory: string | undefined;

  public constructor(options: PythonSidecarOptions) {
    this.options = {
      args: [],
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 10_000,
      ...options,
    };
  }

  public get isRunning(): boolean {
    return this.stateValue === "running"
      && !this.terminationRequested
      && this.child !== null
      && this.child.exitCode === null
      && !this.child.killed;
  }

  public get pid(): number | null {
    return this.child?.pid ?? null;
  }

  public get status(): PythonSidecarState {
    return this.stateValue;
  }

  public get stderr(): string {
    return this.stderrBuffer;
  }

  public get lastError(): PythonEngineError | null {
    return this.lastErrorValue;
  }

  public start(): Promise<void> {
    if (this.stateValue === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.stateValue !== "new") {
      return Promise.reject(new PythonEngineError(
        "PYTHON_START_FAILED",
        "Python sidecar cannot be restarted after it has stopped",
      ));
    }
    const promise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  private async startInternal(): Promise<void> {
    let script: string;
    try {
      script = await this.resolveScript();
      const stats = statSync(script);
      if (!stats.isFile()) throw new Error("Python Spider script is not a file");
    } catch (error) {
      const normalized = new PythonEngineError(
        "PYTHON_SCRIPT_NOT_FOUND",
        `Python Spider script could not be read: ${this.options.script}`,
        { cause: error },
      );
      this.lastErrorValue = normalized;
      throw normalized;
    }

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
      child = spawn(this.options.pythonExecutable, [script, ...this.options.args], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? {} : { detached: true }),
      });
    } catch (error) {
      const normalized = new PythonEngineError(
        "PYTHON_START_FAILED",
        `Unable to start Python sidecar: ${toError(error).message}`,
        { cause: error },
      );
      this.lastErrorValue = normalized;
      this.stateValue = "stopped";
      throw normalized;
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${sanitizeDiagnostic(chunk)}`.slice(-64 * 1024);
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.stateValue = "stopped";
      const expected = this.terminationRequested || this.destroyRequested;
      const error = this.lastErrorValue ?? new PythonEngineError(
        expected ? "PYTHON_DESTROYED" : "PYTHON_CRASHED",
        `Python sidecar exited (code=${code ?? "none"}, signal=${signal ?? "none"})`,
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
      await waitWithTimeout(this.readyPromise, this.options.startupTimeoutMs, "Python sidecar startup timeout");
      this.stateValue = "running";
    } catch (error) {
      const normalized = normalizePythonError(error, "PYTHON_START_FAILED");
      this.lastErrorValue = normalized;
      await this.terminate(normalized);
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
      if (this.lastErrorValue) return Promise.reject(this.lastErrorValue);
      return Promise.reject(new PythonEngineError(
        this.terminationRequested ? "PYTHON_DESTROYED" : "PYTHON_NOT_INITIALIZED",
        "Python sidecar is not running",
      ));
    }
    if (this.terminationRequested || this.destroyRequested) {
      return Promise.reject(new PythonEngineError("PYTHON_DESTROYED", "Python sidecar is shutting down"));
    }
    const request = createSpiderRequest(method, params, randomUUID());
    return new Promise<SpiderResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const error = new PythonEngineError("PYTHON_TIMEOUT", `Python sidecar request timeout: ${method}`);
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
        const normalized = new PythonEngineError("PYTHON_CRASHED", toError(error).message, { cause: error });
        this.lastErrorValue = normalized;
        reject(normalized);
        void this.terminate(normalized);
      }
    });
  }

  public init(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    return this.request("init", { ext }, timeoutMs);
  }

  public homeContent(filter = false, timeoutMs?: number): Promise<SpiderResponse> {
    return this.request("home", { filter }, timeoutMs);
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.request("category", { typeId, page, filter, extend }, timeoutMs);
  }

  public searchContent(key: string, quick = false, page = 1, timeoutMs?: number): Promise<SpiderResponse> {
    return this.request("search", { key, quick, page }, timeoutMs);
  }

  public detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse> {
    return this.request("detail", { ids }, timeoutMs);
  }

  public playerContent(flag: string, id: string, vipFlags: string[] = [], timeoutMs?: number): Promise<SpiderResponse> {
    return this.request("player", { flag, id, vipFlags }, timeoutMs);
  }

  public localProxy(params: Record<string, unknown>, timeoutMs?: number): Promise<SpiderResponse> {
    return this.request("localProxy", params, timeoutMs);
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    const promise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    this.destroyPromise = promise;
    return promise;
  }

  private async destroyInternal(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Preserve startup error for its caller.
      }
    }
    const child = this.child;
    if (!child) {
      this.terminationRequested = true;
      this.stateValue = "stopped";
      await this.cleanupScript();
      return;
    }
    if (this.isRunning && !this.destroyRequested && !this.terminationRequested) {
      try {
        await this.request("destroy", {});
      } catch (error) {
        const normalized = normalizePythonError(error, "PYTHON_CRASHED");
        this.lastErrorValue ??= normalized;
        await this.terminate(normalized);
      }
    }
    this.terminationRequested = true;
    await this.terminateProcess(child);
    await this.waitForExit();
    this.rejectPending(new PythonEngineError("PYTHON_DESTROYED", "Python sidecar destroyed"));
    this.child = null;
    this.stateValue = "stopped";
    await this.cleanupScript();
  }

  private async resolveScript(): Promise<string> {
    if (this.scriptPath) return this.scriptPath;
    const reference = this.options.script.trim();
    if (/^https?:\/\//i.test(reference)) {
      let response: Response;
      try {
        response = await fetch(reference, {
          signal: AbortSignal.timeout(this.options.startupTimeoutMs),
        });
      } catch (error) {
        throw new PythonEngineError(
          "PYTHON_SCRIPT_NOT_FOUND",
          `Unable to download Python Spider script: ${reference}`,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new PythonEngineError(
          "PYTHON_SCRIPT_NOT_FOUND",
          `Python Spider script returned HTTP ${response.status}: ${reference}`,
        );
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024) {
        throw new PythonEngineError(
          "PYTHON_SCRIPT_NOT_FOUND",
          `Python Spider script exceeds the 8 MiB limit: ${reference}`,
        );
      }
      const directory = await mkdtemp(join(tmpdir(), "qx-python-spider-"));
      const path = join(directory, "spider.py");
      await writeFile(path, text, "utf8");
      this.scriptTempDirectory = directory;
      this.scriptPath = path;
      return path;
    }
    const path = /^file:\/\//i.test(reference) ? fileURLToPath(reference) : reference;
    this.scriptPath = path;
    return path;
  }

  private async cleanupScript(): Promise<void> {
    const directory = this.scriptTempDirectory;
    this.scriptTempDirectory = undefined;
    this.scriptPath = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private rejectPending(error: Error): void {
    rejectPending(this.pending, error);
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
      this.fail(new PythonEngineError("PYTHON_PROTOCOL_ERROR", "Python sidecar emitted invalid JSON", { cause: error }));
      return;
    }
    if (isRecord(value) && value.type === "ready") {
      if (value.protocol !== "python-spider-rpc/1") {
        this.fail(new PythonEngineError("PYTHON_PROTOCOL_ERROR", "Python sidecar emitted an unsupported protocol"));
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
      this.fail(new PythonEngineError("PYTHON_PROTOCOL_ERROR", toError(error).message, { cause: error }));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.fail(new PythonEngineError("PYTHON_PROTOCOL_ERROR", `Unknown Python response id: ${response.id}`));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (pending.method === "destroy") this.destroyRequested = true;
    pending.resolve(response);
  }

  private fail(error: Error): void {
    const normalized = normalizePythonError(error, "PYTHON_CRASHED");
    this.lastErrorValue = this.lastErrorValue ?? normalized;
    void this.terminate(this.lastErrorValue);
  }

  private async terminate(reason: Error): Promise<void> {
    this.terminationRequested = true;
    this.rejectPending(reason);
    this.rejectReady?.(reason);
    this.resolveReady = null;
    this.rejectReady = null;
    const child = this.child;
    if (child) await this.terminateProcess(child);
  }

  private async terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
      return;
    }
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall back to the direct child when the process group is unavailable.
      }
    }
    child.kill("SIGKILL");
  }

  private async waitForExit(): Promise<void> {
    if (!this.exitPromise) return;
    try {
      await waitWithTimeout(this.exitPromise, 1_000, "Python sidecar exit timeout");
    } catch {
      const child = this.child;
      if (child) child.kill();
    }
  }
}

function normalizePythonError(
  error: unknown,
  fallback: "PYTHON_START_FAILED" | "PYTHON_CRASHED",
): PythonEngineError {
  if (error instanceof PythonEngineError) return error;
  if (isRecord(error) && error.code === "ENOENT") {
    return new PythonEngineError("PYTHON_NOT_FOUND", "Python executable was not found", { cause: error });
  }
  return new PythonEngineError(fallback, toError(error).message, { cause: error });
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|key|auth|password|secret|cookie)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("(?:token|key|auth|password|secret|cookie)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2");
}

function rejectPending(pending: Map<string, PendingResponse>, error: Error): void {
  for (const [id, value] of pending) {
    clearTimeout(value.timer);
    pending.delete(id);
    value.reject(error);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
