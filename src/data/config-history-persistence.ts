import {
  databaseError,
  isDataLayerError,
} from "./errors.js";
import type {
  ConfigChangeSummary,
  ConfigHistoryPersistence,
  ConfigHistorySourceKind,
  ConfigHistoryState,
  ConfigValidators,
  ConfigVersion,
} from "../config/history.js";
import { normalizeConfigHistorySource } from "../config/history.js";
import type { TvBoxConfig } from "../config/decoder.js";
import { type SqliteDataLayer } from "./sqlite.js";
import { serializePersistedJson, sanitizePersistedJsonText } from "./safe-persistence.js";

export class SqliteConfigHistoryPersistence implements ConfigHistoryPersistence {
  public constructor(private readonly db: SqliteDataLayer) {}

  public read(): ConfigHistoryState {
    try {
      const versions = this.db.prepare(`
        SELECT id, source, source_kind, raw_json, config_json, version_hash,
          created_at, etag, last_modified, spider_hashes_json, change_json
        FROM config_versions
        ORDER BY source, created_at, id
      `).all().map((row) => versionFromRow(row));
      const activeRows = this.db.prepare(
        "SELECT source, active_version_id FROM config_sources WHERE active_version_id IS NOT NULL",
      ).all();
      const activeVersionIds: Record<string, string> = {};
      for (const row of activeRows) {
        if (typeof row.source === "string" && typeof row.active_version_id === "string") {
          activeVersionIds[row.source] = row.active_version_id;
        }
      }
      return { versions, activeVersionIds };
    } catch (error) {
      if (isDataLayerError(error)) throw error;
      throw databaseError("DATABASE_CORRUPT", error);
    }
  }

  public write(state: ConfigHistoryState): void {
    this.db.transaction(() => this.writeInsideTransaction(state));
  }

  /** Used by the one-shot legacy importer so data and its migration marker share a transaction. */
  public writeInsideTransaction(state: ConfigHistoryState): void {
    try {
      this.db.exec("DELETE FROM config_versions; DELETE FROM config_sources;");
      const sourceRows = new Map<string, ConfigVersion>();
      for (const version of state.versions) sourceRows.set(version.source, version);

      const insertSource = this.db.prepare(`
        INSERT INTO config_sources(source, source_kind, active_version_id, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const [source, version] of sourceRows) {
        insertSource.run(
          persistedSource(source),
          version.sourceKind,
          state.activeVersionIds[source] ?? null,
          version.createdAt,
        );
      }

      const insertVersion = this.db.prepare(`
        INSERT INTO config_versions(
          id, source, source_kind, raw_json, config_json, version_hash, created_at,
          etag, last_modified, spider_hashes_json, change_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const version of state.versions) {
        insertVersion.run(
          version.id,
          persistedSource(version.source),
          version.sourceKind,
          sanitizePersistedJsonText(version.rawJson),
          serializePersistedJson(version.config),
          version.versionHash,
          version.createdAt,
          version.validators.etag,
          version.validators.lastModified,
          JSON.stringify(version.spiderHashes),
          JSON.stringify(version.change),
        );
      }
    } catch (error) {
      if (isDataLayerError(error)) throw error;
      throw databaseError("DATABASE_WRITE_FAILED", error);
    }
  }
}

function persistedSource(source: string): string {
  return normalizeConfigHistorySource(source);
}

function versionFromRow(row: Record<string, unknown>): ConfigVersion {
  const sourceKind = sourceKindValue(row.source_kind);
  const validators: ConfigValidators = {
    etag: nullableString(row.etag),
    lastModified: nullableString(row.last_modified),
  };
  return {
    id: stringValue(row.id),
    source: stringValue(row.source),
    sourceKind,
    rawJson: stringValue(row.raw_json),
    config: jsonValue<TvBoxConfig>(row.config_json),
    versionHash: stringValue(row.version_hash),
    createdAt: numberValue(row.created_at),
    validators,
    spiderHashes: jsonValue<Record<string, string>>(row.spider_hashes_json),
    change: changeValue(row.change_json),
  };
}

function changeValue(value: unknown): ConfigChangeSummary {
  const change = jsonValue<Partial<ConfigChangeSummary>>(value);
  if (!Array.isArray(change.addedSites)
    || !Array.isArray(change.removedSites)
    || !Array.isArray(change.changedSites)
    || typeof change.spiderChanged !== "boolean"
    || typeof change.changedTopLevelKeys === "undefined"
    || !Array.isArray(change.changedTopLevelKeys)) {
    throw databaseError("DATABASE_CORRUPT");
  }
  return {
    addedSites: change.addedSites.filter(isString),
    removedSites: change.removedSites.filter(isString),
    changedSites: change.changedSites.filter(isString),
    spiderChanged: change.spiderChanged,
    spiderContentChanged: change.spiderContentChanged === true,
    changedTopLevelKeys: change.changedTopLevelKeys.filter(isString),
  };
}

function sourceKindValue(value: unknown): ConfigHistorySourceKind {
  if (value === "url" || value === "file" || value === "json") return value;
  throw databaseError("DATABASE_CORRUPT");
}

function jsonValue<T>(value: unknown): T {
  if (typeof value !== "string") throw databaseError("DATABASE_CORRUPT");
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw databaseError("DATABASE_CORRUPT", error);
  }
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}
