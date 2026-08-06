import { DesktopSpiderClient } from "./desktop-client.js";
import { sourceCapabilitiesForApi } from "./jvm-spiders.js";
import {
  MediaSourceError,
  type CategoryRequest,
  type HomeResult,
  type MediaSource,
  type PlayerRequest,
  type PlayerResult,
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
  unwrapSpiderResponse,
} from "../source/normalizers.js";

export interface JvmMediaSourceOptions {
  api: string;
  client: DesktopSpiderClient;
}

export class JvmMediaSource implements MediaSource {
  public readonly capabilities: SourceCapabilities;
  private readonly api: string;
  private readonly client: DesktopSpiderClient;
  private initialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | null = null;

  public constructor(options: JvmMediaSourceOptions) {
    this.api = options.api;
    this.client = options.client;
    this.capabilities = sourceCapabilitiesForApi(options.api);
  }

  public async init(context: SourceInitContext): Promise<void> {
    this.assertAvailable();
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    const promise = this.initInternal(context);
    this.initPromise = promise.finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async initInternal(context: SourceInitContext): Promise<void> {
    const response = await this.client.init(context.ext ?? "", context.requestTimeoutMs);
    unwrapSpiderResponse(response, "init");
    this.initialized = true;
  }

  public async home(): Promise<HomeResult> {
    this.assertInitialized();
    return normalizeHomeResult(unwrapSpiderResponse(await this.client.homeContent(), "home"));
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    this.assertInitialized();
    const page = request.page ?? 1;
    const response = await this.client.categoryContent(
      request.typeId,
      page,
      request.filter ?? false,
      { ...(request.extend ?? {}) },
    );
    return normalizeVodPage(unwrapSpiderResponse(response, "category"), page);
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    this.assertInitialized();
    const page = request.page ?? 1;
    const response = await this.client.searchContent(request.key, request.quick ?? false, page);
    return normalizeVodPage(unwrapSpiderResponse(response, "search"), page);
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    this.assertInitialized();
    return normalizeVodDetails(unwrapSpiderResponse(await this.client.detailContent(ids), "detail"));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    this.assertInitialized();
    if (!this.capabilities.playback) {
      throw new MediaSourceError(
        "PLAYBACK_UNAVAILABLE",
        `Spider ${this.api} does not provide a full-content playback URL`,
      );
    }
    const response = await this.client.playerContent(
      request.flag,
      request.id,
      [...(request.vipFlags ?? [])],
    );
    return normalizePlayerResult(unwrapSpiderResponse(response, "player"));
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
    if (!this.initialized) {
      throw new MediaSourceError("SOURCE_NOT_INITIALIZED", "Media source is not initialized");
    }
  }
}
