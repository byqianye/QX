import { databaseError } from "../data/errors.js";
import type { SqliteDataLayer } from "../data/sqlite.js";
import type { LocalMediaType, LocalMediaScanStatus, LocalSubtitleTrack } from "./local-media-types.js";

export interface LocalMediaRootRecord {
  id: string;
  rootPath: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  lastScanAt: number | null;
  scanStatus: LocalMediaScanStatus;
  lastError: string | null;
}

export interface LocalMediaItemRecord {
  id: string;
  rootId: string | null;
  fileReference: string;
  displayName: string;
  extension: string;
  size: number;
  modifiedAt: number;
  mediaType: LocalMediaType;
  duration: number | null;
  width: number | null;
  height: number | null;
  poster: string | null;
  subtitleTracks: readonly LocalSubtitleTrack[];
  createdAt: number;
  updatedAt: number;
  missing: boolean;
}

export class LocalMediaRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public listRoots(): readonly LocalMediaRootRecord[] {
    return this.db.prepare(
      "SELECT * FROM local_media_roots ORDER BY display_name COLLATE NOCASE, id",
    ).all().map(rootFromRow);
  }

  public getRoot(id: string): LocalMediaRootRecord | null {
    const row = this.db.prepare("SELECT * FROM local_media_roots WHERE id = ?").get(id);
    return row ? rootFromRow(row) : null;
  }

  public findRootByPath(rootPath: string): LocalMediaRootRecord | null {
    const row = this.db.prepare("SELECT * FROM local_media_roots WHERE root_path = ?").get(rootPath);
    return row ? rootFromRow(row) : null;
  }

  public upsertRoot(root: LocalMediaRootRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO local_media_roots(
          id, root_path, display_name, created_at, updated_at, last_scan_at, scan_status, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          root_path = excluded.root_path,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at,
          last_scan_at = excluded.last_scan_at,
          scan_status = excluded.scan_status,
          last_error = excluded.last_error
      `).run(
        root.id,
        root.rootPath,
        root.displayName,
        root.createdAt,
        root.updatedAt,
        root.lastScanAt,
        root.scanStatus,
        root.lastError,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public deleteRoot(id: string): void {
    try {
      this.db.prepare("DELETE FROM local_media_roots WHERE id = ?").run(id);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public listItems(rootId?: string | null): readonly LocalMediaItemRecord[] {
    const rows = rootId === undefined
      ? this.db.prepare("SELECT * FROM local_media_items ORDER BY display_name COLLATE NOCASE, id").all()
      : this.db.prepare("SELECT * FROM local_media_items WHERE root_id IS ? ORDER BY display_name COLLATE NOCASE, id").all(rootId);
    return rows.map(itemFromRow);
  }

  public getItem(id: string): LocalMediaItemRecord | null {
    const row = this.db.prepare("SELECT * FROM local_media_items WHERE id = ?").get(id);
    return row ? itemFromRow(row) : null;
  }

  public getItemByFileReference(fileReference: string): LocalMediaItemRecord | null {
    const row = this.db.prepare("SELECT * FROM local_media_items WHERE file_reference = ?").get(fileReference);
    return row ? itemFromRow(row) : null;
  }

  public upsertItem(item: LocalMediaItemRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO local_media_items(
          id, root_id, file_reference, display_name, extension, size, modified_at, media_type,
          duration, width, height, poster, subtitle_tracks_json, created_at, updated_at, missing
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          root_id = excluded.root_id,
          file_reference = excluded.file_reference,
          display_name = excluded.display_name,
          extension = excluded.extension,
          size = excluded.size,
          modified_at = excluded.modified_at,
          media_type = excluded.media_type,
          duration = excluded.duration,
          width = excluded.width,
          height = excluded.height,
          poster = excluded.poster,
          subtitle_tracks_json = excluded.subtitle_tracks_json,
          updated_at = excluded.updated_at,
          missing = excluded.missing
      `).run(
        item.id,
        item.rootId,
        item.fileReference,
        item.displayName,
        item.extension,
        item.size,
        item.modifiedAt,
        item.mediaType,
        item.duration,
        item.width,
        item.height,
        item.poster,
        JSON.stringify(item.subtitleTracks),
        item.createdAt,
        item.updatedAt,
        item.missing ? 1 : 0,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public markMissingForRoot(rootId: string, presentFileReferences: readonly string[]): void {
    try {
      if (presentFileReferences.length === 0) {
        this.db.prepare("UPDATE local_media_items SET missing = 1 WHERE root_id = ?").run(rootId);
        return;
      }
      const placeholders = presentFileReferences.map(() => "?").join(", ");
      this.db.prepare(
        `UPDATE local_media_items SET missing = 1 WHERE root_id = ? AND file_reference NOT IN (${placeholders})`,
      ).run(rootId, ...presentFileReferences);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public deleteItem(id: string): void {
    try {
      this.db.prepare("DELETE FROM local_media_items WHERE id = ?").run(id);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

function rootFromRow(row: Record<string, unknown>): LocalMediaRootRecord {
  return {
    id: stringValue(row.id),
    rootPath: stringValue(row.root_path),
    displayName: stringValue(row.display_name),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    lastScanAt: nullableNumber(row.last_scan_at),
    scanStatus: stringValue(row.scan_status) as LocalMediaScanStatus,
    lastError: nullableString(row.last_error),
  };
}

function itemFromRow(row: Record<string, unknown>): LocalMediaItemRecord {
  let subtitleTracks: readonly LocalSubtitleTrack[] = [];
  if (typeof row.subtitle_tracks_json === "string") {
    try {
      const parsed: unknown = JSON.parse(row.subtitle_tracks_json);
      if (Array.isArray(parsed)) {
        subtitleTracks = parsed.filter(isSubtitleTrack);
      }
    } catch {
      subtitleTracks = [];
    }
  }
  return {
    id: stringValue(row.id),
    rootId: nullableString(row.root_id),
    fileReference: stringValue(row.file_reference),
    displayName: stringValue(row.display_name),
    extension: stringValue(row.extension),
    size: numberValue(row.size),
    modifiedAt: numberValue(row.modified_at),
    mediaType: stringValue(row.media_type) as LocalMediaType,
    duration: nullableNumber(row.duration),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    poster: nullableString(row.poster),
    subtitleTracks,
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    missing: row.missing === 1 || row.missing === true,
  };
}

function isSubtitleTrack(value: unknown): value is LocalSubtitleTrack {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.label === "string"
    && typeof record.language === "string"
    && (record.format === "vtt" || record.format === "srt" || record.format === "ass" || record.format === "ssa")
    && typeof record.fileReference === "string";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
