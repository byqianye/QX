import type { TvBoxConfig, TvBoxSite } from "../config/decoder.js";
import { normalizeFongMiSite, serializeFongMiExt } from "../config/fongmi.js";
import type { PlayerRequest, PlayerResult, Vod, VodDetail, VodPage } from "../source/media-source.js";
import { expectedAndroidSpiderClass } from "./android-dex-runtime.js";
import type { SpiderRuntimeKind } from "./runtime-types.js";

export const SOURCE_COMPATIBILITY_STATUSES = [
  "FULLY_PLAYABLE",
  "SEARCH_DETAIL_ONLY",
  "SEARCH_ONLY",
  "AUTH_REQUIRED",
  "METADATA_ONLY",
  "LIVE_ONLY",
  "NETDISK_ONLY",
  "MUSIC_ONLY",
  "EDUCATION_ONLY",
  "OFFLINE",
  "TIMEOUT",
  "RUNTIME_INCOMPATIBLE",
  "CLASS_NOT_FOUND",
  "INIT_FAILED",
  "SEARCH_FAILED",
  "DETAIL_FAILED",
  "PLAYER_FAILED",
  "UNSUPPORTED",
  "UNKNOWN",
] as const;

export type SourceCompatibilityStatus = typeof SOURCE_COMPATIBILITY_STATUSES[number];
export type SourcePhaseStatus = "PASS" | "EMPTY" | "FAIL" | "SKIPPED" | "UNKNOWN";
export type SourceAuthProvider = "NONE" | "UC" | "ALIYUN" | "QUARK" | "BAIDU" | "OTHER" | "UNKNOWN";
export type SourceProbeClassLoad = "PASS" | "FAIL" | "UNKNOWN";
export type SourceCompatibilityCategory = "VOD" | "METADATA" | "LIVE" | "MUSIC" | "EDUCATION" | "NETDISK" | "UNKNOWN";
export type SourceProbePlayback = "PASS" | "FAIL" | "NOT_ATTEMPTED";

export interface SourceCompatibilityCapabilities {
  home: boolean;
  category: boolean;
  search: boolean;
  detail: boolean;
  player: boolean;
  requiresAuth: boolean;
  metadataOnly: boolean;
  vod: boolean;
  live: boolean;
  music: boolean;
  education: boolean;
  netdisk: boolean;
}

export interface SourcePhaseResult {
  status: SourcePhaseStatus;
  durationMs: number;
  resultCount?: number;
  attempts?: number;
  successCount?: number;
  failureCount?: number;
  authProvider?: SourceAuthProvider;
  errorCode?: string;
  message?: string;
  retryable?: boolean;
  p50Ms?: number;
  p90Ms?: number;
  p95Ms?: number;
}

export interface SourceCompatibilityRecord {
  siteKey: string;
  siteName: string;
  type: number;
  api: string;
  sourceCategory: SourceCompatibilityCategory;
  runtime: SpiderRuntimeKind | "cms-json" | "cms-xml" | "unknown";
  resolvedClass?: string;
  searchable: boolean;
  quickSearch: boolean;
  filterable: boolean;
  artifact?: string;
  artifactSha256?: string;
  artifactSize?: number;
  jarId?: string;
  cacheHit?: boolean;
  classLoad: SourceProbeClassLoad;
  init: SourcePhaseResult;
  home: SourcePhaseResult;
  category: SourcePhaseResult;
  search: SourcePhaseResult;
  detail: SourcePhaseResult;
  player: SourcePhaseResult;
  authentication: SourceAuthProvider;
  playback: SourceProbePlayback;
  healthScore: number;
  playable: boolean;
  capabilities: SourceCompatibilityCapabilities;
  status: SourceCompatibilityStatus;
  failureReason?: string;
  timings: Readonly<Record<string, number>>;
}

export interface SourceCompatibilitySummary {
  total: number;
  searchable: number;
  statusCounts: Readonly<Record<SourceCompatibilityStatus, number>>;
  runtimeCounts: Readonly<Record<string, number>>;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
}

export interface SourceCompatibilityReport {
  generatedAt: string;
  sourceUrl?: string;
  keywords: readonly string[];
  sites: readonly SourceCompatibilityRecord[];
  summary: SourceCompatibilitySummary;
}

export interface SourceProbeMetadata {
  runtime?: SourceCompatibilityRecord["runtime"];
  resolvedClass?: string;
  classLoad?: SourceProbeClassLoad;
  artifact?: string;
  artifactSha256?: string;
  artifactSize?: number;
  jarId?: string;
  cacheHit?: boolean;
  authentication?: SourceAuthProvider;
}

export interface SourceProbeEngine {
  init(ext?: string): Promise<void>;
  home?(): Promise<unknown>;
  category?(typeId?: string): Promise<unknown>;
  search(keyword: string, quick: boolean, page: number): Promise<VodPage>;
  detail(ids: readonly string[]): Promise<readonly VodDetail[]>;
  player(request: PlayerRequest): Promise<PlayerResult>;
  metadata?(): Promise<SourceProbeMetadata> | SourceProbeMetadata;
  destroy?(): Promise<void>;
}

export interface SourceCompatibilityAuditorOptions {
  sourceUrl?: string;
  keywords?: readonly string[];
  createEngine?: (site: TvBoxSite) => Promise<SourceProbeEngine> | SourceProbeEngine;
  runtimeForSite?: (site: TvBoxSite) => SourceProbeMetadata | Promise<SourceProbeMetadata>;
  initTimeoutMs?: number;
  searchTimeoutMs?: number;
  detailTimeoutMs?: number;
  playerTimeoutMs?: number;
  initConcurrency?: number;
  searchConcurrency?: number;
  detailConcurrency?: number;
  playerConcurrency?: number;
  now?: () => number;
}

export class SourceCompatibilityAuditor {
  private readonly options: Required<Pick<SourceCompatibilityAuditorOptions,
    "initTimeoutMs" | "searchTimeoutMs" | "detailTimeoutMs" | "playerTimeoutMs" |
    "initConcurrency" | "searchConcurrency" | "detailConcurrency" | "playerConcurrency">> & SourceCompatibilityAuditorOptions;

  public constructor(options: SourceCompatibilityAuditorOptions = {}) {
    this.options = {
      initTimeoutMs: 15_000,
      searchTimeoutMs: 12_000,
      detailTimeoutMs: 15_000,
      playerTimeoutMs: 15_000,
      initConcurrency: 2,
      searchConcurrency: 4,
      detailConcurrency: 3,
      playerConcurrency: 2,
      now: Date.now,
      ...options,
    };
  }

  public async audit(config: TvBoxConfig, sourceUrl = this.options.sourceUrl): Promise<SourceCompatibilityReport> {
    const keywords = normalizeKeywords(this.options.keywords);
    const sites = config.sites ?? [];
    const stages = {
      init: new StageLimiter(this.options.initConcurrency),
      search: new StageLimiter(this.options.searchConcurrency),
      detail: new StageLimiter(this.options.detailConcurrency),
      player: new StageLimiter(this.options.playerConcurrency),
    };
    const records = await mapLimited(sites, Math.max(1, sites.length), (site) => this.probeSite(config, site, sourceUrl, keywords, stages));
    const durations = records.map((record) => sumTiming(record.timings)).filter((value) => value >= 0);
    return {
      generatedAt: new Date(this.options.now!()).toISOString(),
      ...(sourceUrl ? { sourceUrl } : {}),
      keywords,
      sites: records,
      summary: summarizeRecords(records, durations),
    };
  }

  private async probeSite(
    config: TvBoxConfig,
    site: TvBoxSite,
    sourceUrl: string | undefined,
    keywords: readonly string[],
    stages: ProbeStageLimiters,
  ): Promise<SourceCompatibilityRecord> {
    const normalized = normalizeFongMiSite(site, sourceUrl);
    const capabilities = detectCapabilities(site, normalized.categories);
    const base = baseRecord(site, normalized, capabilities);
    let engine: SourceProbeEngine | undefined;
    let metadata: SourceProbeMetadata = {};
    const timings: Record<string, number> = {};
    const setTiming = (name: string, durationMs: number): void => { timings[name] = durationMs; };

    try {
      await stages.init.run(async () => {
        metadata = this.options.runtimeForSite ? await this.options.runtimeForSite(site) : {};
        if (this.options.createEngine) {
          const started = this.options.now!();
          engine = await withTimeout(Promise.resolve(this.options.createEngine!(site)), this.options.initTimeoutMs, "SOURCE_INIT_TIMEOUT");
          setTiming("create", elapsed(this.options.now!, started));
        }
      });
    } catch (error) {
      return finish(base, metadata, timings, {
        init: failedPhase(error, this.options.initTimeoutMs),
        home: skippedPhase(),
        category: skippedPhase(),
        search: skippedPhase(),
        detail: skippedPhase(),
        player: skippedPhase(),
      });
    }

    if (!engine) {
      return finish(base, metadata, timings, {
        init: unknownPhase(),
        home: skippedPhase(),
        category: skippedPhase(),
        search: skippedPhase(),
        detail: skippedPhase(),
        player: skippedPhase(),
      });
    }
    const activeEngine = engine;

    let init: SourcePhaseResult = unknownPhase();
    try {
      await stages.init.run(async () => {
        init = await timedPhase("init", this.options.now!, this.options.initTimeoutMs, () => activeEngine.init(serializeFongMiExt(site.ext)));
        metadata = { ...metadata, ...(activeEngine.metadata ? await activeEngine.metadata() : {}) };
      });
    } catch (error) {
      await engine.destroy?.().catch(() => undefined);
      return finish(base, metadata, timings, {
        init: failedPhase(error, this.options.initTimeoutMs),
        home: skippedPhase(),
        category: skippedPhase(),
        search: skippedPhase(),
        detail: skippedPhase(),
        player: skippedPhase(),
      });
    }

    const home = activeEngine.home
      ? await probeOptional("home", this.options.now!, this.options.initTimeoutMs, () => activeEngine.home!())
      : skippedPhase();
    const category = activeEngine.category
      ? await probeOptional("category", this.options.now!, this.options.initTimeoutMs, () => activeEngine.category!())
      : skippedPhase();
    const search = await stages.search.run(() => probeSearch(activeEngine, keywords, this.options, this.options.now!));
    const searchItems = search.items;
    const details = search.phase.status === "PASS" && searchItems.length > 0
      ? await stages.detail.run(() => probeDetails(activeEngine, searchItems, this.options, this.options.now!))
      : { phase: search.phase.status === "EMPTY" ? skippedPhase() : search.phase.status === "FAIL" ? skippedPhase() : unknownPhase(), detail: null as VodDetail | null };
    const detail = details.detail;
    const player = detail && hasPlayback(detail)
      ? await stages.player.run(() => probePlayer(activeEngine, detail, base.authentication, this.options, this.options.now!))
      : skippedPhase();
    await engine.destroy?.().catch(() => undefined);

    return finish(base, metadata, timings, {
      init,
      home,
      category,
      search: search.phase,
      detail: details.phase,
      player,
    }, searchItems.length);
  }
}

export function detectCapabilities(site: TvBoxSite, categories: readonly string[] | undefined = undefined): SourceCompatibilityCapabilities {
  const text = semanticText([
    site.key,
    site.name,
    site.api,
    ...(categories ?? []),
    ...(Array.isArray(site.categories) ? site.categories : []),
  ]);
  const live = hasAny(text, ["直播", "live", "频道", "radio"]);
  const music = hasAny(text, ["音乐", "music", "kugou", "酷狗", "mv"]);
  const education = hasAny(text, ["教育", "课堂", "course", "lesson", "学习"]);
  const netdisk = hasAny(text, ["网盘", "云盘", "netdisk", "pansearch", "quark", "aliyun", "uc"]);
  const metadataOnly = hasAny(text, ["豆瓣", "douban", "预告", "metadata", "配置", "中心"]);
  const vod = !live && !music && !education && !netdisk;
  const requiresAuth = hasAny(text, ["uc", "夸克", "quark", "阿里", "aliyun", "baidu", "百度"]);
  const searchable = site.searchable !== 0 && site.searchable !== "0";
  return {
    home: site.type !== 3 || vod,
    category: site.type !== 3 || vod,
    search: searchable,
    detail: vod || netdisk,
    player: vod || netdisk,
    requiresAuth,
    metadataOnly,
    vod,
    live,
    music,
    education,
    netdisk,
  };
}

export function classifySourceCompatibility(input: {
  capabilities: SourceCompatibilityCapabilities;
  runtime: string;
  classLoad: SourceProbeClassLoad;
  init: SourcePhaseResult;
  search: SourcePhaseResult;
  detail: SourcePhaseResult;
  player: SourcePhaseResult;
  authentication?: SourceAuthProvider;
}): SourceCompatibilityStatus {
  if (input.authentication && input.authentication !== "NONE") return "AUTH_REQUIRED";
  if (input.classLoad === "FAIL") return "CLASS_NOT_FOUND";
  if (input.runtime === "unsupported") return "RUNTIME_INCOMPATIBLE";
  if (input.capabilities.metadataOnly && !input.capabilities.vod) return "METADATA_ONLY";
  if (input.capabilities.live && !input.capabilities.vod) return "LIVE_ONLY";
  if (input.capabilities.music && !input.capabilities.vod) return "MUSIC_ONLY";
  if (input.capabilities.education && !input.capabilities.vod) return "EDUCATION_ONLY";
  if (input.capabilities.netdisk && !input.capabilities.vod) return "NETDISK_ONLY";
  if (input.init.status === "FAIL") return input.init.errorCode === "SOURCE_TIMEOUT" ? "TIMEOUT" : "INIT_FAILED";
  if (input.search.status === "FAIL") return input.search.errorCode === "SOURCE_TIMEOUT" ? "TIMEOUT" : "SEARCH_FAILED";
  if (input.search.status === "UNKNOWN") return "UNKNOWN";
  if (input.search.status === "EMPTY") return "SEARCH_ONLY";
  if (input.detail.status === "FAIL") return input.detail.errorCode === "SOURCE_TIMEOUT" ? "TIMEOUT" : "DETAIL_FAILED";
  if (input.detail.status !== "PASS") return "SEARCH_ONLY";
  if (input.player.status === "PASS") return "FULLY_PLAYABLE";
  if (input.player.status === "FAIL") return input.player.errorCode === "SOURCE_TIMEOUT" ? "TIMEOUT" : "PLAYER_FAILED";
  return "SEARCH_DETAIL_ONLY";
}

function baseRecord(site: TvBoxSite, normalized: ReturnType<typeof normalizeFongMiSite>, capabilities: SourceCompatibilityCapabilities): SourceCompatibilityRecord {
  const runtime = normalized.type === 0 ? "cms-xml" : normalized.type === 1 || normalized.type === 4 ? "cms-json" : /^js:/iu.test(normalized.api) ? "javascript" : /^csp_/iu.test(normalized.api) ? "android-dex" : "unknown";
  return {
    siteKey: normalized.key,
    siteName: normalized.name,
    type: normalized.type,
    api: normalized.api,
    sourceCategory: categoryFor(capabilities),
    runtime,
    ...(runtime === "android-dex" ? { resolvedClass: expectedAndroidSpiderClass(normalized.api) } : {}),
    searchable: normalized.searchable,
    quickSearch: normalized.quickSearch,
    filterable: normalized.filterable,
    classLoad: "UNKNOWN",
    init: unknownPhase(),
    home: unknownPhase(),
    category: unknownPhase(),
    search: unknownPhase(),
    detail: unknownPhase(),
    player: unknownPhase(),
    authentication: detectAuthProvider(site, normalized.categories, capabilities.requiresAuth),
    playback: "NOT_ATTEMPTED",
    healthScore: 0,
    playable: false,
    capabilities,
    status: "UNKNOWN",
    timings: {},
  };
}

function finish(
  base: SourceCompatibilityRecord,
  metadata: SourceProbeMetadata,
  timings: Record<string, number>,
  phases: Pick<SourceCompatibilityRecord, "init" | "home" | "category" | "search" | "detail" | "player">,
  resultCount = 0,
): SourceCompatibilityRecord {
  const merged = { ...base, ...metadata, ...phases, timings: { ...timings, ...phaseTimings(phases) } };
  const classLoad = metadata.classLoad ?? base.classLoad;
  const authentication = metadata.authentication
    ?? phases.player.authProvider
    ?? (phases.player.status === "PASS" ? "NONE" : base.authentication);
  const status = classifySourceCompatibility({ ...merged, classLoad, authentication });
  const failureReason = failureReasonFor(status, phases, resultCount);
  const playback: SourceProbePlayback = phases.player.status === "PASS"
    ? "PASS"
    : phases.player.status === "FAIL" ? "FAIL" : "NOT_ATTEMPTED";
  return {
    ...merged,
    runtime: metadata.runtime ?? base.runtime,
    ...(metadata.resolvedClass ? { resolvedClass: metadata.resolvedClass } : {}),
    ...(metadata.artifact ? { artifact: metadata.artifact } : {}),
    ...(metadata.artifactSha256 ? { artifactSha256: metadata.artifactSha256 } : {}),
    ...(metadata.artifactSize === undefined ? {} : { artifactSize: metadata.artifactSize }),
    ...(metadata.jarId ? { jarId: metadata.jarId } : {}),
    ...(metadata.cacheHit === undefined ? {} : { cacheHit: metadata.cacheHit }),
    classLoad,
    authentication,
    playback,
    healthScore: probeHealthScore(phases),
    playable: status === "FULLY_PLAYABLE",
    status,
    ...(failureReason ? { failureReason } : {}),
  };
}

function failureReasonFor(status: SourceCompatibilityStatus, phases: SourceCompatibilityRecord["init"] extends never ? never : Pick<SourceCompatibilityRecord, "init" | "search" | "detail" | "player">, resultCount: number): string | undefined {
  if (status === "FULLY_PLAYABLE" || status === "SEARCH_ONLY" || status === "SEARCH_DETAIL_ONLY") return undefined;
  const phase = status === "INIT_FAILED" || status === "CLASS_NOT_FOUND" ? phases.init
    : status === "SEARCH_FAILED" ? phases.search
      : status === "DETAIL_FAILED" ? phases.detail
        : phases.player;
  return phase.message ?? phase.errorCode ?? (resultCount === 0 ? "no_results" : status);
}

function phaseTimings(phases: Pick<SourceCompatibilityRecord, "init" | "home" | "category" | "search" | "detail" | "player">): Record<string, number> {
  return Object.fromEntries(Object.entries(phases).map(([key, value]) => [`${key}Ms`, value.durationMs]));
}

function categoryFor(capabilities: SourceCompatibilityCapabilities): SourceCompatibilityCategory {
  if (capabilities.metadataOnly && !capabilities.vod) return "METADATA";
  if (capabilities.live && !capabilities.vod) return "LIVE";
  if (capabilities.music && !capabilities.vod) return "MUSIC";
  if (capabilities.education && !capabilities.vod) return "EDUCATION";
  if (capabilities.netdisk && !capabilities.vod) return "NETDISK";
  if (capabilities.vod) return "VOD";
  return "UNKNOWN";
}

function probeHealthScore(phases: Pick<SourceCompatibilityRecord, "search" | "detail" | "player">): number {
  const rate = (phase: SourcePhaseResult): number => {
    if (phase.attempts && phase.attempts > 0) return (phase.successCount ?? (phase.status === "PASS" || phase.status === "EMPTY" ? phase.attempts : 0)) / phase.attempts;
    return phase.status === "PASS" ? 1 : 0;
  };
  const latency = phases.search.durationMs + phases.detail.durationMs + phases.player.durationMs;
  const speed = Math.max(0, Math.min(1, 1 - latency / 12_000));
  return Math.max(0, Math.min(100, Math.round(rate(phases.search) * 25 + rate(phases.detail) * 20 + rate(phases.player) * 25 + speed * 15 + (phases.player.status === "PASS" ? 10 : 0))));
}

async function probeSearch(
  engine: SourceProbeEngine,
  keywords: readonly string[],
  options: SourceCompatibilityAuditorOptions,
  now: () => number,
): Promise<{ phase: SourcePhaseResult; items: readonly Vod[] }> {
  const durations: number[] = [];
  const items: Vod[] = [];
  let failed: SourcePhaseResult | undefined;
  let successCount = 0;
  let failureCount = 0;
  for (const keyword of keywords) {
    const result = await probeOptional("search", now, options.searchTimeoutMs ?? 12_000, async () => {
      const page = await engine.search(keyword, false, 1);
      const values = Array.isArray(page.items) ? page.items : [];
      items.push(...values);
      return values.length;
    });
    durations.push(result.durationMs);
    if (result.status === "FAIL") {
      failed = result;
      failureCount += 1;
    } else {
      successCount += 1;
    }
  }
  if (failed && successCount === 0) return { phase: { ...failed, durationMs: sum(durations), attempts: keywords.length, successCount, failureCount }, items };
  if (items.length === 0) return { phase: { status: "EMPTY", durationMs: sum(durations), resultCount: 0, attempts: keywords.length, successCount, failureCount, ...percentileTimings(durations) }, items };
  return { phase: { status: "PASS", durationMs: sum(durations), resultCount: items.length, attempts: keywords.length, successCount, failureCount, ...percentileTimings(durations) }, items };
}

async function probeDetails(
  engine: SourceProbeEngine,
  items: readonly Vod[],
  options: SourceCompatibilityAuditorOptions,
  now: () => number,
): Promise<{ phase: SourcePhaseResult; detail: VodDetail | null }> {
  const selected = items.slice(0, 3).filter((item) => typeof item.id === "string" && item.id.length > 0);
  const started = now();
  try {
    const details = await withTimeout(engine.detail(selected.map((item) => item.id)), options.detailTimeoutMs ?? 15_000, "SOURCE_DETAIL_TIMEOUT");
    const detail = details.find((item) => Boolean(item)) ?? null;
    return {
      phase: { status: detail ? "PASS" : "EMPTY", durationMs: elapsed(now, started), resultCount: details.length },
      detail,
    };
  } catch (error) {
    return { phase: failedPhase(error, options.detailTimeoutMs ?? 15_000), detail: null };
  }
}

async function probePlayer(
  engine: SourceProbeEngine,
  detail: VodDetail,
  defaultAuthProvider: SourceAuthProvider,
  options: SourceCompatibilityAuditorOptions,
  now: () => number,
): Promise<SourcePhaseResult> {
  const line = playbackRequest(detail);
  if (!line) return { status: "EMPTY", durationMs: 0, resultCount: 0 };
  const started = now();
  try {
    const result = await withTimeout(engine.player(line), options.playerTimeoutMs ?? 15_000, "SOURCE_PLAYER_TIMEOUT");
    const auth = result.status === "AUTH_REQUIRED" || /(?:login|auth|credential|登录|授权)/iu.test(result.message ?? "");
    return {
      status: auth ? "FAIL" : result.url ? "PASS" : "FAIL",
      durationMs: elapsed(now, started),
      resultCount: result.url ? 1 : 0,
      ...(auth ? { authProvider: defaultAuthProvider === "NONE" ? "OTHER" : defaultAuthProvider } : {}),
      ...(auth ? { errorCode: "AUTH_REQUIRED", message: result.message ?? "authentication required" } : result.url ? {} : { errorCode: "PLAYER_FAILED", message: "player returned no url" }),
      retryable: !auth,
    };
  } catch (error) {
    return { ...failedPhase(error, options.playerTimeoutMs ?? 15_000), retryable: isRetryable(error) };
  }
}

async function timedPhase(name: string, now: () => number, timeoutMs: number, action: () => Promise<unknown>): Promise<SourcePhaseResult> {
  const started = now();
  try {
    await withTimeout(action(), timeoutMs, "SOURCE_TIMEOUT");
    return { status: "PASS", durationMs: elapsed(now, started) };
  } catch (error) {
    return failedPhase(error, timeoutMs, elapsed(now, started), name);
  }
}

async function probeOptional(name: string, now: () => number, timeoutMs: number, action: () => Promise<unknown>): Promise<SourcePhaseResult> {
  return timedPhase(name, now, timeoutMs, async () => {
    const result = await action();
    return result;
  });
}

function playbackRequest(detail: VodDetail): PlayerRequest | null {
  const from = typeof detail.vod_play_from === "string" ? detail.vod_play_from.split("$$$") : [];
  const urls = typeof detail.vod_play_url === "string" ? detail.vod_play_url.split("$$$") : [];
  for (let index = 0; index < urls.length; index += 1) {
    const first = urls[index]?.split("#")[0]?.trim() ?? "";
    const separator = first.indexOf("$");
    const id = separator >= 0 ? first.slice(separator + 1).trim() : first;
    if (id) return { flag: from[index]?.trim() ?? "", id };
  }
  return null;
}

function hasPlayback(value: VodDetail): boolean {
  return typeof value.vod_play_from === "string" && value.vod_play_from.trim().length > 0
    && typeof value.vod_play_url === "string" && value.vod_play_url.trim().length > 0;
}

function failedPhase(error: unknown, timeoutMs: number, durationMs = timeoutMs, stage = "source"): SourcePhaseResult {
  const timeout = isTimeout(error);
  const message = safeMessage(error);
  return {
    status: "FAIL",
    durationMs: Math.max(0, durationMs),
    errorCode: timeout ? "SOURCE_TIMEOUT" : errorCode(error) ?? `${stage.toUpperCase()}_FAILED`,
    message,
    retryable: timeout || isRetryable(error),
  };
}

function skippedPhase(): SourcePhaseResult { return { status: "SKIPPED", durationMs: 0 }; }
function unknownPhase(): SourcePhaseResult { return { status: "UNKNOWN", durationMs: 0 }; }
function elapsed(now: () => number, started: number): number { return Math.max(0, now() - started); }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function sumTiming(values: Readonly<Record<string, number>>): number { return sum(Object.values(values)); }

function normalizeKeywords(values: readonly string[] | undefined): string[] {
  const configured = values ?? (process.env.QX_G105_KEYWORDS
    ?? [process.env.QX_SOURCE_PROBE_MOVIE ?? "movie", process.env.QX_SOURCE_PROBE_TV ?? "tv", process.env.QX_SOURCE_PROBE_ANIME ?? "anime"].join(",")).split(",");
  const keywords = [...new Set(configured.map((value) => value.trim()).filter(Boolean))];
  return keywords.length >= 3 ? keywords : [...keywords, "movie", "tv", "anime"].filter((value, index, all) => all.indexOf(value) === index).slice(0, 3);
}

function semanticText(values: readonly unknown[]): string {
  return values.filter((value): value is string => typeof value === "string")
    .join(" ").normalize("NFKC").toLocaleLowerCase().replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, " ");
}

function hasAny(text: string, terms: readonly string[]): boolean { return terms.some((term) => text.includes(term)); }

function detectAuthProvider(site: TvBoxSite, categories: readonly string[] | undefined, requiresAuth: boolean): SourceAuthProvider {
  if (!requiresAuth) return "NONE";
  const text = semanticText([site.key, site.name, site.api, ...(categories ?? [])]);
  if (hasAny(text, ["uc", "澶稿厠"])) return "UC";
  if (hasAny(text, ["aliyun", "闃块噷"])) return "ALIYUN";
  if (hasAny(text, ["quark", "澶歌"])) return "QUARK";
  if (hasAny(text, ["baidu", "鐧惧害"])) return "BAIDU";
  return "UNKNOWN";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/giu, "[redacted-url]").replace(/(?:cookie|authorization|token|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
}

function isTimeout(error: unknown): boolean { return errorCode(error) === "SOURCE_TIMEOUT" || /timeout/i.test(safeMessage(error)); }
function isRetryable(error: unknown): boolean {
  const code = errorCode(error) ?? "";
  return ["SOURCE_TIMEOUT", "PLAYER_FAILED", "MEDIA_HTTP_403", "MEDIA_HTTP_404", "HLS_MANIFEST_FAILED", "HLS_SEGMENT_FAILED", "PLAYER_FATAL_ERROR"].some((value) => code.includes(value));
}

function percentileTimings(values: readonly number[]): Pick<SourcePhaseResult, "p50Ms" | "p90Ms" | "p95Ms"> {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)] ?? 0;
}

function summarizeRecords(records: readonly SourceCompatibilityRecord[], durations: readonly number[]): SourceCompatibilitySummary {
  const statusCounts = Object.fromEntries(SOURCE_COMPATIBILITY_STATUSES.map((status) => [status, records.filter((record) => record.status === status).length])) as Record<SourceCompatibilityStatus, number>;
  const runtimeCounts: Record<string, number> = {};
  for (const record of records) runtimeCounts[record.runtime] = (runtimeCounts[record.runtime] ?? 0) + 1;
  const stats = percentileTimings(durations);
  return { total: records.length, searchable: records.filter((record) => record.searchable).length, statusCounts, runtimeCounts, p50Ms: stats.p50Ms ?? 0, p90Ms: stats.p90Ms ?? 0, p95Ms: stats.p95Ms ?? 0 };
}

interface ProbeStageLimiters {
  init: StageLimiter;
  search: StageLimiter;
  detail: StageLimiter;
  player: StageLimiter;
}

class StageLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  public async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit || this.queue.length > 0) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

async function mapLimited<T, R>(values: readonly T[], limit: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await action(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker()));
  return output;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(code) as Error & { code: string };
        error.code = code;
        reject(error);
      }, timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
