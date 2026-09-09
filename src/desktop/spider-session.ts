import { randomUUID } from "node:crypto";

import { inspectImport, ImportTrustStore, type ImportAssessment } from "../config/trust.js";
import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import type { DesktopSpiderClientPort } from "./spider-client-port.js";
import {
  sourceCapabilitiesForApi,
  type JvmSpiderDefinition,
} from "../spider/jvm-spiders.js";
import type { SpiderResponse } from "../spider/rpc.js";
import type { SpiderRuntime } from "../spider/runtime-types.js";
import { resolveDesktopSourceBinding, type DesktopSourceBinding } from "./source-router.js";
import {
  MediaSourceError,
  type CategoryRequest,
  type HomeResult,
  type MediaSource,
  type PlayerRequest,
  type QxPlayerResult,
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
import { validatePlaybackSource } from "./playback.js";
import type { SourceHealthRegistry, HealthOperation } from "../health/source-health.js";
import { type SubtitleTrack } from "../subtitles.js";
import { serializeFongMiExt } from "../config/fongmi.js";
import { normalizeRuntimeError, runtimeErrorMessage } from "../spider/runtime-errors.js";

export type DesktopSpiderSessionStatus =
  | "confirmation_required"
  | "idle"
  | "initializing"
  | "loading"
  | "ready"
  | "error"
  | "destroyed";

export type DesktopSpiderPlaybackState =
  | {
      available: false;
      label: string;
      message: string;
    }
  | {
      available: true;
      label: string;
      message: string;
      parse: number;
      url: string;
      headers: Record<string, string>;
      playUrl?: string;
      jx?: number;
      format?: string;
      flag?: string;
      jxFrom?: string;
      sourceKey?: string;
      sourceName?: string;
      episodeId?: string;
      subtitles?: SubtitleTrack[];
      danmaku?: unknown;
    };

export interface DesktopSpiderView {
  source: string;
  api: string | null;
  status: DesktopSpiderSessionStatus;
  warning: string | null;
  error: { code: string; message: string } | null;
  sidecarRunning: boolean;
  playback: DesktopSpiderPlaybackState;
  capabilities?: SourceCapabilities;
}

export interface DesktopSpiderSessionOptions {
  source: string;
  config: TvBoxConfig;
  trustStore: ImportTrustStore;
  assessment?: ImportAssessment;
  health?: SourceHealthRegistry;
  createClient: (
    site: TvBoxSite,
    context?: DesktopSpiderClientContext,
  ) => DesktopSpiderClientPort | Promise<DesktopSpiderClientPort>;
  createRuntime?: (
    site: TvBoxSite,
    context: DesktopSpiderClientContext,
  ) => SpiderRuntime | Promise<SpiderRuntime>;
  requestTimeoutMs?: number;
}

export interface DesktopSpiderClientContext {
  sourceId: string;
  siteKey: string;
  sessionId: string;
  binding: DesktopSourceBinding;
  definition?: JvmSpiderDefinition;
}

const NO_PLAYBACK: DesktopSpiderPlaybackState = {
  available: false,
  label: "Douban：无正片播放源",
  message: "Douban 当前仅提供元数据/详情，未提供可直接播放的正片地址。",
};

const PLAYABLE_PENDING: DesktopSpiderPlaybackState = {
  available: false,
  label: "Playable source",
  message: "Select a title and resolve its playback URL",
};

const PLAYBACK_PROXY_REQUIRED: DesktopSpiderPlaybackState = {
  available: false,
  label: "需要 LocalProxy",
  message: "该地址需要 LocalProxy 才能播放。",
};

export class DesktopSpiderSession implements MediaSource {
  private readonly options: DesktopSpiderSessionOptions;
  private readonly sessionId = randomUUID();
  private assessment: ImportAssessment;
  private client: DesktopSpiderClientPort | undefined;
  private runtime: SpiderRuntime | undefined;
  private activeDefinition: JvmSpiderDefinition | undefined;
  private activeCapabilities: SourceCapabilities | undefined;
  private activeSiteKey: string | undefined;
  private activeSiteName: string | undefined;
  private viewState: DesktopSpiderView;

  public constructor(options: DesktopSpiderSessionOptions) {
    this.options = options;
    this.assessment = options.assessment
      ?? inspectImport(options.source, options.config, options.trustStore);
    this.viewState = {
      source: options.source,
      api: null,
      status: this.assessment.requiresConfirmation ? "confirmation_required" : "idle",
      warning: this.assessment.requiresConfirmation ? this.assessment.warning : null,
      error: null,
      sidecarRunning: false,
      playback: NO_PLAYBACK,
    };
  }

  public get importAssessment(): ImportAssessment {
    return this.assessment;
  }

  public get capabilities(): SourceCapabilities {
    if (this.activeCapabilities) return this.activeCapabilities;
    if (this.activeDefinition) return this.activeDefinition.capabilities;
    return sourceCapabilitiesForApi(this.viewState.api ?? firstSiteApi(this.options.config));
  }

  public get view(): DesktopSpiderView {
    return {
      ...this.viewState,
      error: this.viewState.error ? { ...this.viewState.error } : null,
      playback: clonePlayback(this.viewState.playback),
      capabilities: { ...this.capabilities },
    };
  }

  public confirmImport(): void {
    this.assertNotDestroyed();
    this.options.trustStore.trustAssessment(this.assessment);
    this.assessment = {
      ...this.assessment,
      requiresConfirmation: false,
      lastTrustedAt: Date.now(),
    };
    this.viewState.status = "idle";
    this.viewState.warning = null;
    this.viewState.error = null;
  }

  public async open(siteKey: string, ext: string): Promise<SpiderResponse> {
    this.assertNotDestroyed();
    if (this.assessment.requiresConfirmation) {
      throw new Error(`Import confirmation required for source: ${this.options.source}`);
    }
    if (this.client || this.runtime) throw new Error("Desktop Spider session is already open");

    const site = this.findSite(siteKey);
    const api = site.api;
    const binding = resolveDesktopSourceBinding(this.options.config, site, this.options.source);
    if (!binding) {
      throw this.fail(
        `Unsupported desktop Spider source: ${String(api)}`,
        "UNSUPPORTED_SPIDER_ENGINE",
      );
    }

    this.viewState.api = typeof api === "string" ? api : null;
    this.activeSiteKey = siteKey;
    this.activeSiteName = typeof site.name === "string" && site.name.trim() ? site.name.trim() : siteKey;
    this.activeDefinition = binding.definition;
    this.activeCapabilities = binding.capabilities;
    this.viewState.playback = binding.capabilities.playback ? PLAYABLE_PENDING : NO_PLAYBACK;
    this.viewState.status = "initializing";
    this.viewState.warning = null;
    this.viewState.error = null;

    try {
      const clientContext: DesktopSpiderClientContext = {
        sourceId: this.options.source,
        siteKey,
        sessionId: this.sessionId,
        binding,
        ...(binding.definition ? { definition: binding.definition } : {}),
      };
      const initExt = ext.trim() ? ext : serializeFongMiExt(site.ext);
      if (this.options.createRuntime) {
        this.runtime = await this.options.createRuntime(site, clientContext);
        await this.runtime.init(site, {
          sourceId: this.options.source,
          siteKey,
          ...(typeof api === "string" ? { api } : {}),
          ext: initExt,
        });
        this.activeCapabilities = this.runtime.capabilities;
        this.viewState.sidecarRunning = false;
        this.viewState.status = "ready";
        return successResponse({ initialized: true });
      }
      this.client = await this.options.createClient(site, clientContext);
      const init = () => this.client?.init(initExt, this.options.requestTimeoutMs)
        ?? Promise.reject(new Error("Desktop Spider client is unavailable"));
      const response = this.options.health && this.activeSiteKey
        ? await this.options.health.track(this.activeSiteKey, "init", init, (value) => (
          value.ok ? undefined : new Error(value.error?.message ?? "Spider initialization failed")
        ))
        : await init();
      if (this.client.capabilities) this.activeCapabilities = this.client.capabilities;
      this.viewState.sidecarRunning = this.client.isRunning;
      if (!response.ok) {
        this.setRpcError(response);
        await this.destroyClient();
        return response;
      }
      this.viewState.status = "ready";
      return response;
    } catch (error) {
      this.setThrownError(error);
      await this.destroyClient();
      throw error;
    }
  }

  public homeContent(filter = false, timeoutMs = this.options.requestTimeoutMs): Promise<SpiderResponse> {
    if (this.runtime) return this.invokeRuntime("home", () => this.runtime!.home(filter));
    return this.invoke(undefined, (client) => client.homeContent(filter, timeoutMs));
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    if (this.runtime) return this.invokeRuntime("category", () => this.runtime!.category({
      typeId,
      page,
      filter,
      extend,
    }));
    return this.invoke(undefined, (client) => client.categoryContent(typeId, page, filter, extend, timeoutMs));
  }

  public searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    if (this.runtime) return this.invokeRuntime("search", () => this.runtime!.search({ key, quick, page }));
    return this.invoke(undefined, (client) => client.searchContent(key, quick, page, timeoutMs));
  }

  public detailContent(
    ids: string[],
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    this.viewState.playback = this.capabilities.playback ? PLAYABLE_PENDING : NO_PLAYBACK;
    if (this.runtime) return this.invokeRuntime("detail", () => this.runtime!.detail(ids));
    return this.invoke("detail", (client) => client.detailContent(ids, timeoutMs));
  }

  public async playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    if (!this.capabilities.playback) {
      throw this.fail(
        "The current Spider does not provide a full-content playback URL",
        "PLAYBACK_UNAVAILABLE",
      );
    }

    const response = this.runtime
      ? await this.invokeRuntime("player", () => this.runtime!.player({ flag, id, vipFlags }))
      : await this.invoke("player", (client) => client.playerContent(flag, id, vipFlags, timeoutMs));
    if (!response.ok) return response;

    if (isAuthRequiredPlayerResult(response.result)) {
      const authError = {
        code: "SPIDER_AUTH_REQUIRED",
        message: response.result.message ?? "当前来源需要配置 UC 登录信息",
      };
      const authResponse: SpiderResponse = { id: response.id, ok: false, error: authError };
      this.viewState.playback = playbackUnavailableFor(authError.code, authError.message);
      this.setRpcError(authResponse);
      return authResponse;
    }

    try {
      const sourceKey = this.activeSiteKey ?? this.options.source;
      const playback = playbackFrom(response.result, {
        sourceKey,
        sourceName: this.activeSiteName ?? sourceKey,
        episodeId: id,
      });
      const validation = validatePlaybackSource({
        parse: playback.parse,
        url: playback.url,
        headers: playback.headers,
      }, { allowHeaders: true, allowedParse: [0, 1] });
      if (validation) {
        this.viewState.playback = playbackUnavailableFor(validation.code, validation.message);
        const rejectedResponse: SpiderResponse = {
          id: response.id,
          ok: false,
          error: validation,
        };
        this.setRpcError(rejectedResponse);
        return rejectedResponse;
      }
      this.viewState.playback = playback;
    } catch (error) {
      const invalidError = {
        code: "PLAYBACK_INVALID_RESPONSE",
        message: error instanceof Error ? error.message : String(error),
      };
      const invalidResponse: SpiderResponse = {
        id: response.id,
        ok: false,
        error: invalidError,
      };
      this.viewState.playback = playbackUnavailableFor(invalidError.code, invalidError.message);
      this.setRpcError(invalidResponse);
      return invalidResponse;
    }
    return response;
  }

  public async stopPlayback(): Promise<void> {
    await this.client?.stopPlayback?.();
  }

  public retrySourceHealth(): void {
    if (this.activeSiteKey) this.options.health?.retry(this.activeSiteKey);
  }

  public async init(context: SourceInitContext): Promise<void> {
    const siteKey = context.siteKey ?? firstSiteKey(this.options.config);
    if (!siteKey) throw new MediaSourceError("SPIDER_SITE_NOT_FOUND", "Spider site key is required");
    const site = this.findSite(siteKey);
    const ext = context.ext ?? serializeFongMiExt(site.ext);
    const response = await this.open(siteKey, ext);
    if (!response.ok) {
      throw new MediaSourceError(
        response.error?.code ?? "SPIDER_RPC_ERROR",
        response.error?.message ?? "Spider initialization failed",
      );
    }
  }

  public async home(): Promise<HomeResult> {
    return normalizeHomeResult(unwrapSpiderResponse(await this.homeContent(), "home"));
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    const page = request.page ?? 1;
    return normalizeVodPage(
      unwrapSpiderResponse(
        await this.categoryContent(
          request.typeId,
          page,
          request.filter ?? false,
          { ...(request.extend ?? {}) },
        ),
        "category",
      ),
      page,
    );
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    const page = request.page ?? 1;
    return normalizeVodPage(
      unwrapSpiderResponse(
        await this.searchContent(request.key, request.quick ?? false, page),
        "search",
      ),
      page,
    );
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    return normalizeVodDetails(unwrapSpiderResponse(await this.detailContent(ids), "detail"));
  }

  public async player(request: PlayerRequest): Promise<QxPlayerResult> {
    const response = await this.playerContent(
      request.flag,
      request.id,
      [...(request.vipFlags ?? [])],
    );
    const sourceKey = this.activeSiteKey ?? this.options.source;
    return normalizePlayerResult(unwrapSpiderResponse(response, "player"), {
      sourceKey,
      sourceName: this.activeSiteName ?? sourceKey,
      episodeId: request.id,
    });
  }

  public async destroy(): Promise<void> {
    if (this.viewState.status === "destroyed") return;
    await this.destroyClient();
    this.viewState.status = "destroyed";
    this.viewState.sidecarRunning = false;
  }

  private async invoke(
    healthOperation: HealthOperation | undefined,
    action: (client: DesktopSpiderClientPort) => Promise<SpiderResponse>,
  ): Promise<SpiderResponse> {
    const client = this.assertConnected();
    this.viewState.status = "loading";
    this.viewState.error = null;
    try {
      const run = () => action(client);
      const response = this.options.health && healthOperation && this.activeSiteKey
        ? await this.options.health.track(this.activeSiteKey, healthOperation, run, (value) => (
          value.ok ? undefined : new Error(value.error?.message ?? `Spider ${healthOperation} failed`)
        ))
        : await run();
      this.viewState.sidecarRunning = client.isRunning;
      if (response.ok) {
        this.viewState.status = "ready";
      } else {
        this.setRpcError(response);
      }
      return response;
    } catch (error) {
      this.setThrownError(error);
      throw error;
    }
  }

  private async invokeRuntime(
    operation: string,
    action: () => Promise<unknown>,
  ): Promise<SpiderResponse> {
    this.assertNotDestroyed();
    this.viewState.status = "loading";
    this.viewState.error = null;
    try {
      const response = runtimeResponse(operation, await action());
      this.viewState.status = "ready";
      this.viewState.sidecarRunning = false;
      return response;
    } catch (error) {
      this.setThrownError(error);
      throw error;
    }
  }

  private findSite(siteKey: string): TvBoxSite {
    const sites = Array.isArray(this.options.config.sites) ? this.options.config.sites : [];
    const site = sites.find((candidate) => candidate.key === siteKey)
      ?? sites.find((candidate) => candidate.api === siteKey);
    if (!site) {
      throw this.fail(`Spider site not found: ${siteKey}`, "SPIDER_SITE_NOT_FOUND");
    }
    return site;
  }

  private assertConnected(): DesktopSpiderClientPort {
    this.assertNotDestroyed();
    if (!this.client || !this.client.isRunning) {
      throw this.fail("Desktop Spider session is not connected", "SPIDER_NOT_CONNECTED");
    }
    return this.client;
  }

  private assertNotDestroyed(): void {
    if (this.viewState.status === "destroyed") {
      throw new Error("Desktop Spider session is destroyed");
    }
  }

  private setRpcError(response: SpiderResponse): void {
    this.viewState.status = "error";
    this.viewState.error = response.error ?? {
      code: "SPIDER_RPC_ERROR",
      message: "Desktop Spider returned an unsuccessful response",
    };
  }

  private setThrownError(error: unknown): void {
    const details = normalizeRuntimeError(error, {
      ...(this.runtime?.kind ? { runtimeKind: this.runtime.kind } : {}),
      ...(this.activeSiteKey ? { siteKey: this.activeSiteKey } : {}),
      sourceKey: this.activeSiteKey ?? this.options.source,
      ...(this.activeSiteName ? { sourceName: this.activeSiteName } : {}),
      workingDirectory: process.cwd(),
    });
    const message = runtimeErrorMessage(details);
    const isTimeout = error instanceof Error
      && (readErrorCode(error) === "JVM_SPIDER_TIMEOUT"
        || error.name === "JvmSidecarTimeoutError"
        || /timeout/i.test(message));
    this.viewState.status = "error";
    this.viewState.error = {
      code: isTimeout ? "SPIDER_TIMEOUT" : details.code,
      message,
    };
    this.viewState.sidecarRunning = this.client?.isRunning ?? false;
  }

  private fail(message: string, code: string): Error {
    this.viewState.status = "error";
    this.viewState.error = { code, message };
    return new Error(message);
  }

  private async destroyClient(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) await runtime.destroy();
    const client = this.client;
    this.client = undefined;
    if (!client) {
      this.viewState.sidecarRunning = false;
      this.activeDefinition = undefined;
      this.activeCapabilities = undefined;
      return;
    }
    await client.destroy();
    this.viewState.sidecarRunning = false;
    this.activeDefinition = undefined;
    this.activeCapabilities = undefined;
  }
}

function firstSiteApi(config: TvBoxConfig): string | undefined {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  return sites.find((site) => typeof site.api === "string")?.api as string | undefined;
}

function firstSiteKey(config: TvBoxConfig): string | undefined {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  const site = sites.find((candidate) => typeof candidate.api === "string");
  if (!site) return undefined;
  return typeof site.key === "string" && site.key.length > 0 ? site.key : site.api;
}

function playbackUnavailableFor(code: string, message: string): DesktopSpiderPlaybackState {
  if (code === "PLAYBACK_PROXY_REQUIRED") return PLAYBACK_PROXY_REQUIRED;
  if (code === "SPIDER_AUTH_REQUIRED") {
    return { available: false, label: "需要 UC 登录", message };
  }
  return {
    available: false,
    label: "播放不可用",
    message,
  };
}

function isAuthRequiredPlayerResult(value: unknown): value is { status: "AUTH_REQUIRED"; message?: string } {
  return isRecord(value) && value.status === "AUTH_REQUIRED";
}

function playbackFrom(
  value: unknown,
  context?: { sourceKey: string; sourceName: string; episodeId: string },
): Extract<DesktopSpiderPlaybackState, { available: true }> {
  const normalized = normalizePlayerResult(value, context ?? {
    sourceKey: "",
    sourceName: "",
    episodeId: "",
  });
  return {
    available: true,
    label: "Playable source",
    message: "Direct playback URL resolved",
    parse: normalized.parse,
    url: normalized.url,
    headers: normalized.headers,
    ...(normalized.playUrl ? { playUrl: normalized.playUrl } : {}),
    ...(normalized.jx === undefined ? {} : { jx: normalized.jx }),
    ...(normalized.format ? { format: normalized.format } : {}),
    ...(normalized.flag ? { flag: normalized.flag } : {}),
    ...(normalized.jxFrom ? { jxFrom: normalized.jxFrom } : {}),
    ...(context ? context : {}),
    ...(normalized.subtitles && normalized.subtitles.length > 0
      ? { subtitles: normalized.subtitles.map((subtitle) => ({ ...subtitle })) }
      : {}),
    ...(normalized.danmaku !== undefined ? { danmaku: normalized.danmaku } : {}),
  };
}

function clonePlayback(playback: DesktopSpiderPlaybackState): DesktopSpiderPlaybackState {
  return playback.available
    ? {
        ...playback,
        headers: { ...playback.headers },
        ...(playback.subtitles ? { subtitles: playback.subtitles.map(cloneSubtitleTrack) } : {}),
        ...(playback.danmaku !== undefined ? { danmaku: cloneDanmakuValue(playback.danmaku) } : {}),
      }
    : { ...playback };
}

function cloneDanmakuValue(value: unknown): unknown {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall back to a shallow-safe value below for non-cloneable source data.
    }
  }
  if (Array.isArray(value)) return value.map(cloneDanmakuValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDanmakuValue(item)]));
  return value;
}

function cloneSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  return {
    ...track,
    ...(track.headers ? { headers: { ...track.headers } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(error: Error): string | undefined {
  const candidate = error as Error & { code?: unknown };
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

function successResponse(result: unknown): SpiderResponse {
  return { id: randomUUID(), ok: true, result };
}

function runtimeResponse(operation: string, value: unknown): SpiderResponse {
  if (operation === "detail" && Array.isArray(value)) {
    return {
      id: randomUUID(),
      ok: true,
      result: { list: value.map((item) => rawVod(item)) },
    };
  }
  if (isRecord(value) && isRecord(value.raw)) {
    return { id: randomUUID(), ok: true, result: value.raw };
  }
  return { id: randomUUID(), ok: true, result: value };
}

function rawVod(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (isRecord(value.raw)) return { ...value.raw };
  return { ...value };
}
