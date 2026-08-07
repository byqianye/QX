import type { FavoriteGroupRecord, FavoriteRecord } from "../data/repositories.js";

export const DEFAULT_FAVORITE_GROUP_ID = "default";
export const DEFAULT_FAVORITE_GROUP_NAME = "默认收藏";

export type FavoriteSort = "manual" | "added" | "title" | "recent";
export type FavoriteGroupDeleteMode = "default" | "delete";

export interface FavoriteContentInput {
  sourceId: string;
  vodId: string;
  title: string;
  poster?: string | null;
  year?: string | null;
  category?: string | null;
  sourceName?: string | null;
  metadata?: unknown | null;
}

export interface FavoriteItem extends FavoriteRecord {
  sourceAvailable: boolean;
  recentWatchedAt: number | null;
}

export interface FavoriteGroupItem extends FavoriteGroupRecord {
  count: number;
}

export interface FavoritesUiState {
  items: readonly FavoriteItem[];
  groups: readonly FavoriteGroupItem[];
  defaultGroupId: string;
}

export const EMPTY_FAVORITES_UI_STATE: FavoritesUiState = {
  items: [],
  groups: [],
  defaultGroupId: DEFAULT_FAVORITE_GROUP_ID,
};
