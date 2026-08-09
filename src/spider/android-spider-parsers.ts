export interface AndroidVodItem {
  vod_id?: string | number;
  vod_name?: string;
  vod_pic?: string;
  vod_content?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  [key: string]: unknown;
}

export interface AndroidPlaybackRequest {
  flag: string;
  id: string;
}

export interface AndroidPlaybackLineStats {
  hasPlayFrom: boolean;
  hasPlayUrl: boolean;
  playLineCount: number;
}

export function parseAndroidSpiderResult(value: unknown): Record<string, unknown> {
  const raw = unwrapResult(value);
  const unwrapped = typeof raw === "string" ? parseJson(raw) : raw;
  if (isRecord(unwrapped)) return unwrapped;
  if (Array.isArray(unwrapped)) return { list: unwrapped };
  return {};
}

export function extractAndroidVodItems(value: unknown): AndroidVodItem[] {
  const payload = parseAndroidSpiderResult(value);
  return Array.isArray(payload.list) ? payload.list.filter(isRecord) as AndroidVodItem[] : [];
}

export function firstAndroidVodId(value: unknown): string | undefined {
  const item = extractAndroidVodItems(value)[0];
  if (!item) return undefined;
  const id = item.vod_id ?? item.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

export function hasAndroidPlaybackFields(value: unknown): boolean {
  const stats = androidPlaybackLineStats(value);
  return stats.hasPlayFrom && stats.hasPlayUrl;
}

export function androidPlaybackLineStats(value: unknown): AndroidPlaybackLineStats {
  const item = extractAndroidVodItems(value)[0];
  const playFrom = typeof item?.vod_play_from === "string" ? item.vod_play_from.trim() : "";
  const playUrl = typeof item?.vod_play_url === "string" ? item.vod_play_url.trim() : "";
  const playLineCount = playUrl
    ? playUrl.split("$$$").flatMap((group) => group.split("#")).filter((line) => line.trim().length > 0).length
    : 0;
  return { hasPlayFrom: playFrom.length > 0, hasPlayUrl: playUrl.length > 0, playLineCount };
}

export function firstAndroidPlaybackRequest(value: unknown): AndroidPlaybackRequest | undefined {
  const item = extractAndroidVodItems(value)[0];
  if (!item || typeof item.vod_play_url !== "string") return undefined;
  const flags = typeof item.vod_play_from === "string" ? item.vod_play_from.split("$$$").map((entry) => entry.trim()) : [];
  const groups = item.vod_play_url.split("$$$");
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const line = groups[groupIndex]?.split("#")[0]?.trim();
    if (!line) continue;
    const separator = line.indexOf("$");
    const id = separator >= 0 ? line.slice(separator + 1).trim() : line;
    if (!id) continue;
    return { flag: flags[groupIndex] ?? "", id };
  }
  return undefined;
}

export function validateAndroidDetail(value: unknown): { valid: boolean; missing: readonly string[] } {
  const item = extractAndroidVodItems(value)[0];
  const required = ["vod_id", "vod_name", "vod_pic", "vod_content", "vod_year"] as const;
  const missing = required.filter((field) => {
    const fieldValue = item?.[field];
    return fieldValue === undefined || fieldValue === null || String(fieldValue).trim() === "";
  });
  return { valid: missing.length === 0, missing };
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Object.prototype.hasOwnProperty.call(value, "result")) return unwrapResult(value.result);
  if (Object.prototype.hasOwnProperty.call(value, "value") && Object.keys(value).length === 1) return unwrapResult(value.value);
  if (typeof value.raw === "string") return parseJson(value.raw);
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
