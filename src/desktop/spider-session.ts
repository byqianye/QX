import { inspectImport, ImportTrustStore, type ImportAssessment } from "../config/trust.js";
import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { DesktopSpiderClient } from "../spider/desktop-client.js";
import { findJvmSpider } from "../spider/jvm-spiders.js";
import { routeSpiderApi, type SpiderResponse } from "../spider/rpc.js";
import { validatePlaybackSource } from "./playback.js";

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
    };

export interface DesktopSpiderView {
  source: string;
  api: string | null;
  status: DesktopSpiderSessionStatus;
  warning: string | null;
  error: { code: string; message: string } | null;
  sidecarRunning: boolean;
  playback: DesktopSpiderPlaybackState;
}

export interface DesktopSpiderSessionOptions {
  source: string;
  config: TvBoxConfig;
  trustStore: ImportTrustStore;
  createClient: (site: TvBoxSite) => DesktopSpiderClient;
  requestTimeoutMs?: number;
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

export class DesktopSpiderSession {
  private readonly options: DesktopSpiderSessionOptions;
  private assessment: ImportAssessment;
  private client: DesktopSpiderClient | undefined;
  private viewState: DesktopSpiderView;

  public constructor(options: DesktopSpiderSessionOptions) {
    this.options = options;
    this.assessment = inspectImport(options.source, options.config, options.trustStore);
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

  public get view(): DesktopSpiderView {
    return {
      ...this.viewState,
      error: this.viewState.error ? { ...this.viewState.error } : null,
      playback: { ...this.viewState.playback },
    };
  }

  public confirmImport(): void {
    this.assertNotDestroyed();
    this.options.trustStore.trust(this.options.source);
    this.assessment = inspectImport(
      this.options.source,
      this.options.config,
      this.options.trustStore,
    );
    this.viewState.status = "idle";
    this.viewState.warning = null;
    this.viewState.error = null;
  }

  public async open(siteKey: string, ext: string): Promise<SpiderResponse> {
    this.assertNotDestroyed();
    if (this.assessment.requiresConfirmation) {
      throw new Error(`Import confirmation required for source: ${this.options.source}`);
    }
    if (this.client) throw new Error("Desktop Spider session is already open");

    const site = this.findSite(siteKey);
    const api = site.api;
    const definition = typeof api === "string" ? findJvmSpider(api) : undefined;
    if (typeof api !== "string" || routeSpiderApi(api) !== "java" || !definition) {
      throw this.fail(
        `Unsupported JVM-native desktop Spider: ${String(api)}`,
        "UNSUPPORTED_SPIDER_ENGINE",
      );
    }

    this.viewState.api = api;
    this.viewState.playback = definition.playback === "player" ? PLAYABLE_PENDING : NO_PLAYBACK;
    this.viewState.status = "initializing";
    this.viewState.warning = null;
    this.viewState.error = null;

    try {
      this.client = this.options.createClient(site);
      const response = await this.client.init(ext, this.options.requestTimeoutMs);
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
    return this.invoke((client) => client.homeContent(filter, timeoutMs));
  }

  public categoryContent(
    typeId: string,
    page: number,
    filter = false,
    extend: Record<string, string> = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    return this.invoke((client) => client.categoryContent(typeId, page, filter, extend, timeoutMs));
  }

  public searchContent(
    key: string,
    quick = false,
    page = 1,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    return this.invoke((client) => client.searchContent(key, quick, page, timeoutMs));
  }

  public detailContent(
    ids: string[],
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    this.viewState.playback = playbackPendingFor(this.viewState.api);
    return this.invoke((client) => client.detailContent(ids, timeoutMs));
  }

  public async playerContent(
    flag: string,
    id: string,
    vipFlags: string[] = [],
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<SpiderResponse> {
    const definition = findJvmSpider(this.viewState.api ?? undefined);
    if (!definition || definition.playback !== "player") {
      throw this.fail(
        "csp_Douban does not provide a full-content playback URL",
        "PLAYBACK_UNAVAILABLE",
      );
    }

    const response = await this.invoke((client) =>
      client.playerContent(flag, id, vipFlags, timeoutMs));
    if (!response.ok) return response;

    try {
      const playback = playbackFrom(response.result);
      const validation = validatePlaybackSource({
        parse: playback.parse,
        url: playback.url,
        headers: playback.headers,
      }, { allowHeaders: true });
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

  public async destroy(): Promise<void> {
    if (this.viewState.status === "destroyed") return;
    await this.destroyClient();
    this.viewState.status = "destroyed";
    this.viewState.sidecarRunning = false;
  }

  private async invoke(
    operation: (client: DesktopSpiderClient) => Promise<SpiderResponse>,
  ): Promise<SpiderResponse> {
    const client = this.assertConnected();
    this.viewState.status = "loading";
    this.viewState.error = null;
    try {
      const response = await operation(client);
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

  private findSite(siteKey: string): TvBoxSite {
    const sites = Array.isArray(this.options.config.sites) ? this.options.config.sites : [];
    const site = sites.find((candidate) => candidate.key === siteKey)
      ?? sites.find((candidate) => candidate.api === siteKey);
    if (!site) {
      throw this.fail(`Spider site not found: ${siteKey}`, "SPIDER_SITE_NOT_FOUND");
    }
    return site;
  }

  private assertConnected(): DesktopSpiderClient {
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
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error
      && (error.name === "JvmSidecarTimeoutError" || /timeout/i.test(message));
    this.viewState.status = "error";
    this.viewState.error = {
      code: isTimeout ? "SPIDER_TIMEOUT" : "SPIDER_RUNTIME_ERROR",
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
    const client = this.client;
    this.client = undefined;
    if (!client) {
      this.viewState.sidecarRunning = false;
      return;
    }
    await client.destroy();
    this.viewState.sidecarRunning = false;
  }
}

function playbackPendingFor(api: string | null): DesktopSpiderPlaybackState {
  return findJvmSpider(api ?? undefined)?.playback === "player" ? PLAYABLE_PENDING : NO_PLAYBACK;
}

function playbackUnavailableFor(code: string, message: string): DesktopSpiderPlaybackState {
  if (code === "PLAYBACK_PROXY_REQUIRED") return PLAYBACK_PROXY_REQUIRED;
  return {
    available: false,
    label: "播放不可用",
    message,
  };
}

function playbackFrom(value: unknown): Extract<DesktopSpiderPlaybackState, { available: true }> {
  if (!isRecord(value)) throw new Error("playerContent result must be an object");
  const parse = typeof value.parse === "number" && Number.isFinite(value.parse) ? value.parse : null;
  const url = typeof value.url === "string"
    ? value.url
    : typeof value.playUrl === "string"
      ? value.playUrl
      : "";
  if (parse === null || !/^https?:\/\//i.test(url)) {
    throw new Error("playerContent result must contain numeric parse and an HTTP URL");
  }
  return {
    available: true,
    label: "Playable source",
    message: "Direct playback URL resolved",
    parse,
    url,
    headers: playbackHeaders(value.header ?? value.headers),
  };
}

function playbackHeaders(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split("&").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    return [[decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))]];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
