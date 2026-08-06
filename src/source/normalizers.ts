import type { SpiderResponse } from "../spider/rpc.js";
import {
  MediaSourceError,
  type HomeResult,
  type PlayerResult,
  type SourceCategory,
  type Vod,
  type VodDetail,
  type VodPage,
} from "./media-source.js";
import { normalizeSubtitleTracks } from "../subtitles.js";

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

export function normalizePlayerResult(result: unknown): PlayerResult {
  const raw = recordResult(result, "player");
  const parse = numberValue(raw.parse);
  const url = typeof raw.url === "string"
    ? raw.url
    : typeof raw.playUrl === "string"
      ? raw.playUrl
      : "";
  if (parse === undefined || !/^https?:\/\//i.test(url)) {
    throw new MediaSourceError(
      "PLAYBACK_INVALID_RESPONSE",
      "Player result must contain a numeric parse value and an HTTP URL",
    );
  }
  const subtitles = normalizeSubtitleTracks(raw.subtitles ?? raw.subtitleTracks ?? raw.subtitle);
  return {
    parse,
    url,
    headers: headersValue(raw.header ?? raw.headers),
    ...(subtitles.length > 0 ? { subtitles } : {}),
  };
}

export function normalizeVod(value: unknown): VodDetail {
  if (!isRecord(value)) {
    throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "Spider returned an invalid VOD item");
  }
  const id = stringValue(value.vod_id ?? value.id ?? value.itemId);
  if (!id) {
    throw new MediaSourceError("SOURCE_RESPONSE_INVALID", "VOD item is missing an id");
  }
  const name = stringValue(value.vod_name ?? value.name ?? value.title) || id;
  const raw = { ...value };
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
  return Object.fromEntries(value.split("&").flatMap((part) => {
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
