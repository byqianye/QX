import type { TvBoxSite } from "../config/decoder.js";
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
import type { JarInspectionResult } from "./jar-inspector.js";

export type SpiderRuntimeKind = "cms" | "javascript" | "native" | "android-dex" | "python" | "unsupported";

export interface RuntimeSupport {
  runtime: SpiderRuntimeKind;
  supported: boolean;
  reason: string;
  capabilities: SourceCapabilities;
  artifact?: JarInspectionResult;
  artifactUrl?: string;
  artifactPath?: string;
}

export interface SpiderRuntime {
  readonly kind: SpiderRuntimeKind;
  readonly capabilities: SourceCapabilities;
  supports(site: TvBoxSite): Promise<RuntimeSupport>;
  init(site: TvBoxSite, context?: SourceInitContext): Promise<void>;
  home(filter: boolean): Promise<HomeResult>;
  homeVideo(): Promise<VodPage>;
  category(request: CategoryRequest): Promise<VodPage>;
  search(request: SearchRequest): Promise<VodPage>;
  detail(ids: string[]): Promise<VodDetail[]>;
  player(request: PlayerRequest): Promise<PlayerResult>;
  /** Optional evidence seam used by the real source compatibility auditor. */
  probeCompatibility?(): Promise<SpiderRuntimeCompatibilityProbe>;
  destroy(): Promise<void>;
}

export interface SpiderRuntimeCompatibilityProbe {
  classLoad: "PASS" | "FAIL" | "UNKNOWN";
  resolvedClass?: string;
  artifactSha256?: string;
  artifactSize?: number;
  artifactUrl?: string;
  jarId?: string;
  cacheHit?: boolean;
}

export interface SpiderRuntimeManagerPort {
  supports(site: TvBoxSite): Promise<RuntimeSupport>;
  getRuntime(site: TvBoxSite): Promise<SpiderRuntime>;
  /** Invalidates only one cached runtime after a source-local transient failure. */
  destroyRuntime?(site: TvBoxSite): Promise<void>;
  /** Ensures any Android DEX sources are ready before search timers begin. */
  prepareForSources?(sites: readonly TvBoxSite[]): Promise<void>;
  destroy?(): Promise<void>;
}

export function runtimeCapabilities(
  engine: SourceCapabilities["engine"],
  capabilities: Partial<Pick<SourceCapabilities, "home" | "category" | "search" | "detail" | "localProxy" | "filters" | "pagination" | "download">> & {
    player?: boolean;
    playback?: boolean;
  } = {},
): SourceCapabilities {
  return {
    home: capabilities.home ?? false,
    category: capabilities.category ?? false,
    search: capabilities.search ?? false,
    detail: capabilities.detail ?? false,
    playback: capabilities.player ?? capabilities.playback ?? false,
    localProxy: capabilities.localProxy ?? false,
    filters: capabilities.filters ?? false,
    pagination: capabilities.pagination ?? false,
    engine,
  };
}

export function unsupportedRuntimeCapabilities(): SourceCapabilities {
  return runtimeCapabilities("jvm");
}
