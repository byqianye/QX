import { mergeVodDisplayFields } from "./vod-merge.js";
import { parseVodPlayback, type PlaybackCatalog } from "./vod-playback.js";
import { sanitizeHealthMessage } from "../health/source-health.js";
import type { Vod } from "../source/media-source.js";

export type SiteFlag = boolean | number | string | null | undefined;

export interface PlaybackSourceEngine {
  init(ext?: string): Promise<void>;
  search(query: string, quick: boolean, page: number): Promise<readonly Vod[]>;
  detail(vodId: string): Promise<Vod | null>;
}

/**
 * The resolver owns the search workflow, while the factory owns the runtime
 * binding and lazy initialization for a configured site.
 */
export interface SourceEngineFactory {
  create(site: PlaybackSourceSite): Promise<PlaybackSourceEngine> | PlaybackSourceEngine;
}

export interface PlaybackSourceSite {
  siteKey: string;
  siteName: string;
  type?: number | null;
  api?: string;
  ext?: string;
  enabled?: boolean;
  searchable?: SiteFlag;
  quickSearch?: SiteFlag;
  supported?: boolean;
  engine?: string | null;
  skipReason?: string;
  metadataOnly?: boolean;
  /** Kept as diagnostic metadata only. It must never gate search eligibility. */
  playback?: boolean;
  /** Legacy test seam. Production uses SourceEngineFactory. */
  search?: (query: string, timeoutMs: number) => Promise<readonly Vod[]>;
  /** Legacy test seam. Production uses SourceEngineFactory. */
  detail?: (vodId: string, timeoutMs: number) => Promise<Vod | null>;
}

export interface PlayableCandidate {
  siteKey: string;
  siteName: string;
  vod: Vod;
  score: number;
  playable: boolean;
  lines?: PlaybackCatalog;
  hasPlayFrom: boolean;
  hasPlayUrl: boolean;
}

export type PlaybackSiteInitializationStatus = "success" | "failed" | "unsupported" | "skipped";
export type PlaybackSiteSearchStatus = "success" | "empty" | "timeout" | "error" | "skipped";
export type PlaybackSiteMatchStatus = "matched" | "rejected" | "not_attempted";
export type PlaybackSiteDetailStatus = "success" | "failed" | "not_attempted";

export interface PlaybackSiteDiagnostic {
  siteKey: string;
  siteName: string;
  type: number | null;
  apiType: number | null;
  api: string | null;
  engine: string | null;
  searchable: SiteFlag;
  quickSearch: SiteFlag;
  supported: boolean;
  initialization: PlaybackSiteInitializationStatus;
  search: PlaybackSiteSearchStatus;
  resultCount: number;
  matched: PlaybackSiteMatchStatus;
  matchScore: number | null;
  matchedCandidateCount: number;
  detail: PlaybackSiteDetailStatus;
  detailSuccessCount: number;
  hasPlayFrom: boolean;
  hasPlayUrl: boolean;
  skipReason: string | null;
}

export interface PlaybackSourceDiagnostics {
  configSiteCount: number;
  searchableSites: number;
  runtimeSupportedSites: number;
  unsupportedSiteCount: number;
  searchedSites: readonly string[];
  searchSuccessSites: readonly string[];
  searchFailedSites: readonly string[];
  searchResultCount: number;
  matchedCandidateCount: number;
  detailSuccessCount: number;
  playableCandidateCount: number;
  sites: readonly PlaybackSiteDiagnostic[];
}

export interface PlaybackSourceFailure {
  siteKey: string;
  message: string;
}

export interface PlaybackSourceResolution {
  query: string;
  searchedSites: readonly string[];
  successfulSites: readonly string[];
  failedSites: readonly PlaybackSourceFailure[];
  candidates: readonly PlayableCandidate[];
  diagnostics: PlaybackSourceDiagnostics;
}

export interface PlaybackSourceResolverOptions {
  currentSiteKey?: string | null;
  configSiteCount?: number;
  engineFactory?: SourceEngineFactory;
  concurrency?: number;
  perSiteTimeoutMs?: number;
  globalTimeoutMs?: number;
  maxCandidatesPerSite?: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_PER_SITE_TIMEOUT_MS = 8_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CANDIDATES_PER_SITE = 3;

interface SiteRunResult {
  site: PlaybackSourceSite;
  diagnostic: PlaybackSiteDiagnostic;
  candidates: PlayableCandidate[];
  failure?: PlaybackSourceFailure;
}

export class PlaybackSourceResolver {
  public async resolve(
    currentVod: Vod,
    sites: readonly PlaybackSourceSite[],
    options: PlaybackSourceResolverOptions = {},
  ): Promise<PlaybackSourceResolution> {
    const query = vodName(currentVod);
    const currentSiteKey = options.currentSiteKey ?? null;
    const diagnostics = sites.map((site) => initialDiagnostic(site));
    const diagnosticBySite = new Map(diagnostics.map((diagnostic) => [diagnostic.siteKey, diagnostic]));
    const searchableSites = sites.filter((site) => isSearchEligible(site, currentSiteKey));
    const runtimeSites = searchableSites.filter((site) => site.supported !== false);
    for (const site of sites) {
      const diagnostic = diagnosticBySite.get(site.siteKey);
      if (!diagnostic) continue;
      const skipReason = skipReasonFor(site, currentSiteKey);
      if (skipReason) {
        diagnostic.skipReason = skipReason;
        diagnostic.initialization = site.supported === false ? "unsupported" : "skipped";
        diagnostic.search = "skipped";
      }
    }

    const successfulSites: string[] = [];
    const searchedSiteKeys: string[] = [];
    const failedSites: PlaybackSourceFailure[] = [];
    const candidates: PlayableCandidate[] = [];
    const perSiteTimeoutMs = options.perSiteTimeoutMs ?? DEFAULT_PER_SITE_TIMEOUT_MS;
    const globalTimeoutMs = options.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS;
    const maxCandidatesPerSite = options.maxCandidatesPerSite ?? DEFAULT_MAX_CANDIDATES_PER_SITE;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY));
    const engineFactory = options.engineFactory;
    let nextIndex = 0;
    let stopped = false;
    const started = new Set<string>();
    const completed = new Set<string>();

    const recordResult = (result: SiteRunResult): void => {
      if (stopped) return;
      completed.add(result.site.siteKey);
      const diagnostic = diagnosticBySite.get(result.site.siteKey);
      if (diagnostic) Object.assign(diagnostic, result.diagnostic);
      searchedSiteKeys.push(result.site.siteKey);
      if (result.diagnostic.search === "success" || result.diagnostic.search === "empty") {
        successfulSites.push(result.site.siteKey);
      }
      if (result.failure) failedSites.push(result.failure);
      candidates.push(...result.candidates);
    };

    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = nextIndex;
        nextIndex += 1;
        const site = runtimeSites[index];
        if (!site) return;
        started.add(site.siteKey);
        const result = await runSite(site, currentVod, query, {
          ...(engineFactory ? { engineFactory } : {}),
          perSiteTimeoutMs,
          maxCandidatesPerSite,
        });
        recordResult(result);
      }
    };

    const work = Promise.all(
      Array.from({ length: Math.min(concurrency, runtimeSites.length) }, () => worker()),
    );
    let globalTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      timedOut = await Promise.race([
        work.then(() => false),
        new Promise<boolean>((resolve) => {
          globalTimer = setTimeout(() => resolve(true), globalTimeoutMs);
        }),
      ]);
    } finally {
      if (globalTimer !== undefined) clearTimeout(globalTimer);
    }
    stopped = true;
    if (timedOut) {
      for (const siteKey of started) {
        if (completed.has(siteKey)) continue;
        const diagnostic = diagnosticBySite.get(siteKey);
        if (diagnostic) {
          diagnostic.search = "timeout";
          diagnostic.skipReason = "global_timeout";
        }
        failedSites.push({ siteKey, message: `搜索超时：${siteKey}` });
      }
      void work.catch(() => undefined);
    } else {
      await work.catch(() => undefined);
    }

    candidates.sort((left, right) => right.score - left.score || left.siteKey.localeCompare(right.siteKey));
    const diagnosticList = sites.map((site) => cloneDiagnostic(diagnosticBySite.get(site.siteKey) ?? initialDiagnostic(site)));
    const searchSuccessSites = diagnosticList
      .filter((diagnostic) => diagnostic.search === "success" || diagnostic.search === "empty")
      .map((diagnostic) => diagnostic.siteKey);
    const searchFailedSites = diagnosticList
      .filter((diagnostic) => diagnostic.search === "timeout" || diagnostic.search === "error")
      .map((diagnostic) => diagnostic.siteKey);
    const finalDiagnostics: PlaybackSourceDiagnostics = {
      configSiteCount: options.configSiteCount ?? sites.length,
      searchableSites: searchableSites.length,
      runtimeSupportedSites: runtimeSites.length,
      unsupportedSiteCount: sites.filter((site) => site.supported === false).length,
      searchedSites: [...searchedSiteKeys],
      searchSuccessSites,
      searchFailedSites,
      searchResultCount: diagnosticList.reduce((total, diagnostic) => total + diagnostic.resultCount, 0),
      matchedCandidateCount: diagnosticList.reduce((total, diagnostic) => total + diagnostic.matchedCandidateCount, 0),
      detailSuccessCount: diagnosticList.reduce((total, diagnostic) => total + diagnostic.detailSuccessCount, 0),
      playableCandidateCount: candidates.filter((candidate) => candidate.playable).length,
      sites: diagnosticList,
    };

    return {
      query,
      searchedSites: [...searchedSiteKeys],
      successfulSites: [...successfulSites],
      failedSites: failedSites.map((failure) => ({ ...failure })),
      candidates: candidates.map(cloneCandidate),
      diagnostics: cloneDiagnostics(finalDiagnostics),
    };
  }
}

export function scoreVod(current: Vod, candidate: Vod): number {
  const currentTitle = vodName(current);
  const candidateTitle = vodName(candidate);
  const normalizedCurrent = normalizeVodTitle(currentTitle);
  const normalizedCandidate = normalizeVodTitle(candidateTitle);
  if (!normalizedCurrent || normalizedCurrent !== normalizedCandidate || !hasMinimumMetadata(current, candidate)) return 0;

  let score = currentTitle.trim().toLocaleLowerCase() === candidateTitle.trim().toLocaleLowerCase() ? 60 : 0;
  score += 50;
  if (sameField(current, candidate, ["vod_year", "year"])) score += 20;
  if (sameField(current, candidate, ["type_name", "vod_class", "type", "category"])) score += 10;
  if (sameField(current, candidate, ["vod_area", "area"])) score += 5;
  if (sameField(current, candidate, ["vod_director", "director"])) score += 5;
  return score;
}

export function normalizeVodTitle(value: string): string {
  return decodeHtmlEntities(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/[：:]/gu, ":")
    .replace(/[·・]/gu, "·")
    .replace(/[，,]/gu, ",")
    .replace(/[。．.]/gu, ".")
    .replace(/[！!]/gu, "!")
    .replace(/[？?]/gu, "?")
    .replace(/[\s\u200B]+/gu, "");
}

async function runSite(
  site: PlaybackSourceSite,
  currentVod: Vod,
  query: string,
  options: {
    engineFactory?: SourceEngineFactory;
    perSiteTimeoutMs: number;
    maxCandidatesPerSite: number;
  },
): Promise<SiteRunResult> {
  const diagnostic = initialDiagnostic(site);
  const candidates: PlayableCandidate[] = [];
  const deadline = Date.now() + options.perSiteTimeoutMs;
  const withRemainingTimeout = <T>(promise: Promise<T>, message: string): Promise<T> => {
    const remaining = Math.max(1, deadline - Date.now());
    return withTimeout(promise, remaining, message);
  };

  try {
    const engine = await withRemainingTimeout(
      getEngine(site, options.engineFactory),
      `初始化超时：${site.siteKey}`,
    );
    await withRemainingTimeout(engine.init(site.ext), `初始化超时：${site.siteKey}`);
    diagnostic.initialization = "success";
    const results = await withRemainingTimeout(
      engine.search(query, false, 1),
      `搜索超时：${site.siteKey}`,
    );
    diagnostic.resultCount = results.length;
    diagnostic.search = results.length > 0 ? "success" : "empty";
    const matches = results
      .map((vod) => ({ vod, score: scoreVod(currentVod, vod) }))
      .filter((value): value is { vod: Vod; score: number } => value.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.maxCandidatesPerSite);
    diagnostic.matched = matches.length > 0 ? "matched" : "rejected";
    diagnostic.matchScore = matches[0]?.score ?? null;
    diagnostic.matchedCandidateCount = matches.length;

    for (const match of matches) {
      let detail: Vod | null = null;
      try {
        detail = await withRemainingTimeout(
          engine.detail(vodId(match.vod)),
          `详情超时：${site.siteKey}`,
        );
        if (detail) {
          diagnostic.detail = "success";
          diagnostic.detailSuccessCount += 1;
        }
        else if (diagnostic.detail === "not_attempted") diagnostic.detail = "failed";
      } catch (error) {
        diagnostic.detail = "failed";
        diagnostic.skipReason = safeErrorMessage(error);
      }
      const merged = detail ? mergeVodDisplayFields(match.vod, detail) : match.vod;
      const vod = asVod(merged ?? match.vod, match.vod);
      const hasPlayFrom = hasPlaybackField(vod, "vod_play_from");
      const hasPlayUrl = hasPlaybackField(vod, "vod_play_url");
      diagnostic.hasPlayFrom ||= hasPlayFrom;
      diagnostic.hasPlayUrl ||= hasPlayUrl;
      let lines: PlaybackCatalog | undefined;
      if (hasPlayFrom && hasPlayUrl) {
        try {
          lines = parseVodPlayback(vod) ?? undefined;
        } catch {
          lines = undefined;
        }
      }
      candidates.push({
        siteKey: site.siteKey,
        siteName: site.siteName,
        vod,
        score: match.score,
        playable: hasPlayFrom && hasPlayUrl,
        ...(lines ? { lines } : {}),
        hasPlayFrom,
        hasPlayUrl,
      });
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    const timeout = /超时|timeout/i.test(message);
    diagnostic.initialization = "failed";
    diagnostic.search = timeout ? "timeout" : "error";
    diagnostic.skipReason = message;
    return {
      site,
      diagnostic,
      candidates,
      failure: { siteKey: site.siteKey, message },
    };
  }

  return { site, diagnostic, candidates };
}

async function getEngine(
  site: PlaybackSourceSite,
  factory: SourceEngineFactory | undefined,
): Promise<PlaybackSourceEngine> {
  if (factory) return factory.create(site);
  if (site.search && site.detail) {
    return {
      init: async () => undefined,
      search: async (query, _quick, _page) => site.search!(query, 8_000),
      detail: async (vodId) => site.detail!(vodId, 8_000),
    };
  }
  throw new Error(`搜索引擎不可用：${site.siteKey}`);
}

function initialDiagnostic(site: PlaybackSourceSite): PlaybackSiteDiagnostic {
  return {
    siteKey: site.siteKey,
    siteName: site.siteName,
    type: typeof site.type === "number" ? site.type : null,
    apiType: typeof site.type === "number" ? site.type : null,
    api: typeof site.api === "string" ? site.api : null,
    engine: site.engine ?? null,
    searchable: site.searchable === undefined ? true : site.searchable,
    quickSearch: site.quickSearch === undefined ? false : site.quickSearch,
    supported: site.supported !== false,
    initialization: "skipped",
    search: "skipped",
    resultCount: 0,
    matched: "not_attempted",
    matchScore: null,
    matchedCandidateCount: 0,
    detail: "not_attempted",
    detailSuccessCount: 0,
    hasPlayFrom: false,
    hasPlayUrl: false,
    skipReason: null,
  };
}

function isSearchEligible(site: PlaybackSourceSite, currentSiteKey: string | null): boolean {
  return site.siteKey !== currentSiteKey
    && site.enabled !== false
    && site.metadataOnly !== true
    && isSearchable(site.searchable);
}

function skipReasonFor(site: PlaybackSourceSite, currentSiteKey: string | null): string | null {
  if (site.siteKey === currentSiteKey) return "current_site";
  if (site.metadataOnly) return "metadata_only";
  if (site.enabled === false) return site.skipReason ?? "site_disabled";
  if (!isSearchable(site.searchable)) return site.skipReason ?? "searchable_0";
  if (site.supported === false) return site.skipReason ?? "unsupported_runtime";
  return null;
}

function isSearchable(value: SiteFlag): boolean {
  if (value === false || value === 0) return false;
  if (typeof value === "string" && value.trim() === "0") return false;
  return true;
}

function hasMinimumMetadata(current: Vod, candidate: Vod): boolean {
  return Boolean(
    stringField(current, ["vod_year", "year"])
      && stringField(candidate, ["vod_year", "year"])
      && stringField(current, ["type_name", "vod_class", "type", "category"])
      && stringField(candidate, ["type_name", "vod_class", "type", "category"]),
  );
}

function vodName(vod: Vod): string {
  return stringField(vod, ["vod_name", "name", "title"]);
}

function vodId(vod: Vod): string {
  return stringField(vod, ["vod_id", "id", "itemId"]);
}

function sameField(left: Vod, right: Vod, fields: readonly string[]): boolean {
  const leftValue = normalizeVodTitle(stringField(left, fields));
  const rightValue = normalizeVodTitle(stringField(right, fields));
  return Boolean(leftValue && leftValue === rightValue);
}

function stringField(vod: Vod, fields: readonly string[]): string {
  for (const field of fields) {
    const value = vod[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function hasPlaybackField(vod: Vod, field: "vod_play_from" | "vod_play_url"): boolean {
  return typeof vod[field] === "string" && vod[field].trim().length > 0;
}

function asVod(value: Record<string, unknown>, fallback: Vod): Vod {
  const id = stringField(value as Vod, ["vod_id", "id", "itemId"]) || fallback.id;
  const name = stringField(value as Vod, ["vod_name", "name", "title"]) || fallback.name;
  return {
    ...value,
    id,
    name,
    raw: isRecord(value.raw) ? { ...value.raw } : { ...fallback.raw },
  };
}

function cloneCandidate(candidate: PlayableCandidate): PlayableCandidate {
  return {
    ...candidate,
    vod: { ...candidate.vod, raw: { ...candidate.vod.raw } },
    ...(candidate.lines ? {
      lines: {
        lines: candidate.lines.lines.map((line) => ({
          ...line,
          episodes: line.episodes.map((episode) => ({ ...episode })),
        })),
      },
    } : {}),
  };
}

function cloneDiagnostic(diagnostic: PlaybackSiteDiagnostic): PlaybackSiteDiagnostic {
  return { ...diagnostic };
}

function cloneDiagnostics(diagnostics: PlaybackSourceDiagnostics): PlaybackSourceDiagnostics {
  return {
    ...diagnostics,
    searchedSites: [...diagnostics.searchedSites],
    searchSuccessSites: [...diagnostics.searchSuccessSites],
    searchFailedSites: [...diagnostics.searchFailedSites],
    sites: diagnostics.sites.map(cloneDiagnostic),
  };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
    nbsp: " ",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
    const lower = code.toLocaleLowerCase();
    if (lower.startsWith("#x")) {
      const parsed = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(Math.min(parsed, 0x10ffff)) : entity;
    }
    if (lower.startsWith("#")) {
      const parsed = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(Math.min(parsed, 0x10ffff)) : entity;
    }
    return named[lower] ?? entity;
  });
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeHealthMessage(message)
    .replace(/\b(cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
