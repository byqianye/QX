import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { SourceCapabilities } from "../source/media-source.js";
import type { SpiderResponse } from "./rpc.js";
import { PythonEngineError } from "./python-errors.js";
import { PythonSidecar, type PythonSidecarOptions } from "./python-sidecar.js";

export interface PythonDesktopClientOptions extends PythonSidecarOptions {
  api: string;
}

export class PythonDesktopClient implements DesktopSpiderClientPort {
  public readonly capabilities: SourceCapabilities = {
    home: true,
    category: true,
    search: true,
    detail: true,
    playback: true,
    localProxy: true,
    filters: true,
    pagination: true,
    engine: "python",
  };
  private readonly sidecar: PythonSidecar;
  private initialized = false;
  private initResponse: SpiderResponse | null = null;
  private initPromise: Promise<SpiderResponse> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  public constructor(options: PythonDesktopClientOptions) {
    const { api: _api, ...sidecarOptions } = options;
    this.sidecar = new PythonSidecar(sidecarOptions);
  }

  public get isRunning(): boolean {
    return this.sidecar.isRunning;
  }

  public get pid(): number | null {
    return this.sidecar.pid;
  }

  public get lastError(): PythonEngineError | null {
    return this.sidecar.lastError;
  }

  public init(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    if (this.destroyed) return Promise.reject(new PythonEngineError("PYTHON_DESTROYED", "Python client is destroyed"));
    if (this.initialized && this.initResponse) return Promise.resolve(this.initResponse);
    if (this.initPromise) return this.initPromise;
    const promise = this.initInternal(ext, timeoutMs);
    const tracked = promise.finally(() => {
      this.initPromise = null;
    });
    this.initPromise = tracked;
    return tracked;
  }

  private async initInternal(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    await this.sidecar.start();
    const response = timeoutMs === undefined
      ? await this.sidecar.init(ext)
      : await this.sidecar.init(ext, timeoutMs);
    this.initialized = response.ok;
    this.initResponse = response.ok ? response : null;
    return response;
  }

  public homeContent(filter = false, timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined ? this.sidecar.homeContent(filter) : this.sidecar.homeContent(filter, timeoutMs);
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.categoryContent(typeId, page, filter, extend)
      : this.sidecar.categoryContent(typeId, page, filter, extend, timeoutMs);
  }

  public searchContent(key: string, quick = false, page = 1, timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.searchContent(key, quick, page)
      : this.sidecar.searchContent(key, quick, page, timeoutMs);
  }

  public detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined ? this.sidecar.detailContent(ids) : this.sidecar.detailContent(ids, timeoutMs);
  }

  public playerContent(flag: string, id: string, vipFlags: string[] = [], timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.playerContent(flag, id, vipFlags)
      : this.sidecar.playerContent(flag, id, vipFlags, timeoutMs);
  }

  public localProxy(request: Record<string, unknown>, timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.localProxy(request)
      : this.sidecar.localProxy(request, timeoutMs);
  }

  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    const promise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    this.destroyPromise = promise;
    return promise;
  }

  private async destroyInternal(): Promise<void> {
    this.destroyed = true;
    this.initialized = false;
    this.initResponse = null;
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // Preserve initialization error for its caller.
      }
    }
    await this.sidecar.destroy();
  }

  private assertInitialized(): void {
    if (this.destroyed) throw new PythonEngineError("PYTHON_DESTROYED", "Python client is destroyed");
    if (!this.initialized || !this.sidecar.isRunning) {
      throw this.sidecar.lastError ?? new PythonEngineError("PYTHON_NOT_INITIALIZED", "Python client is not initialized");
    }
  }
}
