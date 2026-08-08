import { parseVodPlayback, type PlaybackCatalog } from "./vod-playback.js";
import type { Vod } from "../source/media-source.js";

export interface PlaybackSourceSite {
  siteKey: string;
  siteName: string;
  enabled: boolean;
  searchable: boolean;
  playback: boolean;
  metadataOnly?: boolean;
  search: (query: string, timeoutMs: number) => Promise<readonly Vod[]>;
  detail: (vodId: string, timeoutMs: number) => Promise<Vod | null>;
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
}

export interface PlaybackSourceResolverOptions {
  currentSiteKey?: string | null;
  concurrency?: number;
  perSiteTimeoutMs?: number;
  globalTimeoutMs?: number;
  maxCandidatesPerSite?: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_PER_SITE_TIMEOUT_MS = 7_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CANDIDATES_PER_SITE = 3;

export class PlaybackSourceResolver {
  public async resolve(
    currentVod: Vod,
    sites: readonly PlaybackSourceSite[],
    options: PlaybackSourceResolverOptions = {},
  ): Promise<PlaybackSourceResolution> {
    const query = vodName(currentVod);
    const eligible = sites.filter((site) => (
      site.enabled
      && site.searchable
      && site.playback
      && !site.metadataOnly
      && site.siteKey !== (options.currentSiteKey ?? null)
    ));
    const searchedSites = eligible.map((site) => site.siteKey);
    const successfulSites: string[] = [];
    const failedSites: PlaybackSourceFailure[] = [];
    const candidates: PlayableCandidate[] = [];
    const perSiteTimeoutMs = options.perSiteTimeoutMs ?? DEFAULT_PER_SITE_TIMEOUT_MS;
    const maxCandidatesPerSite = options.maxCandidatesPerSite ?? DEFAULT_MAX_CANDIDATES_PER_SITE;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY));
    let nextIndex = 0;
    let stopped = false;

    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = nextIndex;
        nextIndex += 1;
        const site = eligible[index];
        if (!site) return;
        try {
          const results = await withTimeout(
            site.search(query, perSiteTimeoutMs),
            perSiteTimeoutMs,
            `搜索超时：${site.siteKey}`,
          );
          successfulSites.push(site.siteKey);
          const matched = results
            .map((vod) => ({ vod, score: scoreVod(currentVod, vod) }))
            .filter((value): value is { vod: Vod; score: number } => value.score >= 50)
            .sort((left, right) => right.score - left.score)
            .slice(0, maxCandidatesPerSite);

          for (const match of matched) {
            if (stopped) return;
            const detail = await withTimeout(
              site.detail(vodId(match.vod), perSiteTimeoutMs),
              perSiteTimeoutMs,
              `详情超时：${site.siteKey}`,
            );
            const vod = detail ?? match.vod;
            const hasPlayFrom = hasPlaybackField(vod, "vod_play_from");
            const hasPlayUrl = hasPlaybackField(vod, "vod_play_url");
            let lines: PlaybackCatalog | undefined;
            if (hasPlayFrom && hasPlayUrl) {
              try {
                const parsed = parseVodPlayback(vod);
                if (parsed) lines = parsed;
              } catch {
                lines = undefined;
              }
            }
            candidates.push({
              siteKey: site.siteKey,
              siteName: site.siteName,
              vod,
              score: match.score,
              playable: Boolean(lines && lines.lines.some((line) => line.episodes.length > 0)),
              ...(lines ? { lines } : {}),
              hasPlayFrom,
              hasPlayUrl,
            });
          }
        } catch (error) {
          failedSites.push({ siteKey: site.siteKey, message: safeErrorMessage(error) });
        }
      }
    };

    const work = Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, () => worker()));
    let globalTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      timedOut = await Promise.race([
        work.then(() => false),
        new Promise<boolean>((resolve) => {
          globalTimer = setTimeout(() => resolve(true), options.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (globalTimer !== undefined) clearTimeout(globalTimer);
    }
    stopped = true;
    if (timedOut) void work.catch(() => undefined);
    else await work.catch(() => undefined);

    candidates.sort((left, right) => right.score - left.score || left.siteKey.localeCompare(right.siteKey));
    return {
      query,
      searchedSites: [...searchedSites],
      successfulSites: [...successfulSites],
      failedSites: failedSites.map((failure) => ({ ...failure })),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        vod: { ...candidate.vod, raw: { ...candidate.vod.raw } },
        ...(candidate.lines ? { lines: { lines: candidate.lines.lines.map((line) => ({ ...line, episodes: line.episodes.map((episode) => ({ ...episode })) })) } } : {}),
      })),
    };
  }
}

export function scoreVod(current: Vod, candidate: Vod): number {
  const currentTitle = vodName(current);
  const candidateTitle = vodName(candidate);
  const normalizedCurrent = normalizeText(currentTitle);
  const normalizedCandidate = normalizeText(candidateTitle);
  if (!normalizedCurrent || normalizedCurrent !== normalizedCandidate || !hasMinimumMetadata(current, candidate)) return 0;

  let score = currentTitle.toLocaleLowerCase() === candidateTitle.toLocaleLowerCase() ? 60 : 0;
  score += 50;
  if (sameField(current, candidate, ["vod_year", "year"])) score += 20;
  if (sameField(current, candidate, ["type_name", "vod_class", "type", "category"])) score += 10;
  if (sameField(current, candidate, ["vod_area", "area"])) score += 5;
  if (sameField(current, candidate, ["vod_director", "director"])) score += 5;
  return score;
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
  const leftValue = normalizeText(stringField(left, fields));
  const rightValue = normalizeText(stringField(right, fields));
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

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasPlaybackField(vod: Vod, field: "vod_play_from" | "vod_play_url"): boolean {
  return typeof vod[field] === "string" && vod[field].trim().length > 0;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
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
