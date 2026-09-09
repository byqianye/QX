import type { SpiderResponse } from "../spider/rpc.js";
import {
  MediaSourceError,
  type HomeResult,
  type PlayerResult,
  type QxPlayerResult,
  type PlayableStatus,
  type SourceCategory,
  type Vod,
  type VodDetail,
  type VodPage,
} from "./media-source.js";
import { normalizeSubtitleTracks } from "../subtitles.js";

const VOD_DESCRIPTION_FIELDS = ["vod_content", "vod_blurb"] as const;

/** Convert source-provided HTML/entity descriptions into safe renderer text. */
export function sanitizeVodDisplayText(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text = String(value);
  for (let pass = 0; pass < 2; pass += 1) {
    const decoded = decodeHtmlEntities(text);
    const stripped = stripHtml(decoded);
    text = stripped;
    if (stripped === decoded) break;
  }
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function unwrapSpiderResponse(response: SpiderResponse, operation: string): unknown {
  if (response.ok) return response.result;
  throw new MediaSourceError(
    response.error?.code ?? "SPIDER_RPC_ERROR",
    response.error?.message ?? `Spider ${operation} failed`,
  );
}

export function normalizeHomeResult(result: unknown): HomeResult {
  const raw = recordResult(result, "home");
  return {
    items: listValue(raw).map(normalizeVod),
    categories: categoryValue(raw),
    raw,
  };
}

export function normalizeVodPage(result: unknown, page: number): VodPage {
  const raw = recordResult(result, "page");
  const pageCount = numberValue(raw.pagecount ?? raw.page_count ?? raw.pageCount);
  const total = numberValue(raw.total ?? raw.total_count ?? raw.totalCount);
  return {
    items: listValue(raw).map(normalizeVod),
    page,
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(total === undefined ? {} : { total }),
    raw,
  };
}

export function normalizeVodDetails(result: unknown): VodDetail[] {
  const raw = recordResult(result, "detail");
  return listValue(raw).map(normalizeVod);
}

export interface QxPlayerResultContext {
  sourceKey: string;
  sourceName: string;
  episodeId: string;
}

export function normalizePlayerResult(result: unknown): PlayerResult;
export function normalizePlayerResult(result: unknown, context: QxPlayerResultContext): QxPlayerResult;
export function normalizePlayerResult(
  result: unknown,
  context?: QxPlayerResultContext,
): PlayerResult | QxPlayerResult {
  const raw = recordResult(result, "player");
  const parse = numberValue(raw.parse);
  const url = [raw.url, raw.playUrl, raw.link]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? "";
  const message = firstMessage(raw);
  if (parse === undefined || (!/^https?:\/\//i.test(url) && !isAuthRequired(message))) {
    throw new MediaSourceError(
      "PLAYBACK_INVALID_RESPONSE",
      "Player result must contain a numeric parse value and an HTTP URL",
    );
  }
  const subtitles = normalizeSubtitleTracks(raw.subtitles ?? raw.subtitleTracks ?? raw.subtitle);
  const playUrl = typeof raw.playUrl === "string" ? raw.playUrl : undefined;
  const jx = numberValue(raw.jx);
  const format = typeof raw.format === "string" ? raw.format : undefined;
  const flag = typeof raw.flag === "string" ? raw.flag : undefined;
  const jxFrom = typeof raw.jxFrom === "string" ? raw.jxFrom : undefined;
  const status: PlayableStatus = isAuthRequired(message)
    ? "AUTH_REQUIRED"
    : parse === 0
      ? "DIRECT"
      : "PARSE_REQUIRED";
  const normalized = {
    parse: parse ?? 0,
    url,
    headers: headersValue(raw.header ?? raw.headers),
    status,
    ...(message ? { message } : {}),
    ...(playUrl ? { playUrl } : {}),
    ...(jx === undefined ? {} : { jx }),
    ...(format ? { format } : {}),
    ...(flag ? { flag } : {}),
    ...(jxFrom ? { jxFrom } : {}),
    ...(subtitles.length > 0 ? { subtitles } : {}),
    ...(raw.danmaku !== undefined ? { danmaku: raw.danmaku } : {}),
  };
  return context
    ? { ...normalized, jx: jx ?? 0, ...context }
    : normalized;
}

function firstMessage(raw: Record<string, unknown>): string {
  for (const key of ["msg", "message", "errMsg", "error", "reason"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isAuthRequired(message: string): boolean {
  return /(\u672a\u767b\u5f55|\u767b\u5f55|token|access[_-]?token|cookie|\u914d\u7f6e\u4e2d\u5fc3|\u6388\u6743)/iu.test(message);
}

export function normalizeVod(value: unknown): VodDetail {
  if (!isRecord(value)) {
    throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "Spider returned an invalid VOD item");
  }
  const id = stringValue(value.vod_id ?? value.id ?? value.itemId);
  if (!id) {
    throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "VOD item is missing an id");
  }
  const raw = { ...value };
  for (const field of VOD_DESCRIPTION_FIELDS) {
    if (typeof raw[field] === "string") raw[field] = sanitizeVodDisplayText(raw[field]);
  }
  const name = stringValue(raw.vod_name ?? raw.name ?? raw.title) || id;
  return { ...raw, id, name, raw };
}

export function normalizeCategory(value: unknown, index: number): SourceCategory {
  if (!isRecord(value)) {
    throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "Spider returned an invalid category");
  }
  const id = stringValue(value.type_id ?? value.id) || `category-${index + 1}`;
  const name = stringValue(value.type_name ?? value.name) || id;
  return {
    id,
    name,
    raw: { ...value },
  };
}

function recordResult(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new MediaSourceError(
      "SOURCE_RESPONSE_INVALID",
      `Spider ${operation} result must be an object`,
    );
  }
  return value;
}

function listValue(value: Record<string, unknown>): unknown[] {
  const list = value.list ?? value.items;
  return Array.isArray(list) ? list : [];
}

function categoryValue(value: Record<string, unknown>): SourceCategory[] {
  const categories = value.class ?? value.categories;
  return Array.isArray(categories) ? categories.map(normalizeCategory) : [];
}

function headersValue(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) return headersValue(parsed);
    } catch {
      // Fall through to the legacy key=value format.
    }
  }
  return Object.fromEntries(trimmed.split("&").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    return [[decodeURIComponent(part.slice(0, separator)), decodeURIComponent(part.slice(separator + 1))]];
  }));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripHtml(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(script|style|template|iframe|object|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|section|article)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return HTML_ENTITY_MAP[normalized] ?? match;
  });
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}

const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "\u2026",
  laquo: "\u00ab",
  ldquo: "\u201c",
  lsquo: "\u2018",
  lt: "<",
  mdash: "\u2014",
  middot: "\u00b7",
  nbsp: "\u00a0",
  ndash: "\u2013",
  quot: '"',
  raquo: "\u00bb",
  rdquo: "\u201d",
  rsquo: "\u2019",
  thinsp: "\u2009",
};
