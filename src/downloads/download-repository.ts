import { databaseError } from "../data/errors.js";
import { type SqliteDataLayer } from "../data/sqlite.js";
import type { DownloadStatus } from "./download-types.js";

export interface DownloadTargetDirectoryRecord {
  id: string;
  directoryPath: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadTaskRecord {
  id: string;
  sourceId: string | null;
  contentId: string | null;
  title: string;
  targetDirectoryId: string;
  suggestedFilename: string;
  requestReference: string;
  status: DownloadStatus;
  totalBytes: number | null;
  completedBytes: number | null;
  speed: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  error: string | null;
  backendId: string | null;
}

export class DownloadRepository {
  public constructor(private readonly db: SqliteDataLayer) {}

  public upsertTargetDirectory(record: DownloadTargetDirectoryRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO download_target_directories(id, directory_path, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(directory_path) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `).run(record.id, record.directoryPath, record.displayName, record.createdAt, record.updatedAt);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public getTargetDirectory(id: string): DownloadTargetDirectoryRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM download_target_directories WHERE id = ?",
    ).get(id);
    return row ? targetDirectoryFromRow(row) : null;
  }

  public findTargetDirectoryByPath(directoryPath: string): DownloadTargetDirectoryRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM download_target_directories WHERE directory_path = ?",
    ).get(directoryPath);
    return row ? targetDirectoryFromRow(row) : null;
  }

  public listTargetDirectories(): readonly (DownloadTargetDirectoryRecord & { taskCount: number })[] {
    return this.db.prepare(`
      SELECT d.*, COUNT(t.id) AS task_count
      FROM download_target_directories d
      LEFT JOIN download_tasks t ON t.target_directory_id = d.id AND t.status <> 'removed'
      GROUP BY d.id
      ORDER BY d.updated_at DESC, d.id
    `).all().map((row) => ({
      ...targetDirectoryFromRow(row),
      taskCount: numberValue((row as Record<string, unknown>).task_count),
    }));
  }

  public upsertTask(record: DownloadTaskRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO download_tasks(
          id, source_id, content_id, title, target_directory_id, suggested_filename,
          request_reference, status, total_bytes, completed_bytes, speed, created_at,
          started_at, completed_at, updated_at, error, backend_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_id = excluded.source_id,
          content_id = excluded.content_id,
          title = excluded.title,
          target_directory_id = excluded.target_directory_id,
          suggested_filename = excluded.suggested_filename,
          request_reference = excluded.request_reference,
          status = excluded.status,
          total_bytes = excluded.total_bytes,
          completed_bytes = excluded.completed_bytes,
          speed = excluded.speed,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at,
          error = excluded.error,
          backend_id = excluded.backend_id
      `).run(
        record.id,
        record.sourceId,
        record.contentId,
        record.title,
        record.targetDirectoryId,
        record.suggestedFilename,
        record.requestReference,
        record.status,
        record.totalBytes,
        record.completedBytes,
        record.speed,
        record.createdAt,
        record.startedAt,
        record.completedAt,
        record.updatedAt,
        record.error,
        record.backendId,
      );
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }

  public getTask(id: string): DownloadTaskRecord | null {
    const row = this.db.prepare("SELECT * FROM download_tasks WHERE id = ?").get(id);
    return row ? taskFromRow(row) : null;
  }

  public listTasks(includeRemoved = false): readonly DownloadTaskRecord[] {
    const rows = includeRemoved
      ? this.db.prepare("SELECT * FROM download_tasks ORDER BY updated_at DESC, id").all()
      : this.db.prepare("SELECT * FROM download_tasks WHERE status <> 'removed' ORDER BY updated_at DESC, id").all();
    return rows.map(taskFromRow);
  }

  public deleteTask(id: string): void {
    try {
      this.db.prepare("DELETE FROM download_tasks WHERE id = ?").run(id);
    } catch (error) {
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

function targetDirectoryFromRow(row: Record<string, unknown>): DownloadTargetDirectoryRecord {
  return {
    id: stringValue(row.id),
    directoryPath: stringValue(row.directory_path),
    displayName: stringValue(row.display_name),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

function taskFromRow(row: Record<string, unknown>): DownloadTaskRecord {
  return {
    id: stringValue(row.id),
    sourceId: nullableString(row.source_id),
    contentId: nullableString(row.content_id),
    title: stringValue(row.title),
    targetDirectoryId: stringValue(row.target_directory_id),
    suggestedFilename: stringValue(row.suggested_filename),
    requestReference: stringValue(row.request_reference),
    status: stringValue(row.status) as DownloadStatus,
    totalBytes: nullableNumber(row.total_bytes),
    completedBytes: nullableNumber(row.completed_bytes),
    speed: nullableNumber(row.speed),
    createdAt: numberValue(row.created_at),
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    updatedAt: numberValue(row.updated_at),
    error: nullableString(row.error),
    backendId: nullableString(row.backend_id),
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw databaseError("DATABASE_CORRUPT");
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw databaseError("DATABASE_CORRUPT");
  return value;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}
