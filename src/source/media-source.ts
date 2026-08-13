export type SourceEngine = "jvm" | "android-dex" | "quickjs" | "python" | "http" | "jellyfin" | "fixture";

export interface SourceCapabilities {
  home: boolean;
  category: boolean;
  search: boolean;
  detail: boolean;
  playback: boolean;
  localProxy: boolean;
  filters: boolean;
  pagination: boolean;
  engine: SourceEngine;
  /** Explicitly provided legal download endpoint capability; false/undefined means playback is not downloadable. */
  download?: boolean;
}

export interface SourceInitContext {
  sourceId: string;
  siteKey?: string;
  api?: string;
  ext?: string;
  config?: Readonly<Record<string, unknown>>;
  requestTimeoutMs?: number;
}

export interface CategoryRequest {
  typeId: string;
  page?: number;
  filter?: boolean;
  extend?: Readonly<Record<string, string>>;
}

export interface SearchRequest {
  key: string;
  page?: number;
  quick?: boolean;
}

export interface PlayerRequest {
  flag: string;
  id: string;
  vipFlags?: readonly string[];
}

export type PlayableStatus = "DIRECT" | "PARSE_REQUIRED" | "AUTH_REQUIRED" | "UNSUPPORTED" | "FAILED";

export interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface ProxyResult {
  url: string;
  headers: Record<string, string>;
  status?: number;
  body?: Uint8Array;
}

export interface Vod {
  id: string;
  name: string;
  raw: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VodDetail extends Vod {
  episodes?: readonly VodEpisode[];
}

export interface VodEpisode {
  id: string;
  name: string;
  raw: Record<string, unknown>;
}

export interface SourceCategory {
  id: string;
  name: string;
  raw?: Record<string, unknown>;
}

export interface SourceFilterOption {
  id: string;
  name: string;
}

export interface SourceFilter {
  id: string;
  name: string;
  options: readonly SourceFilterOption[];
}

export interface VodPage {
  items: readonly Vod[];
  page: number;
  pageCount?: number;
  total?: number;
  filters?: readonly SourceFilter[];
  raw: Record<string, unknown>;
}

export interface HomeResult {
  items: readonly Vod[];
  categories: readonly SourceCategory[];
  filters?: readonly SourceFilter[];
  raw: Record<string, unknown>;
}

export interface PlayerResult {
  parse: number;
  url: string;
  headers: Record<string, string>;
  status?: PlayableStatus;
  message?: string;
  playUrl?: string;
  jx?: number;
  format?: string;
  flag?: string;
  jxFrom?: string;
  subtitles?: readonly import("../subtitles.js").SubtitleTrack[];
  danmaku?: unknown;
}

export interface QxPlayerResult extends PlayerResult {
  jx: number;
  sourceKey: string;
  sourceName: string;
  episodeId: string;
}

export class MediaSourceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "MediaSourceError";
    this.code = code;
  }
}

export interface MediaSource {
  readonly capabilities: SourceCapabilities;
  init(context: SourceInitContext): Promise<void>;
  home(): Promise<HomeResult>;
  category(request: CategoryRequest): Promise<VodPage>;
  search(request: SearchRequest): Promise<VodPage>;
  detail(ids: string[]): Promise<VodDetail[]>;
  player(request: PlayerRequest): Promise<PlayerResult>;
  localProxy?(request: ProxyRequest): Promise<ProxyResult>;
  destroy(): Promise<void>;
}
