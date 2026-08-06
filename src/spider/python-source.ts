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
import type { PythonDesktopClient } from "./python-client.js";

export interface PythonMediaSourceOptions {
  api: string;
  client: PythonDesktopClient;
}

export class PythonMediaSource implements MediaSource {
  public readonly capabilities: SourceCapabilities;
  private readonly client: PythonDesktopClient;
  private initialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | null = null;

  public constructor(options: PythonMediaSourceOptions) {
    this.client = options.client;
    this.capabilities = options.client.capabilities;
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
    const response = await this.client.init(context.ext ?? "", context.requestTimeoutMs);
    unwrap(response, "init");
    this.initialized = true;
  }

  public async home(): Promise<HomeResult> {
    this.assertInitialized();
    return normalizeHomeResult(unwrap(await this.client.homeContent(), "home"));
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    this.assertInitialized();
    const page = request.page ?? 1;
    return normalizeVodPage(unwrap(await this.client.categoryContent(
      request.typeId,
      page,
      request.filter ?? false,
      { ...(request.extend ?? {}) },
    ), "category"), page);
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    this.assertInitialized();
    const page = request.page ?? 1;
    return normalizeVodPage(unwrap(await this.client.searchContent(request.key, request.quick ?? false, page), "search"), page);
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    this.assertInitialized();
    return normalizeVodDetails(unwrap(await this.client.detailContent(ids), "detail"));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    this.assertInitialized();
    return normalizePlayerResult(unwrap(await this.client.playerContent(
      request.flag,
      request.id,
      [...(request.vipFlags ?? [])],
    ), "player"));
  }

  public async localProxy(request: ProxyRequest): Promise<ProxyResult> {
    this.assertInitialized();
    const response = await this.client.localProxy({
      url: request.url,
      method: request.method ?? "GET",
      headers: { ...(request.headers ?? {}) },
      ...(request.body === undefined ? {} : {
        body: typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
      }),
    }, request.timeoutMs);
    const value = unwrap(response, "localProxy");
    if (!isRecord(value)) throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "Python localProxy result must be an object");
    return {
      url: typeof value.url === "string" ? value.url : request.url,
      headers: headerRecord(value.headers ?? value.header),
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      ...(typeof value.body === "string" ? { body: new TextEncoder().encode(value.body) } : {}),
    };
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initialized = false;
    await this.client.destroy();
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new MediaSourceError("SOURCE_DESTROYED", "Media source is destroyed");
  }

  private assertInitialized(): void {
    this.assertAvailable();
    if (!this.initialized) throw new MediaSourceError("SOURCE_NOT_INITIALIZED", "Media source is not initialized");
  }
}

function unwrap(response: { ok: boolean; result?: unknown; error?: { code: string; message: string } }, operation: string): unknown {
  if (response.ok) return response.result;
  throw new MediaSourceError(
    response.error?.code ?? "PYTHON_SPIDER_ERROR",
    response.error?.message ?? `Python Spider ${operation} failed`,
  );
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
