import { existsSync, readFileSync } from "node:fs";

import { parseDesktopState } from "../desktop/state-persistence.js";
import { JsonFileConfigHistoryPersistence } from "../config/history.js";
import { legacyMigrationError, isDataLayerError, type DataLayerError } from "./errors.js";
import { SqliteConfigHistoryPersistence } from "./config-history-persistence.js";
import { HealthRepository, SettingsRepository } from "./repositories.js";
import { type SqliteDataLayer } from "./sqlite.js";

export interface LegacyDataPaths {
  desktopState: string;
  configHistory: string;
  sourceHealth: string;
  streamHealth: string;
}

export interface LegacyMigrationReport {
  imported: readonly string[];
  skipped: readonly string[];
  failed: readonly string[];
  diagnostic: DataLayerError | null;
}

interface MigrationTask {
  name: string;
  path: string;
  import: () => void;
}

export class LegacyDataMigrator {
  public constructor(private readonly db: SqliteDataLayer) {}

  public migrate(paths: LegacyDataPaths): LegacyMigrationReport {
    const imported: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    let diagnostic: DataLayerError | null = null;
    const settings = new SettingsRepository(this.db);
    const history = new SqliteConfigHistoryPersistence(this.db);
    const health = new HealthRepository(this.db);

    const tasks: readonly MigrationTask[] = [
      {
        name: "legacy:desktop-state",
        path: paths.desktopState,
        import: () => {
          const value: unknown = JSON.parse(readFileSync(paths.desktopState, "utf8"));
          const state = parseDesktopState(value);
          if (!state) throw new Error("Legacy desktop state is invalid");
          settings.set("desktop-state", state);
        },
      },
      {
        name: "legacy:config-history",
        path: paths.configHistory,
        import: () => {
          const state = new JsonFileConfigHistoryPersistence(paths.configHistory).read();
          history.writeInsideTransaction(state);
        },
      },
      {
        name: "legacy:source-health",
        path: paths.sourceHealth,
        import: () => {
          for (const entry of healthEntries(readFileSync(paths.sourceHealth, "utf8"), "source")) {
            health.upsertSource(entry);
          }
        },
      },
      {
        name: "legacy:stream-health",
        path: paths.streamHealth,
        import: () => {
          for (const entry of healthEntries(readFileSync(paths.streamHealth, "utf8"), "stream")) {
            health.upsertStream(entry);
          }
        },
      },
    ];

    for (const task of tasks) {
      if (this.db.hasMigration(task.name)) {
        skipped.push(task.name);
        continue;
      }
      if (!existsSync(task.path)) {
        skipped.push(task.name);
        continue;
      }
      try {
        this.db.transaction(() => {
          try {
            task.import();
          } catch (error) {
            throw isDataLayerError(error) ? error : legacyMigrationError(error);
          }
          this.db.markMigration(task.name);
        });
        imported.push(task.name);
      } catch (error) {
        failed.push(task.name);
        diagnostic ??= isDataLayerError(error) ? error : legacyMigrationError(error);
      }
    }

    return { imported, skipped, failed, diagnostic };
  }
}

function healthEntries(raw: string, kind: "source" | "stream") {
  const value: unknown = JSON.parse(raw);
  const entries: Array<{ id: string; sourceId?: string; snapshot: unknown; updatedAt: number }> = [];
  if (Array.isArray(value)) {
    for (const item of value) entries.push(parseHealthEntry(item, kind));
  } else if (isRecord(value)) {
    for (const [id, item] of Object.entries(value)) {
      const parsed = parseHealthEntry(item, kind, id);
      entries.push(parsed);
    }
  } else {
    throw new Error("Legacy health state must be an array or object");
  }
  return entries;
}

function parseHealthEntry(value: unknown, kind: "source" | "stream", fallbackId?: string) {
  if (!isRecord(value)) throw new Error("Legacy health entry is invalid");
  const id = typeof value.sourceId === "string"
    ? value.sourceId
    : typeof value.streamId === "string"
      ? value.streamId
      : fallbackId;
  if (!id) throw new Error("Legacy health entry has no identifier");
  const sourceId = kind === "stream"
    ? typeof value.sourceId === "string" ? value.sourceId : id
    : undefined;
  return {
    id,
    ...(sourceId ? { sourceId } : {}),
    snapshot: value,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
