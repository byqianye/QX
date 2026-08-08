import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { normalizeFongMiSite, serializeFongMiExt } from "../config/fongmi.js";
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
import {
  normalizeHomeResult,
  normalizePlayerResult,
  normalizeVodDetails,
  normalizeVodPage,
  unwrapSpiderResponse,
} from "../source/normalizers.js";
import { HttpDesktopClient } from "./http-client.js";
import type { DesktopSpiderClientPort } from "../desktop/spider-client-port.js";
import type { SpiderResponse } from "./rpc.js";
import { JsSpiderWorker, type JsSpiderWorkerOptions } from "./js-spider-worker-client.js";
import {
  runtimeCapabilities,
  type RuntimeSupport,
  type SpiderRuntime,
  type SpiderRuntimeKind,
} from "./runtime-types.js";
import { NativeSpiderRegistry } from "./native-spider-registry.js";
import { SpiderRuntimeDetector, type SpiderRuntimeDetectorOptions } from "./spider-runtime-detector.js";
import { quickJsScriptReference, pythonScriptReference } from "../desktop/source-router.js";
import { PythonDesktopClient } from "./python-client.js";
import { AndroidSpiderBridge, AndroidSpiderBridgeError, type AndroidSpiderBridgeResponse } from "./android-spider-bridge.js";

export interface SpiderRuntimeManagerOptions extends SpiderRuntimeDetectorOptions {
  config?: TvBoxConfig;
  sourceUrl?: string;
  nativeRuntime?: (site: TvBoxSite) => SpiderRuntime | undefined | Promise<SpiderRuntime | undefined>;
  androidBridgeFactory?: (site: TvBoxSite, support: RuntimeSupport) => AndroidSpiderBridge | undefined | Promise<AndroidSpiderBridge | undefined>;
  pythonExecutable?: string;
  pythonEnvironment?: NodeJS.ProcessEnv;
  jsWorker?: Omit<JsSpiderWorkerOptions, "script">;
}

export class SpiderRuntimeManager {
  public readonly nativeRegistry: NativeSpiderRegistry;
  public readonly detector: SpiderRuntimeDetector;
  private readonly options: SpiderRuntimeManagerOptions;
  private readonly runtimeCache = new Map<string, Promise<SpiderRuntime>>();

  public constructor(options: SpiderRuntimeManagerOptions = {}) {
    this.options = options;
    this.nativeRegistry = options.nativeRegistry ?? new NativeSpiderRegistry();
    registerBuiltInNativeApis(this.nativeRegistry);
    this.detector = new SpiderRuntimeDetector({ ...options, nativeRegistry: this.nativeRegistry });
  }

  public supports(site: TvBoxSite): Promise<RuntimeSupport> {
    return this.detector.detect(site, {
      ...(this.options.config ? { config: this.options.config } : {}),
      ...(this.options.sourceUrl ? { sourceUrl: this.options.sourceUrl } : {}),
    });
  }

  public async getRuntime(site: TvBoxSite): Promise<SpiderRuntime> {
    const key = runtimeKey(site);
    const cached = this.runtimeCache.get(key);
    if (cached) return cached;
    const promise = this.createRuntime(site).catch((error) => {
      this.runtimeCache.delete(key);
      throw error;
    });
    this.runtimeCache.set(key, promise);
    return promise;
  }

  public async destroy(): Promise<void> {
    const runtimes = await Promise.allSettled([...this.runtimeCache.values()]);
    await Promise.all(runtimes.flatMap((result) => result.status === "fulfilled" ? [result.value.destroy()] : []));
    this.runtimeCache.clear();
  }

  private async createRuntime(site: TvBoxSite): Promise<SpiderRuntime> {
    const support = await this.supports(site);
    if (support.runtime === "android-dex") {
      const bridge = await this.options.androidBridgeFactory?.(site, support);
      return bridge ? new AndroidSpiderRuntime(site, support, bridge) : new AndroidJarRuntime(support);
    }
    if (!support.supported) {
      return new UnsupportedSpiderRuntime(support);
    }
    const normalized = normalizeFongMiSite(site, this.options.sourceUrl);
    if (support.runtime === "cms") {
      if (!normalized.endpoint) return new UnsupportedSpiderRuntime({ ...support, supported: false, reason: "unsupported_site_type" });
      const client = new HttpDesktopClient({
        api: normalized.endpoint,
        type: normalized.type as 0 | 1 | 4,
        ...(normalized.headers ? { headers: normalized.headers } : {}),
        initialExt: serializeFongMiExt(normalized.ext),
        ...(normalized.playUrl ? { playUrl: normalized.playUrl } : {}),
        ...(normalized.timeoutMs ? { requestTimeoutMs: normalized.timeoutMs } : {}),
      });
      return new DesktopClientSpiderRuntime("cms", client, client.capabilities, support);
    }
    if (support.runtime === "javascript") {
      const script = quickJsScriptReference(this.options.config ?? {}, site);
      if (!script) return new UnsupportedSpiderRuntime({ ...support, supported: false, reason: "unsupported_site_type" });
      return new JsSpiderRuntime(site, support, {
        script,
        ...(this.options.jsWorker ? { ...this.options.jsWorker } : {}),
      });
    }
    if (support.runtime === "python") {
      const script = pythonScriptReference(this.options.config ?? {}, site);
      if (!script) return new UnsupportedSpiderRuntime({ ...support, supported: false, reason: "unsupported_site_type" });
      const client = new PythonDesktopClient({
        api: site.api ?? "python",
        pythonExecutable: this.options.pythonExecutable ?? "python",
        script,
        ...(this.options.pythonEnvironment ? { env: this.options.pythonEnvironment } : {}),
      });
      return new DesktopClientSpiderRuntime("python", client, client.capabilities, support);
    }
    if (support.runtime === "native") {
      const registered = this.nativeRegistry.create(site);
      if (registered) return registered;
      const created = await this.options.nativeRuntime?.(site);
      if (created) return created;
      return new UnsupportedSpiderRuntime({ ...support, supported: false, reason: "native_runtime_not_configured" });
    }
    return new UnsupportedSpiderRuntime(support);
  }
}

export class DesktopClientSpiderRuntime implements SpiderRuntime {
  private initialized = false;
  private destroyed = false;

  public constructor(
    public readonly kind: SpiderRuntimeKind,
    private readonly client: DesktopSpiderClientPort,
    public readonly capabilities: SourceCapabilities,
    private readonly support: RuntimeSupport,
  ) {}

  public supports(_site: TvBoxSite): Promise<RuntimeSupport> {
    return Promise.resolve(this.support);
  }

  public async init(site: TvBoxSite, context: SourceInitContext = defaultContext(site)): Promise<void> {
    if (this.destroyed) throw new Error("Spider runtime is destroyed");
    if (this.initialized) return;
    const response = await this.client.init(context.ext ?? serializeFongMiExt(site.ext), context.requestTimeoutMs);
    unwrap(response, "init");
    this.initialized = true;
  }

  public async home(filter = false): Promise<HomeResult> {
    return normalizeHomeResult(unwrap(await this.client.homeContent(filter), "home"));
  }

  public async homeVideo(): Promise<VodPage> {
    return normalizeVodPage(unwrap(await this.client.homeContent(false), "home"), 1);
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    const page = request.page ?? 1;
    return normalizeVodPage(unwrap(await this.client.categoryContent(request.typeId, page, request.filter ?? false, { ...(request.extend ?? {}) }), "category"), page);
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    const page = request.page ?? 1;
    return normalizeVodPage(unwrap(await this.client.searchContent(request.key, request.quick ?? false, page), "search"), page);
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    return normalizeVodDetails(unwrap(await this.client.detailContent(ids), "detail"));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    return normalizePlayerResult(unwrap(await this.client.playerContent(request.flag, request.id, [...(request.vipFlags ?? [])]), "player"));
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.initialized = false;
    await this.client.destroy();
  }
}

export class NativeSpiderRuntime extends DesktopClientSpiderRuntime {
  public constructor(client: DesktopSpiderClientPort, capabilities: SourceCapabilities, support: RuntimeSupport) {
    super("native", client, capabilities, support);
  }
}

export class JsSpiderRuntime implements SpiderRuntime {
  private readonly worker: JsSpiderWorker;
  private capabilitiesValue: SourceCapabilities;
  private destroyed = false;

  public constructor(
    private readonly site: TvBoxSite,
    private readonly support: RuntimeSupport,
    options: JsSpiderWorkerOptions,
  ) {
    this.worker = new JsSpiderWorker(options);
    this.capabilitiesValue = support.capabilities;
  }

  public get kind(): "javascript" { return "javascript"; }
  public get capabilities(): SourceCapabilities { return { ...this.capabilitiesValue }; }

  public supports(_site: TvBoxSite): Promise<RuntimeSupport> { return Promise.resolve(this.support); }

  public async init(site: TvBoxSite = this.site, context: SourceInitContext = defaultContext(site)): Promise<void> {
    if (this.destroyed) throw new Error("JavaScript Spider runtime is destroyed");
    this.capabilitiesValue = await this.worker.start(context);
  }

  public home(): Promise<HomeResult> { return this.worker.home(); }
  public homeVideo(): Promise<VodPage> { return this.worker.home().then((result) => normalizeHomeAsPage(result)); }
  public category(request: CategoryRequest): Promise<VodPage> { return this.worker.category(request); }
  public search(request: SearchRequest): Promise<VodPage> { return this.worker.search(request); }
  public detail(ids: string[]): Promise<VodDetail[]> { return this.worker.detail(ids); }
  public player(request: PlayerRequest): Promise<PlayerResult> { return this.worker.player(request); }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.worker.destroy();
  }
}

export class AndroidJarRuntime implements SpiderRuntime {
  public readonly kind: SpiderRuntimeKind = "android-dex";
  public readonly capabilities = runtimeCapabilities("jvm");

  public constructor(private readonly support: RuntimeSupport) {}
  public supports(_site: TvBoxSite): Promise<RuntimeSupport> { return Promise.resolve(this.support); }
  public init(): Promise<void> { return Promise.reject(new Error("Android DEX Spider runtime is unavailable")); }
  public home(): Promise<HomeResult> { return unsupportedOperation(); }
  public homeVideo(): Promise<VodPage> { return unsupportedOperation(); }
  public category(_request: CategoryRequest): Promise<VodPage> { return unsupportedOperation(); }
  public search(_request: SearchRequest): Promise<VodPage> { return unsupportedOperation(); }
  public detail(_ids: string[]): Promise<VodDetail[]> { return unsupportedOperation(); }
  public player(_request: PlayerRequest): Promise<PlayerResult> { return unsupportedOperation(); }
  public destroy(): Promise<void> { return Promise.resolve(); }
}

export class AndroidSpiderRuntime implements SpiderRuntime {
  public readonly kind: SpiderRuntimeKind = "android-dex";
  public readonly capabilities = runtimeCapabilities("jvm", {
    home: true,
    category: true,
    search: true,
    detail: true,
    player: true,
    pagination: true,
  });
  private initialized = false;

  public constructor(
    private readonly site: TvBoxSite,
    private readonly support: RuntimeSupport,
    private readonly bridge: AndroidSpiderBridge,
  ) {}

  public async supports(_site: TvBoxSite): Promise<RuntimeSupport> {
    return {
      ...this.support,
      supported: true,
      reason: "android_bridge_supported",
      capabilities: this.capabilities,
    };
  }

  public async init(site = this.site, context: SourceInitContext = defaultContext(site)): Promise<void> {
    if (this.initialized) return;
    await this.bridge.start();
    await requireBridgeResult(this.bridge.health(), "health");
    const artifactPath = this.support.artifactPath;
    if (!artifactPath) {
      throw new AndroidSpiderBridgeError(
        "artifact_file_missing",
        "Android Spider artifact path is unavailable",
      );
    }
    await requireBridgeResult(this.bridge.loadJar(artifactPath, this.support.artifactUrl), "loadJar");
    await requireBridgeResult(this.bridge.createSpider(
      site.api ?? "",
      site.key ?? site.api ?? "site",
      expectedAndroidSpiderClass(site.api),
    ), "createSpider");
    await requireBridgeResult(this.bridge.init(context.ext ?? serializeFongMiExt(site.ext)), "init");
    this.initialized = true;
  }

  public async home(filter = false): Promise<HomeResult> {
    return normalizeHomeResult(await requireBridgeResult(this.bridge.homeContent(filter), "home"));
  }

  public async homeVideo(): Promise<VodPage> {
    return normalizeHomeAsPage(await this.home());
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    return normalizeVodPage(await requireBridgeResult(this.bridge.categoryContent(
      request.typeId,
      request.page ?? 1,
      request.filter ?? false,
      { ...(request.extend ?? {}) },
    ), "category"), request.page ?? 1);
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    return normalizeVodPage(await requireBridgeResult(this.bridge.searchContent(
      request.key,
      request.quick ?? false,
      request.page ?? 1,
    ), "search"), request.page ?? 1);
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    return normalizeVodDetails(await requireBridgeResult(this.bridge.detailContent(ids), "detail"));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    return normalizePlayerResult(await requireBridgeResult(this.bridge.playerContent(
      request.flag,
      request.id,
      [...(request.vipFlags ?? [])],
    ), "player"));
  }

  public async destroy(): Promise<void> {
    this.initialized = false;
    await this.bridge.destroy();
  }
}

export class UnsupportedSpiderRuntime extends AndroidJarRuntime {
  public readonly kind: SpiderRuntimeKind = "unsupported";
  public readonly capabilities = runtimeCapabilities("jvm");
}

export function registerBuiltInNativeApis(registry: NativeSpiderRegistry): void {
  for (const api of ["csp_Douban", "csp_PlayableFixture"]) {
    if (!registry.has(api)) registry.register({ api, factory: () => undefined });
  }
}

function normalizeHomeAsPage(value: HomeResult): VodPage {
  return {
    items: value.items,
    page: 1,
    ...(value.filters ? { filters: value.filters } : {}),
    raw: { ...value.raw },
  };
}

function defaultContext(site: TvBoxSite): SourceInitContext {
  return {
    sourceId: `runtime:${site.key ?? site.api ?? "site"}`,
    ...(typeof site.key === "string" ? { siteKey: site.key } : {}),
    ...(typeof site.api === "string" ? { api: site.api } : {}),
    ...(typeof site.ext === "string" ? { ext: site.ext } : {}),
  };
}

function runtimeKey(site: TvBoxSite): string {
  return `${site.key ?? ""}\u0000${site.api ?? ""}\u0000${typeof site.ext === "string" ? site.ext : ""}`;
}

function unwrap(response: SpiderResponse, operation: string): unknown {
  return unwrapSpiderResponse(response, operation);
}

function unsupportedOperation<T>(): Promise<T> {
  return Promise.reject(new Error("Spider runtime capability is unavailable"));
}

function expectedAndroidSpiderClass(api: string | undefined): string {
  const name = api?.replace(/^csp_/i, "").trim();
  return name ? `com.github.catvod.spider.${name}` : "";
}

async function requireBridgeResult(response: Promise<AndroidSpiderBridgeResponse>, operation: string): Promise<unknown> {
  const value = await response;
  if (!value.ok) {
    const diagnostics = value.error?.diagnostics;
    const diagnosticText = diagnostics
      ? Object.entries(diagnostics)
        .filter(([, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .map(([key, item]) => `${key}=${String(item)}`)
        .join(", ")
      : "";
    throw new AndroidSpiderBridgeError(
      value.error?.code ?? "ANDROID_BRIDGE_REMOTE_ERROR",
      `${value.error?.message ?? `Android Spider Bridge ${operation} failed`}${diagnosticText ? ` (${diagnosticText})` : ""}`,
      undefined,
      undefined,
      diagnostics,
    );
  }
  if (typeof value.result === "string") {
    try {
      return JSON.parse(value.result) as unknown;
    } catch {
      return value.result;
    }
  }
  return value.result;
}
