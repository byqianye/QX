import { routeSpiderApi, type SpiderResponse } from "./rpc.js";
import { JvmSidecar, type JvmSidecarOptions, type JvmSidecarState } from "./jvm-sidecar.js";
import { JvmEngineError } from "./jvm-errors.js";
import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import { sourceCapabilitiesForApi } from "./jvm-spiders.js";
import type { SourceCapabilities } from "../source/media-source.js";

export interface JvmSpiderSessionBinding {
  configSource: string;
  siteKey: string;
  sessionId: string;
  api: string;
  spiderJar: string;
  spiderClass: string;
}

export interface DesktopSpiderClientOptions extends JvmSidecarOptions {
  api: string;
  binding?: JvmSpiderSessionBinding;
}

/**
 * Desktop-facing Spider seam for the JVM-native engine.
 *
 * The desktop caller owns only this session. Sidecar startup, RPC dispatch,
 * timeout termination, and process destruction remain behind the seam.
 */
export class DesktopSpiderClient implements DesktopSpiderClientPort {
  private readonly api: string;
  private readonly sidecar: JvmSidecar;
  public readonly binding: JvmSpiderSessionBinding | undefined;
  public readonly capabilities: SourceCapabilities;
  private initialized = false;
  private initResponse: SpiderResponse | null = null;
  private initPromise: Promise<SpiderResponse> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private destroyRequested = false;

  public constructor(options: DesktopSpiderClientOptions) {
    const engine = routeSpiderApi(options.api);
    if (engine !== "java") {
      throw new Error(
        `Desktop Spider client requires a JVM-native API: ${options.api}`,
      );
    }

    const { api, binding, ...sidecarOptions } = options;
    this.api = api;
    this.capabilities = sourceCapabilitiesForApi(api);
    this.binding = binding;
    this.sidecar = new JvmSidecar(sidecarOptions);
  }

  public get isRunning(): boolean {
    return this.sidecar.isRunning;
  }

  public get pid(): number | null {
    return this.sidecar.pid;
  }

  public get status(): JvmSidecarState {
    return this.sidecar.status;
  }

  public get lastError(): JvmEngineError | null {
    return this.sidecar.lastError;
  }

  public async init(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    if (this.destroyRequested) {
      throw new JvmEngineError("JVM_SIDECAR_DESTROYED", `Desktop Spider is destroyed: ${this.api}`);
    }
    if (this.initialized && this.sidecar.isRunning && this.initResponse) return this.initResponse;
    if (this.initPromise) return this.initPromise;

    const promise = this.initInternal(ext, timeoutMs);
    this.initPromise = promise.finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async initInternal(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    await this.sidecar.start();
    if (this.destroyRequested) {
      throw new JvmEngineError("JVM_SIDECAR_DESTROYED", `Desktop Spider is destroyed: ${this.api}`);
    }
    try {
      const response = timeoutMs === undefined
        ? await this.sidecar.init(ext)
        : await this.sidecar.init(ext, timeoutMs);
      this.initialized = response.ok;
      this.initResponse = response.ok ? response : null;
      return response;
    } catch (error) {
      this.initialized = false;
      this.initResponse = null;
      throw error;
    }
  }

  public homeContent(filter = false, timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.homeContent(filter)
      : this.sidecar.homeContent(filter, timeoutMs);
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

  public searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.searchContent(key, quick, page)
      : this.sidecar.searchContent(key, quick, page, timeoutMs);
  }

  public detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.detailContent(ids)
      : this.sidecar.detailContent(ids, timeoutMs);
  }

  public playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return timeoutMs === undefined
      ? this.sidecar.playerContent(flag, id, vipFlags)
      : this.sidecar.playerContent(flag, id, vipFlags, timeoutMs);
  }

  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    this.destroyRequested = true;
    this.initialized = false;
    this.initResponse = null;
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // Preserve the initialization error for the caller that initiated init().
      }
    }
    await this.sidecar.destroy();
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.sidecar.isRunning) {
      if (this.sidecar.lastError) throw this.sidecar.lastError;
      throw new JvmEngineError(
        "JVM_SPIDER_NOT_INITIALIZED",
        `Desktop Spider is not initialized: ${this.api}`,
      );
    }
  }
}
