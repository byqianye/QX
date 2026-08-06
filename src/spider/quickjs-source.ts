import {
  MediaSourceError,
  type CategoryRequest,
  type HomeResult,
  type MediaSource,
  type PlayerRequest,
  type PlayerResult,
  type ProxyRequest,
  type ProxyResult,
  type SearchRequest,
  type SourceCapabilities,
  type SourceInitContext,
  type VodDetail,
  type VodPage,
} from "../source/media-source.js";
import {
  normalizeHomeResult,
  normalizePlayerResult,
  normalizeVodDetails,
  normalizeVodPage,
} from "../source/normalizers.js";
import { QuickJsEngine, type QuickJsEngineOptions } from "./quickjs-engine.js";

export interface QuickJsMediaSourceOptions extends Omit<QuickJsEngineOptions, "script"> {
  api: string;
  script: string;
}

export class QuickJsMediaSource implements MediaSource {
  public capabilities: SourceCapabilities = emptyCapabilities();
  private readonly engine: QuickJsEngine;
  private initialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | null = null;

  public constructor(options: QuickJsMediaSourceOptions) {
    this.engine = new QuickJsEngine(options);
  }

  public async init(context: SourceInitContext): Promise<void> {
    this.assertAvailable();
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    const promise = this.initInternal(context);
    const tracked = promise.finally(() => {
      this.initPromise = null;
    });
    this.initPromise = tracked;
    return tracked;
  }

  private async initInternal(context: SourceInitContext): Promise<void> {
    await this.engine.init();
    if (this.engine.hasMethod("init")) {
      await this.engine.call("init", [context.ext ?? ""], context.requestTimeoutMs);
    }
    this.capabilities = this.engine.capabilities();
    this.initialized = true;
  }

  public async home(): Promise<HomeResult> {
    this.assertInitialized();
    const method = this.engine.hasMethod("home") ? "home" : "homeVod";
    return normalizeHomeResult(parseResult(await this.engine.call(method, [false])));
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    this.assertInitialized();
    const page = request.page ?? 1;
    return normalizeVodPage(parseResult(await this.engine.call("category", [
      request.typeId,
      page,
      request.filter ?? false,
      { ...(request.extend ?? {}) },
    ])), page);
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    this.assertInitialized();
    const page = request.page ?? 1;
    return normalizeVodPage(parseResult(await this.engine.call("search", [
      request.key,
      request.quick ?? false,
      page,
    ])), page);
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    this.assertInitialized();
    return normalizeVodDetails(parseResult(await this.engine.call("detail", [[...ids]])));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    this.assertInitialized();
    return normalizePlayerResult(parseResult(await this.engine.call("player", [
      request.flag,
      request.id,
      [...(request.vipFlags ?? [])],
    ])));
  }

  public async localProxy(request: ProxyRequest): Promise<ProxyResult> {
    this.assertInitialized();
    const raw = parseResult(await this.engine.call("localProxy", [{
      url: request.url,
      method: request.method ?? "GET",
      headers: { ...(request.headers ?? {}) },
      ...(request.body === undefined ? {} : {
        body: typeof request.body === "string"
          ? request.body
          : new TextDecoder().decode(request.body),
      }),
      timeoutMs: request.timeoutMs,
    }]));
    return normalizeProxyResult(raw, request.url);
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initialized = false;
    await this.engine.destroy();
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new MediaSourceError("SOURCE_DESTROYED", "Media source is destroyed");
  }

  private assertInitialized(): void {
    this.assertAvailable();
    if (!this.initialized) throw new MediaSourceError("SOURCE_NOT_INITIALIZED", "Media source is not initialized");
  }
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

function parseResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeProxyResult(value: unknown, fallbackUrl: string): ProxyResult {
  if (!isRecord(value)) {
    throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "QuickJS localProxy result must be an object");
  }
  const bodyValue = value.body;
  const body = typeof bodyValue === "string"
    ? new TextEncoder().encode(bodyValue)
    : Array.isArray(bodyValue)
      ? Uint8Array.from(bodyValue.filter((item): item is number => typeof item === "number"))
      : undefined;
  return {
    url: typeof value.url === "string" ? value.url : fallbackUrl,
    headers: headerRecord(value.headers ?? value.header),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(body ? { body } : {}),
  };
}

function headerRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
