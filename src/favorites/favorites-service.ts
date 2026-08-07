import { randomUUID } from "node:crypto";

import {
  FavoritesRepository,
  HistoryRepository,
  type FavoriteRecord,
} from "../data/repositories.js";
import type { SqliteDataLayer } from "../data/sqlite.js";
import { safeHistoryIdentifier } from "../history/history-progress.js";
import {
  DEFAULT_FAVORITE_GROUP_ID,
  DEFAULT_FAVORITE_GROUP_NAME,
  type FavoriteContentInput,
  type FavoriteGroupDeleteMode,
  type FavoriteGroupItem,
  type FavoriteItem,
  type FavoriteSort,
  type FavoritesUiState,
} from "./favorites-types.js";

export interface FavoritesServiceOptions {
  db: SqliteDataLayer;
  favorites: FavoritesRepository;
  history: HistoryRepository;
  now?: () => number;
}

export class FavoritesService {
  private readonly now: () => number;

  public constructor(private readonly options: FavoritesServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ensureDefaultGroup();
  }

  public uiState(currentSourceId: string | null = null, sort: FavoriteSort = "manual"): FavoritesUiState {
    this.ensureDefaultGroup();
    const recentByIdentity = new Map(
      this.options.favorites.list().map((item) => [
        item.favoriteId,
        this.options.history.latestUpdatedAtForContent(item.sourceId, item.vodId),
      ] as const),
    );
    const items = this.options.favorites.list().map((item) => ({
      ...item,
      sourceAvailable: currentSourceId === null || item.sourceId === currentSourceId,
      recentWatchedAt: recentByIdentity.get(item.favoriteId) ?? null,
    }));
    items.sort((left, right) => compareFavorites(left, right, sort));
    return {
      items,
      groups: this.groupItems(),
      defaultGroupId: DEFAULT_FAVORITE_GROUP_ID,
    };
  }

  public findByContent(sourceId: string, vodId: string): FavoriteRecord | null {
    const safeSourceId = safeHistoryIdentifier(sourceId);
    const safeVodId = safeHistoryIdentifier(vodId);
    return safeSourceId && safeVodId
      ? this.options.favorites.findByContent(safeSourceId, safeVodId)
      : null;
  }

  public get(favoriteId: string): FavoriteRecord | null {
    return this.options.favorites.get(favoriteId);
  }

  public toggle(input: FavoriteContentInput): FavoriteRecord | null {
    const normalized = normalizeFavoriteInput(input);
    if (!normalized) throw new Error("FAVORITE_CONTENT_INVALID");
    const existing = this.options.favorites.findByContent(normalized.sourceId, normalized.vodId);
    if (existing) {
      this.options.favorites.delete(existing.favoriteId);
      return null;
    }
    this.ensureDefaultGroup();
    const now = this.now();
    const record: FavoriteRecord = {
      favoriteId: `favorite:${randomUUID()}`,
      ...normalized,
      groupId: DEFAULT_FAVORITE_GROUP_ID,
      sortOrder: this.nextFavoriteSortOrder(DEFAULT_FAVORITE_GROUP_ID),
      addedAt: now,
      updatedAt: now,
    };
    this.options.favorites.upsert(record);
    return this.options.favorites.findByContent(record.sourceId, record.vodId);
  }

  public delete(favoriteId: string): void {
    this.options.favorites.delete(favoriteId);
  }

  public move(favoriteId: string, groupId: string): void {
    const favorite = this.options.favorites.get(favoriteId);
    if (!favorite) throw new Error("FAVORITE_NOT_FOUND");
    if (!this.options.favorites.getGroup(groupId)) throw new Error("FAVORITE_GROUP_NOT_FOUND");
    if (favorite.groupId === groupId) return;
    this.options.db.transaction(() => {
      const sortOrder = this.nextFavoriteSortOrder(groupId);
      this.options.favorites.setGroup(favoriteId, groupId, this.now(), sortOrder);
    });
  }

  public reorder(groupId: string, favoriteIds: readonly string[]): void {
    if (!this.options.favorites.getGroup(groupId)) throw new Error("FAVORITE_GROUP_NOT_FOUND");
    const unique = [...new Set(favoriteIds)];
    const groupRecords = this.options.favorites.list(groupId);
    const records = unique.map((favoriteId) => this.options.favorites.get(favoriteId));
    if (unique.length !== groupRecords.length || records.some((record) => !record || record.groupId !== groupId)) {
      throw new Error("FAVORITE_SORT_INVALID");
    }
    this.options.favorites.reorderInGroup(groupId, unique);
  }

  public createGroup(name: string): FavoriteGroupItem {
    const safeName = normalizeGroupName(name);
    if (!safeName) throw new Error("FAVORITE_GROUP_NAME_REQUIRED");
    if (this.options.favorites.listGroups().some((group) => group.name === safeName)) {
      throw new Error("FAVORITE_GROUP_EXISTS");
    }
    const now = this.now();
    const group = {
      groupId: `favorite-group:${randomUUID()}`,
      name: safeName,
      sortOrder: this.nextGroupSortOrder(),
      createdAt: now,
      updatedAt: now,
    };
    this.options.favorites.upsertGroup(group);
    return { ...group, count: 0 };
  }

  public renameGroup(groupId: string, name: string): void {
    if (groupId === DEFAULT_FAVORITE_GROUP_ID) throw new Error("FAVORITE_DEFAULT_GROUP_PROTECTED");
    if (!this.options.favorites.getGroup(groupId)) throw new Error("FAVORITE_GROUP_NOT_FOUND");
    const safeName = normalizeGroupName(name);
    if (!safeName) throw new Error("FAVORITE_GROUP_NAME_REQUIRED");
    if (this.options.favorites.listGroups().some((group) => group.groupId !== groupId && group.name === safeName)) {
      throw new Error("FAVORITE_GROUP_EXISTS");
    }
    this.options.favorites.renameGroup(groupId, safeName, this.now());
  }

  public reorderGroups(groupIds: readonly string[]): void {
    const unique = [...new Set(groupIds)];
    const known = new Set(this.options.favorites.listGroups().map((group) => group.groupId));
    if (unique.length !== known.size || unique.some((groupId) => !known.has(groupId))) {
      throw new Error("FAVORITE_GROUP_SORT_INVALID");
    }
    this.options.favorites.reorderGroups(unique);
  }

  public deleteGroup(groupId: string, disposition?: FavoriteGroupDeleteMode): void {
    if (groupId === DEFAULT_FAVORITE_GROUP_ID) throw new Error("FAVORITE_DEFAULT_GROUP_PROTECTED");
    const group = this.options.favorites.getGroup(groupId);
    if (!group) throw new Error("FAVORITE_GROUP_NOT_FOUND");
    const count = this.options.favorites.countByGroup(groupId);
    if (count > 0 && disposition === undefined) throw new Error("FAVORITE_GROUP_DISPOSITION_REQUIRED");
    this.options.db.transaction(() => {
      if (count > 0 && disposition === "default") {
        this.options.favorites.moveGroupContents(groupId, DEFAULT_FAVORITE_GROUP_ID, this.now());
      } else if (count > 0 && disposition === "delete") {
        this.options.favorites.deleteByGroup(groupId);
      }
      this.options.favorites.deleteGroup(groupId);
    });
  }

  private groupItems(): readonly FavoriteGroupItem[] {
    return this.options.favorites.listGroups().map((group) => ({
      ...group,
      count: this.options.favorites.countByGroup(group.groupId),
    }));
  }

  private ensureDefaultGroup(): void {
    if (this.options.favorites.getGroup(DEFAULT_FAVORITE_GROUP_ID)) return;
    const now = this.now();
    this.options.favorites.upsertGroup({
      groupId: DEFAULT_FAVORITE_GROUP_ID,
      name: DEFAULT_FAVORITE_GROUP_NAME,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private nextFavoriteSortOrder(groupId: string): number {
    return this.options.favorites.list(groupId).reduce(
      (maximum, item) => Math.max(maximum, item.sortOrder),
      -1,
    ) + 1;
  }

  private nextGroupSortOrder(): number {
    return this.options.favorites.listGroups().reduce(
      (maximum, group) => Math.max(maximum, group.sortOrder),
      -1,
    ) + 1;
  }
}

function compareFavorites(left: FavoriteItem, right: FavoriteItem, sort: FavoriteSort): number {
  if (sort === "title") return left.title.localeCompare(right.title) || right.updatedAt - left.updatedAt;
  if (sort === "added") return right.addedAt - left.addedAt;
  if (sort === "recent") {
    return (right.recentWatchedAt ?? 0) - (left.recentWatchedAt ?? 0)
      || right.updatedAt - left.updatedAt;
  }
  return left.groupId?.localeCompare(right.groupId ?? "")
    || left.sortOrder - right.sortOrder
    || right.addedAt - left.addedAt;
}

function normalizeFavoriteInput(input: FavoriteContentInput): Omit<FavoriteRecord, "favoriteId" | "groupId" | "sortOrder" | "addedAt" | "updatedAt"> | null {
  const sourceId = safeHistoryIdentifier(input.sourceId);
  const vodId = safeHistoryIdentifier(input.vodId);
  if (!sourceId || !vodId) return null;
  return {
    sourceId: sourceId.slice(0, 256),
    vodId,
    title: safeLabel(input.title) || vodId,
    poster: safePoster(input.poster),
    year: safeLabel(input.year),
    category: safeLabel(input.category),
    sourceName: safeLabel(input.sourceName),
    metadata: safeMetadata(input.metadata),
  };
}

function normalizeGroupName(value: string): string {
  return cleanText(value).slice(0, 64);
}

function safeLabel(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || looksLikeUrl(text) || looksSensitive(text)) return null;
  return text.slice(0, 512);
}

function safePoster(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text || looksSensitive(text) || /__qx_playback/i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (/\.(?:m3u8|mpd|mp4|mkv|webm)(?:$|\/)/i.test(url.pathname)
      || /(?:^|\/)(?:live|stream|playback|playlist|session|proxy)(?:\/|$)/i.test(url.pathname)
      || /\/(?:stream|playback|video|play)$/i.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 1024);
  } catch {
    return null;
  }
}

function safeMetadata(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  const sanitized = sanitizeMetadataValue(value, "metadata");
  return sanitized === undefined ? null : sanitized;
}

function sanitizeMetadataValue(value: unknown, key: string): unknown {
  if (/(?:url|path|header|cookie|token|auth|proxy|playback|stream|media|ipc)/i.test(key)) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return looksLikeUrl(value) || looksSensitive(value) ? undefined : value.slice(0, 512);
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadataValue(item, "item")).filter((item) => item !== undefined);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeMetadataValue(entryValue, entryKey)])
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined));
  }
  return undefined;
}

function cleanText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?|file|data|blob):/i.test(value) || /[?#]/.test(value);
}

function looksSensitive(value: string): boolean {
  return /(?:token|authorization|cookie|password|secret|bearer)\s*[:=]/i.test(value);
}
