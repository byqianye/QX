import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import type {
  CategoryRequest,
  HomeResult,
  PlayerRequest,
  PlayerResult,
  SearchRequest,
  SourceCapabilities,
  SourceInitContext,
  VodDetail,
  VodPage,
} from "../source/media-source.js";

export interface JsSpiderWorkerOptions {
  script: string;
  scriptName?: string;
  moduleSources?: Readonly<Record<string, string>>;
  allowedOrigins?: readonly string[];
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  maxExecutionMs?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  maxScriptBytes?: number;
  maxModules?: number;
  timeoutMs?: number;
}

export type JsSpiderWorkerState = "new" | "starting" | "ready" | "failed" | "terminated";

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error & { code?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsSpiderWorker {
  private readonly options: JsSpiderWorkerOptions;
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stateValue: JsSpiderWorkerState = "new";
  private startPromise: Promise<SourceCapabilities> | null = null;
  private capabilitiesValue: SourceCapabilities = emptyCapabilities();

  public constructor(options: JsSpiderWorkerOptions) {
    this.options = { ...options };
  }

  public get state(): JsSpiderWorkerState {
    return this.stateValue;
  }

  public get capabilities(): SourceCapabilities {
    return { ...this.capabilitiesValue };
  }

  public async start(context: SourceInitContext): Promise<SourceCapabilities> {
    if (this.stateValue === "terminated") throw codedError("JS_WORKER_TERMINATED", "JavaScript Spider worker is terminated");
    if (this.stateValue === "failed") throw codedError("JS_WORKER_CRASHED", "JavaScript Spider worker has crashed");
    if (this.stateValue === "ready") return this.capabilities;
    if (this.startPromise) return this.startPromise;
    this.stateValue = "starting";
    const promise = this.startInternal(context);
    this.startPromise = promise.finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(context: SourceInitContext): Promise<SourceCapabilities> {
    const worker = new Worker(workerUrl(), workerOptions());
    this.worker = worker;
    worker.on("message", (message: WorkerResponse) => this.resolve(message));
    worker.on("error", (error) => this.failWorker(error));
    worker.on("exit", (code) => {
      if (this.stateValue === "terminated") return;
      if (code !== 0) this.failWorker(codedError("JS_WORKER_CRASHED", `JavaScript Spider worker exited with code ${code}`));
    });
    try {
      const result = await this.call("create", [this.options, context]);
      if (!isRecord(result) || !isRecord(result.capabilities)) {
        throw codedError("JS_WORKER_ERROR", "JavaScript Spider worker returned invalid capabilities");
      }
      this.capabilitiesValue = result.capabilities as unknown as SourceCapabilities;
      this.stateValue = "ready";
      return this.capabilities;
    } catch (error) {
      this.stateValue = "failed";
      await worker.terminate();
      throw error;
    }
  }

  public home(): Promise<HomeResult> {
    return this.call("home") as Promise<HomeResult>;
  }

  public category(request: CategoryRequest): Promise<VodPage> {
    return this.call("category", [request]) as Promise<VodPage>;
  }

  public search(request: SearchRequest): Promise<VodPage> {
    return this.call("search", [request]) as Promise<VodPage>;
  }

  public detail(ids: string[]): Promise<VodDetail[]> {
    return this.call("detail", [ids]) as Promise<VodDetail[]>;
  }

  public player(request: PlayerRequest): Promise<PlayerResult> {
    return this.call("player", [request]) as Promise<PlayerResult>;
  }

  public async destroy(): Promise<void> {
    if (this.stateValue === "terminated") return;
    const worker = this.worker;
    this.stateValue = "terminated";
    if (!worker) return;
    try {
      if (worker.threadId !== -1) await this.call("destroy", [], 1_000).catch(() => undefined);
    } finally {
      this.rejectPending(codedError("JS_WORKER_TERMINATED", "JavaScript Spider worker is terminated"));
      await worker.terminate();
      this.worker = undefined;
    }
  }

  private call(operation: string, args: unknown[] = [], timeoutMs = this.options.timeoutMs ?? this.options.maxExecutionMs ?? 5_000): Promise<unknown> {
    if (!this.worker) return Promise.reject(codedError("JS_WORKER_NOT_INITIALIZED", "JavaScript Spider worker is not initialized"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stateValue = "failed";
        const error = codedError("JS_WORKER_TIMEOUT", `JavaScript Spider worker timed out during ${operation}`);
        reject(error);
        const worker = this.worker;
        this.worker = undefined;
        void worker?.terminate();
        this.rejectPending(error);
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.worker?.postMessage({ id, operation, args });
    });
  }

  private resolve(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(codedError(response.code ?? "JS_WORKER_ERROR", response.message ?? "JavaScript Spider worker failed"));
  }

  private failWorker(error: Error): void {
    if (this.stateValue === "terminated") return;
    this.stateValue = "failed";
    this.rejectPending(codedError("JS_WORKER_CRASHED", error.message));
  }

  private rejectPending(error: Error & { code?: string }): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function workerUrl(): URL {
  const compiled = new URL("./js-spider-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return compiled;
  return new URL("./js-spider-worker.ts", import.meta.url);
}

function workerOptions(): { type: "module"; execArgv?: string[] } {
  const url = workerUrl();
  if (url.pathname.endsWith(".ts")) {
    return { type: "module", execArgv: [...process.execArgv, "--import", "tsx/esm"] };
  }
  return { type: "module" };
}

function emptyCapabilities(): SourceCapabilities {
  return {
    home: false,
    category: false,
    search: false,
    detail: false,
    playback: false,
    localProxy: false,
    filters: false,
    pagination: false,
    engine: "quickjs",
  };
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
