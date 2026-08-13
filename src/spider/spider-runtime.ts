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
  type SpiderRuntimeCompatibilityProbe,
} from "./runtime-types.js";
import { NativeSpiderRegistry } from "./native-spider-registry.js";
import { SpiderRuntimeDetector, type SpiderRuntimeDetectorOptions } from "./spider-runtime-detector.js";
import { quickJsScriptReference, pythonScriptReference } from "../desktop/source-router.js";
import { PythonDesktopClient } from "./python-client.js";
import { AndroidSpiderBridge, AndroidSpiderBridgeError, type AndroidSpiderBridgeResponse } from "./android-spider-bridge.js";
import { AndroidSpiderBridgeClient } from "./android-spider-bridge-client.js";
import { expectedAndroidSpiderClass } from "./android-dex-runtime.js";
import { isCredentialSite, type SpiderCredentialProvider, ucCredentialPayload } from "./spider-credential-provider.js";

const ANDROID_INIT_ATTEMPTS = 3;
const ANDROID_INIT_RETRY_DELAY_MS = 2_000;
const DEFAULT_ANDROID_RUNTIME_READY_TIMEOUT_MS = 90_000;

export interface SpiderRuntimeManagerOptions extends SpiderRuntimeDetectorOptions {
  config?: TvBoxConfig;
  sourceUrl?: string;
  nativeRuntime?: (site: TvBoxSite) => SpiderRuntime | undefined | Promise<SpiderRuntime | undefined>;
  /** @deprecated RuntimeManager wiring remains opt-in until the real Android PoC passes on a device. */
  androidBridgeFactory?: (site: TvBoxSite, support: RuntimeSupport) => AndroidSpiderBridge | undefined | Promise<AndroidSpiderBridge | undefined>;
  androidBridgeClientFactory?: (site: TvBoxSite, support: RuntimeSupport) => AndroidSpiderBridgeClient | undefined | Promise<AndroidSpiderBridgeClient | undefined>;
  spiderCredentialProvider?: SpiderCredentialProvider;
  /** Called once before a search that contains supported Android DEX sources. */
  androidRuntimePreparer?: (sites: readonly TvBoxSite[]) => void | Promise<void>;
  androidRuntimeReadyTimeoutMs?: number;
  pythonExecutable?: string;
  pythonEnvironment?: NodeJS.ProcessEnv;
  jsWorker?: Omit<JsSpiderWorkerOptions, "script">;
}

export class SpiderRuntimeManager {
  public readonly nativeRegistry: NativeSpiderRegistry;
  public readonly detector: SpiderRuntimeDetector;
  private readonly options: SpiderRuntimeManagerOptions;
  private readonly runtimeCache = new Map<string, Promise<SpiderRuntime>>();
  private readonly supportCache = new Map<string, Promise<RuntimeSupport>>();
  private prepareOperation: Promise<void> | undefined;

  public constructor(options: SpiderRuntimeManagerOptions = {}) {
    this.options = options;
    this.nativeRegistry = options.nativeRegistry ?? new NativeSpiderRegistry();
    registerBuiltInNativeApis(this.nativeRegistry);
    this.detector = new SpiderRuntimeDetector({ ...options, nativeRegistry: this.nativeRegistry });
  }

  public supports(site: TvBoxSite): Promise<RuntimeSupport> {
    const key = runtimeKey(site);
    const cached = this.supportCache.get(key);
    if (cached) return cached;
    const promise = this.detector.detect(site, {
      ...(this.options.config ? { config: this.options.config } : {}),
      ...(this.options.sourceUrl ? { sourceUrl: this.options.sourceUrl } : {}),
    }).catch((error) => {
      this.supportCache.delete(key);
      throw error;
    });
    this.supportCache.set(key, promise);
    return promise;
  }

  public async prepareForSources(sites: readonly TvBoxSite[]): Promise<void> {
    if (!this.options.androidRuntimePreparer || sites.length === 0) return;
    const supports = await Promise.all(sites.map((site) => this.supports(site)));
    if (!supports.some((support) => support.runtime === "android-dex" && support.supported)) return;
    if (this.prepareOperation) return this.prepareOperation;
    this.prepareOperation = withTimeout(
      Promise.resolve(this.options.androidRuntimePreparer(sites)),
      this.options.androidRuntimeReadyTimeoutMs ?? DEFAULT_ANDROID_RUNTIME_READY_TIMEOUT_MS,
      "Android Runtime ready timeout",
    ).finally(() => {
      this.prepareOperation = undefined;
    });
    return this.prepareOperation;
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
    this.supportCache.clear();
  }

  public async destroyRuntime(site: TvBoxSite): Promise<void> {
    const key = runtimeKey(site);
    const promise = this.runtimeCache.get(key);
    this.runtimeCache.delete(key);
    if (!promise) return;
    const runtime = await promise.catch(() => undefined);
    if (runtime) await runtime.destroy();
  }

  private async createRuntime(site: TvBoxSite): Promise<SpiderRuntime> {
    const support = await this.supports(site);
    if (support.runtime === "android-dex") {
      if (support.supported) {
        const client = await this.options.androidBridgeClientFactory?.(site, support);
        if (client) return new AndroidDexRuntime(site, support, client, this.options.spiderCredentialProvider);
      }
      const bridge = await this.options.androidBridgeFactory?.(site, support);
      return bridge
        ? new AndroidSpiderRuntime(site, support, bridge)
        : new UnsupportedSpiderRuntime({ ...support, supported: false, reason: "android_host_offline" });
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
  public readonly capabilities = runtimeCapabilities("android-dex");

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

export class AndroidDexRuntime implements SpiderRuntime {
  public readonly kind: SpiderRuntimeKind = "android-dex";
  public readonly capabilities = runtimeCapabilities("android-dex", {
    search: true,
    detail: true,
    player: true,
  });
  private initialized = false;
  private classProbeValue: Record<string, unknown> | undefined;

  public constructor(
    private readonly site: TvBoxSite,
    private readonly support: RuntimeSupport,
    private readonly client: AndroidSpiderBridgeClient,
    private readonly credentialProvider?: SpiderCredentialProvider,
  ) {}

  public supports(_site: TvBoxSite): Promise<RuntimeSupport> {
    return Promise.resolve({
      ...this.support,
      supported: true,
      reason: "android_dex_runtime_supported",
      capabilities: this.capabilities,
    });
  }

  public async init(site = this.site, context: SourceInitContext = defaultContext(site)): Promise<void> {
    if (this.initialized) return;
    const artifactPath = this.support.artifactPath;
    if (!artifactPath) throw new Error("Android Spider artifact path is unavailable");
    const expectedClass = expectedAndroidSpiderClass(site.api);
    const initExt = context.ext ?? serializeFongMiExt(site.ext);
    for (let attempt = 0; attempt < ANDROID_INIT_ATTEMPTS; attempt += 1) {
      try {
        // A failed Spider.init can leave the Host's current Spider instance
        // unusable. Rebuild the complete DEX session before retrying instead
        // of invoking init again on the same failed instance.
        await this.client.connect();
        await this.client.health();
        await this.client.loadJar(artifactPath, this.support.artifactUrl);
        await this.applyCredential(site);
        const classProbe = typeof this.client.resolveClass === "function"
          ? await this.client.resolveClass(site.api ?? "")
          : undefined;
        this.classProbeValue = classProbe;
        if (classProbe && classProbe.classExists === false) {
          throw new Error(`SPIDER_CLASS_NOT_FOUND: ${expectedClass}`);
        }
        await this.client.createSpider(
          site.api ?? "",
          typeof classProbe?.resolvedClass === "string" ? classProbe.resolvedClass : expectedClass,
          site.key ?? site.api ?? "site",
        );
        await this.client.init(initExt);
        this.initialized = true;
        return;
      } catch (error) {
        if (!isTransientAndroidInitError(error) || attempt === ANDROID_INIT_ATTEMPTS - 1) throw error;
        if (typeof this.client.destroySpider === "function") {
          await this.client.destroySpider().catch(() => undefined);
        }
        await delay(ANDROID_INIT_RETRY_DELAY_MS);
      }
    }
  }

  public async home(filter = false): Promise<HomeResult> {
    return normalizeHomeResult(await this.client.homeContent(filter));
  }

  public async homeVideo(): Promise<VodPage> {
    return normalizeHomeAsPage(await this.home());
  }

  public async category(request: CategoryRequest): Promise<VodPage> {
    const page = request.page ?? 1;
    return normalizeVodPage(await this.client.categoryContent(
      request.typeId,
      page,
      request.filter ?? false,
      { ...(request.extend ?? {}) },
    ), page);
  }

  public async search(request: SearchRequest): Promise<VodPage> {
    const page = request.page ?? 1;
    return normalizeVodPage(await this.client.searchContent(request.key, request.quick ?? false, page), page);
  }

  public async detail(ids: string[]): Promise<VodDetail[]> {
    return normalizeVodDetails(await this.client.detailContent(ids));
  }

  public async player(request: PlayerRequest): Promise<PlayerResult> {
    await this.applyCredential(this.site);
    return normalizePlayerResult(await this.client.playerContent(
      request.flag,
      request.id,
      [...(request.vipFlags ?? [])],
    ));
  }

  public async probeCompatibility(): Promise<SpiderRuntimeCompatibilityProbe> {
    const classProbe = this.classProbeValue
      ?? (this.initialized ? await this.client.resolveClass(this.site.api ?? "") : undefined);
    return {
      classLoad: classProbe?.classExists === false ? "FAIL" : classProbe ? "PASS" : "UNKNOWN",
      ...(typeof classProbe?.resolvedClass === "string" ? { resolvedClass: classProbe.resolvedClass } : {}),
      ...(this.support.artifact?.sha256 ? { artifactSha256: this.support.artifact.sha256 } : {}),
      ...(this.support.artifact?.size === undefined ? {} : { artifactSize: this.support.artifact.size }),
      ...(this.support.artifactUrl ? { artifactUrl: this.support.artifactUrl } : {}),
      ...(typeof this.classProbeValue?.jarId === "string" ? { jarId: this.classProbeValue.jarId } : {}),
    };
  }

  public async destroy(): Promise<void> {
    this.initialized = false;
    this.classProbeValue = undefined;
    await this.client.destroy();
  }

  private async applyCredential(site: TvBoxSite): Promise<void> {
    if (!isCredentialSite(site) || !this.credentialProvider) return;
    const credential = await this.credentialProvider.get(site);
    if (credential) await this.client.setSpiderCredential("uc", ucCredentialPayload(credential));
  }

}

export class AndroidSpiderRuntime implements SpiderRuntime {
  public readonly kind: SpiderRuntimeKind = "android-dex";
  public readonly capabilities = runtimeCapabilities("android-dex", {
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

function isTransientAndroidInitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "SPIDER_METHOD_FAILED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Attempt to invoke virtual method")
    && message.includes("on a null object reference");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
