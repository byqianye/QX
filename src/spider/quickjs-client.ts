import { randomUUID } from "node:crypto";

import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { SourceCapabilities } from "../source/media-source.js";
import type { SpiderResponse } from "./rpc.js";
import { QuickJsEngine, type QuickJsEngineOptions } from "./quickjs-engine.js";

export interface QuickJsDesktopClientOptions extends Omit<QuickJsEngineOptions, "script"> {
  api: string;
  script: string;
}

export class QuickJsDesktopClient implements DesktopSpiderClientPort {
  public capabilities: SourceCapabilities;
  private readonly engine: QuickJsEngine;
  private initialized = false;
  private initResponse: SpiderResponse | null = null;
  private initPromise: Promise<SpiderResponse> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  public constructor(options: QuickJsDesktopClientOptions) {
    this.engine = new QuickJsEngine(options);
    this.capabilities = emptyCapabilities();
  }

  public get isRunning(): boolean {
    return this.engine.isReady && !this.destroyed;
  }

  public get pid(): number | null {
    return null;
  }

  public get lastError(): Error | null {
    return this.engine.lastError;
  }

  public init(ext: string, timeoutMs?: number): Promise<SpiderResponse> {
    if (this.destroyed) return Promise.reject(new Error("QuickJS client is destroyed"));
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
    await this.engine.init();
    const result = this.engine.hasMethod("init")
      ? await this.engine.call("init", [ext], timeoutMs)
      : { initialized: true };
    this.capabilities = this.engine.capabilities();
    this.initialized = true;
    const response = successResponse(result);
    this.initResponse = response;
    return response;
  }

  public homeContent(filter = false, timeoutMs?: number): Promise<SpiderResponse> {
    return this.callHome(filter, timeoutMs);
  }

  private async callHome(filter: boolean, timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    const method = this.engine.hasMethod("home") ? "home" : "homeVod";
    return successResponse(await this.engine.call(method, [filter], timeoutMs));
  }

  public async categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return successResponse(await this.engine.call(
      "category",
      [typeId, page, filter, { ...extend }],
      timeoutMs,
    ));
  }

  public async searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return successResponse(await this.engine.call("search", [key, quick, page], timeoutMs));
  }

  public async detailContent(ids: string[], timeoutMs?: number): Promise<SpiderResponse> {
    this.assertInitialized();
    return successResponse(await this.engine.call("detail", [[...ids]], timeoutMs));
  }

  public async playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs?: number,
  ): Promise<SpiderResponse> {
    this.assertInitialized();
    return successResponse(await this.engine.call("player", [flag, id, [...vipFlags]], timeoutMs));
  }

  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    this.destroyed = true;
    this.initialized = false;
    this.initResponse = null;
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // Preserve the initialization error for its caller.
      }
    }
    await this.engine.destroy();
  }

  private assertInitialized(): void {
    if (this.destroyed) throw new Error("QuickJS client is destroyed");
    if (!this.initialized || !this.engine.isReady) throw new Error("QuickJS client is not initialized");
  }
}

function successResponse(result: unknown): SpiderResponse {
  return { id: randomUUID(), ok: true, result };
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
