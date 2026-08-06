import { randomUUID } from "node:crypto";

import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { SourceCapabilities } from "../source/media-source.js";
import type { SpiderResponse } from "../spider/rpc.js";
import {
  JellyfinAdapter,
  JellyfinError,
  type JellyfinConfig,
} from "./jellyfin-adapter.js";
import { JellyfinMediaSource } from "./jellyfin-source.js";
import { JellyfinPlaybackSession } from "./jellyfin-playback.js";

export interface JellyfinDesktopClientOptions {
  config: JellyfinConfig;
  requestTimeoutMs?: number;
  adapter?: JellyfinAdapter;
}

/**
 * Adapts the specialized Jellyfin source to the desktop session seam.
 * Playback is always returned through JellyfinPlaybackSession's own
 * credential-injecting LocalProxy; the generic Spider UI never receives the
 * Jellyfin token.
 */
export class JellyfinDesktopClient implements DesktopSpiderClientPort {
  public readonly capabilities: SourceCapabilities;
  private readonly source: JellyfinMediaSource;
  private readonly playback: JellyfinPlaybackSession;
  private initialized = false;
  private destroyed = false;
  private initResponse: SpiderResponse | null = null;
  private initPromise: Promise<SpiderResponse> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private lastError: JellyfinError | null = null;

  public constructor(options: JellyfinDesktopClientOptions) {
    const adapter = options.adapter ?? new JellyfinAdapter(options.config, {
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    this.source = new JellyfinMediaSource(adapter);
    this.playback = new JellyfinPlaybackSession(adapter);
    this.capabilities = { ...this.source.capabilities };
  }

  public get isRunning(): boolean {
    return this.initialized && !this.destroyed;
  }

  public get pid(): number | null {
    return null;
  }

  public get error(): JellyfinError | null {
    return this.lastError;
  }

  public async init(_ext: string, _timeoutMs?: number): Promise<SpiderResponse> {
    if (this.destroyed) return Promise.reject(new JellyfinError("JELLYFIN_DESTROYED", "Jellyfin source is destroyed."));
    if (this.initialized && this.initResponse) return this.initResponse;
    if (this.initPromise) return this.initPromise;
    const promise = this.initInternal();
    this.initPromise = promise.finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  public async homeContent(_filter = false, _timeoutMs?: number): Promise<SpiderResponse> {
    return this.call(async () => {
      const result = await this.source.home();
      return {
        list: result.items.map((item) => item.raw),
        class: result.categories.map((category) => category.raw ?? {
          type_id: category.id,
          type_name: category.name,
        }),
      };
    });
  }

  public async categoryContent(
    typeId: string,
    page: number,
    _filter = false,
    extend: Record<string, string> = {},
    _timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.call(async () => {
      const result = await this.source.category({ typeId, page, extend });
      return { list: result.items.map((item) => item.raw), page: result.page };
    });
  }

  public async searchContent(
    key: string,
    _quick = false,
    page = 1,
    _timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.call(async () => {
      const result = await this.source.search({ key, page });
      return { list: result.items.map((item) => item.raw), page: result.page };
    });
  }

  public async detailContent(ids: string[], _timeoutMs?: number): Promise<SpiderResponse> {
    return this.call(async () => {
      const result = await this.source.detail([...ids]);
      return { list: result.map((item) => item.raw) };
    });
  }

  public async playerContent(
    _flag: string,
    id: string,
    _vipFlags: string[] = [],
    _timeoutMs?: number,
  ): Promise<SpiderResponse> {
    return this.call(async () => {
      const state = await this.playback.load(id);
      if (!state.source) throw new JellyfinError("JELLYFIN_PLAYBACK_UNAVAILABLE", "Jellyfin playback source is unavailable.");
      return { parse: 0, url: state.source.url, header: {} };
    });
  }

  public async stopPlayback(): Promise<void> {
    await this.playback.close();
  }

  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.destroyInternal().finally(() => {
      this.destroyPromise = null;
    });
    return this.destroyPromise;
  }

  private async initInternal(): Promise<SpiderResponse> {
    try {
      await this.source.init({ sourceId: "jellyfin" });
      if (this.destroyed) throw new JellyfinError("JELLYFIN_DESTROYED", "Jellyfin source is destroyed.");
      this.initialized = true;
      this.lastError = null;
      const response = successResponse({ initialized: true });
      this.initResponse = response;
      return response;
    } catch (error) {
      this.initialized = false;
      return this.failure(error);
    }
  }

  private async call(action: () => Promise<Record<string, unknown>>): Promise<SpiderResponse> {
    try {
      this.assertInitialized();
      return successResponse(await action());
    } catch (error) {
      return this.failure(error);
    }
  }

  private async destroyInternal(): Promise<void> {
    this.destroyed = true;
    this.initialized = false;
    this.initResponse = null;
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    await this.playback.close();
    await this.source.destroy();
    this.initialized = false;
  }

  private assertInitialized(): void {
    if (this.destroyed) throw new JellyfinError("JELLYFIN_DESTROYED", "Jellyfin source is destroyed.");
    if (!this.initialized) throw new JellyfinError("JELLYFIN_NOT_INITIALIZED", "Jellyfin source is not initialized.");
  }

  private failure(error: unknown): SpiderResponse {
    const safe = error instanceof JellyfinError
      ? error
      : new JellyfinError("JELLYFIN_RUNTIME_ERROR", "Jellyfin source request failed.");
    this.lastError = safe;
    return {
      id: randomUUID(),
      ok: false,
      error: { code: safe.code, message: safe.message },
    };
  }
}

function successResponse(result: unknown): SpiderResponse {
  return { id: randomUUID(), ok: true, result };
}
