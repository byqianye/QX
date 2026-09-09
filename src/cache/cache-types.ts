import type { CacheEntryRecord } from "../data/repositories.js";

export const CACHE_TYPES = [
  "poster",
  "backdrop",
  "source-config",
  "home",
  "category",
  "search",
  "detail",
  "subtitle",
  "parser-metadata",
  "temporary",
] as const;

export type CacheType = typeof CACHE_TYPES[number];
export type CacheClearScope = "expired" | "images" | "search" | "all";

export interface CacheTypeSummary {
  type: CacheType;
  count: number;
  bytes: number;
}

export interface CacheUiState {
  totalBytes: number;
  maxBytes: number;
  entries: number;
  byType: readonly CacheTypeSummary[];
}

export interface CacheLease {
  record: CacheEntryRecord;
  path: string;
  release(): void;
}

export const EMPTY_CACHE_UI_STATE: CacheUiState = {
  totalBytes: 0,
  maxBytes: 0,
  entries: 0,
  byType: CACHE_TYPES.map((type) => ({ type, count: 0, bytes: 0 })),
};

export function isCacheType(value: string): value is CacheType {
  return (CACHE_TYPES as readonly string[]).includes(value);
}
