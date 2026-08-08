import type { TvBoxConfig, TvBoxSite } from "./decoder.js";

export interface FongMiSiteConfig {
  key: string;
  name: string;
  type: number;
  api: string;
  ext?: unknown;
  jar?: string;
  endpoint?: string;
  searchable: boolean;
  quickSearch: boolean;
  filterable: boolean;
  changeable: boolean;
  timeoutMs?: number;
  headers: Readonly<Record<string, string>>;
  playUrl?: string;
  categories?: readonly string[];
}

export interface FongMiConfig {
  sourceUrl?: string;
  spider?: string;
  sites: readonly FongMiSiteConfig[];
  parses: readonly unknown[];
  lives: readonly unknown[];
}

export function normalizeFongMiConfig(config: TvBoxConfig, sourceUrl?: string): FongMiConfig {
  const sites = Array.isArray(config.sites)
    ? config.sites.map((site, index) => normalizeFongMiSite(site, sourceUrl, index))
    : [];
  const spider = typeof config.spider === "string"
    ? resolveFongMiReference(config.spider, sourceUrl) ?? config.spider.trim()
    : undefined;
  return {
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(spider ? { spider } : {}),
    sites,
    parses: Array.isArray(config.parses) ? [...config.parses] : [],
    lives: Array.isArray(config.lives) ? [...config.lives] : [],
  };
}

export function normalizeFongMiSite(
  site: TvBoxSite,
  sourceUrl?: string,
  index = 0,
): FongMiSiteConfig {
  const api = text(site.api);
  const type = siteType(site.type, api);
  const key = text(site.key) || api || `site-${index + 1}`;
  const name = text(site.name) || key;
  const ext = Object.prototype.hasOwnProperty.call(site, "ext") ? site.ext : undefined;
  const jar = text(site.jar);
  const endpoint = type === 0 || type === 1 || type === 4
    ? resolveFongMiReference(api, sourceUrl)
    : undefined;
  const timeout = numberValue(site.timeout);
  const categories = Array.isArray(site.categories)
    ? site.categories.filter((value): value is string => typeof value === "string")
    : undefined;

  return {
    key,
    name,
    type,
    api,
    ...(ext === undefined ? {} : { ext }),
    ...(jar ? { jar: resolveFongMiReference(jar, sourceUrl) ?? jar } : {}),
    ...(endpoint ? { endpoint } : {}),
    searchable: flag(site.searchable, true),
    quickSearch: flag(site.quickSearch, false),
    filterable: flag(site.filterable, false),
    changeable: flag(site.changeable, true),
    ...(timeout === undefined ? {} : { timeoutMs: Math.min(120_000, Math.max(1_000, timeout * 1_000)) }),
    headers: headersOf(site.header),
    ...(text(site.playUrl) ? { playUrl: text(site.playUrl) } : {}),
    ...(categories && categories.length > 0 ? { categories } : {}),
  };
}

export function resolveFongMiReference(reference: string, sourceUrl?: string): string | undefined {
  const value = reference.trim();
  if (!value) return undefined;
  try {
    if (/^https?:\/\//i.test(value)) return safeHttpUrl(new URL(value));
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return undefined;
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return undefined;
    return safeHttpUrl(new URL(value, sourceUrl));
  } catch {
    return undefined;
  }
}

export function serializeFongMiExt(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function siteType(value: unknown, api: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (/^(?:csp_|js:|py:)/i.test(api) || /\.(?:m?js|py)(?:[?#].*)?$/i.test(api)) return 3;
  if (/^https?:\/\//i.test(api)) return 1;
  return 3;
}

function headersOf(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => (
        typeof entry[1] === "string" && isSafeHeader(entry[0], entry[1])
      )),
    );
  }
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split("&").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    const key = decodePart(part.slice(0, separator));
    const item = decodePart(part.slice(separator + 1));
    return isSafeHeader(key, item) ? [[key, item]] : [];
  }));
}

function isSafeHeader(name: string, value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    && !/[\r\n]/.test(value);
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeHttpUrl(url: URL): string {
  if (url.username || url.password) throw new Error("FongMi URL credentials are not supported");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("FongMi URL protocol is not supported");
  return url.toString();
}

function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "0";
  return fallback;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
