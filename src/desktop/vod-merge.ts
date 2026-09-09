import { sanitizeVodDisplayText } from "../source/normalizers.js";

const DISPLAY_FIELDS = [
  "vod_name",
  "vod_pic",
  "vod_remarks",
  "vod_year",
  "vod_area",
  "vod_director",
  "vod_actor",
  "vod_content",
  "type_name",
] as const;

export type VodRecord = Record<string, unknown>;

/**
 * Merge the list item used to open a detail page with the detail response.
 * Display fields prefer non-empty detail values, then non-empty list values.
 * Playback fields deliberately come from the detail response only.
 */
export function mergeVodDisplayFields(
  listVod: VodRecord | null | undefined,
  detailVod: VodRecord | null | undefined,
): VodRecord | null {
  if (!listVod && !detailVod) return null;

  const merged: VodRecord = { ...(listVod ?? {}), ...(detailVod ?? {}) };
  for (const field of DISPLAY_FIELDS) {
    const detailValue = field === "vod_content"
      ? sanitizeVodDisplayText(detailVod?.[field])
      : detailVod?.[field];
    const listValue = field === "vod_content"
      ? sanitizeVodDisplayText(listVod?.[field])
      : listVod?.[field];
    if (isNonEmpty(detailValue)) {
      merged[field] = detailValue;
    } else if (isNonEmpty(listValue)) {
      merged[field] = listValue;
    } else {
      delete merged[field];
    }
  }

  for (const field of ["vod_play_from", "vod_play_url"] as const) {
    if (detailVod && Object.prototype.hasOwnProperty.call(detailVod, field)) {
      const value = detailVod[field];
      merged[field] = value === undefined || value === null ? "" : value;
    } else {
      delete merged[field];
    }
  }

  return merged;
}

function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}
