import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  accessSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  EMPTY_STORAGE_UI_STATE,
  type StorageMode,
  type StorageUiState,
} from "../storage/storage-types.js";

export type DataDirectoryMode = StorageMode;

export type DataDirectoryErrorCode =
  | "PORTABLE_DATA_NOT_WRITABLE"
  | "DATA_ROOT_NOT_WRITABLE"
  | "DATA_MIGRATION_FAILED";

export class DataDirectoryError extends Error {
  public readonly code: DataDirectoryErrorCode;

  public constructor(code: DataDirectoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataDirectoryError";
    this.code = code;
  }
}

export interface DataDirectories {
  mode: DataDirectoryMode;
  dataRoot: string;
  database: string;
  cache: string;
  logs: string;
  temp: string;
  backups: string;
  settings: string;
}

export interface DataDirectoryResolverOptions {
  executablePath?: string;
  packaged?: boolean;
  portableExecutableName?: string;
}

export class DataDirectoryResolver {
  private readonly userDataRoot: string;
  private readonly executablePath: string;
  private readonly packaged: boolean;
  private readonly portableExecutableName: string;
  private readonly modePreferencePath: string;
  private modeOverride: DataDirectoryMode | undefined;
  private dataRootOverride: string | undefined;

  public constructor(userDataRoot: string, options: DataDirectoryResolverOptions = {}) {
    this.userDataRoot = resolve(userDataRoot);
    this.executablePath = resolve(options.executablePath ?? process.execPath);
    this.packaged = options.packaged ?? false;
    this.portableExecutableName = (options.portableExecutableName ?? "QX影视.exe").toLowerCase();
    this.modePreferencePath = join(this.userDataRoot, "storage-mode.json");
    const preference = readModePreference(this.modePreferencePath);
    this.modeOverride = preference?.mode;
    this.dataRootOverride = preference?.dataRoot;
  }

  public resolve(): DataDirectories {
    const mode = this.modeOverride ?? this.detectMode();
    return this.directories(mode);
  }

  public resolveForMode(mode: DataDirectoryMode): DataDirectories {
    return this.directories(mode);
  }

  public setModeOverride(mode: DataDirectoryMode | undefined): void {
    this.modeOverride = mode;
    this.writeModePreference();
  }

  public setDataRootOverride(dataRoot: string | undefined): void {
    this.dataRootOverride = dataRoot ? resolve(dataRoot) : undefined;
    this.writeModePreference();
  }

  public prepare(directories = this.resolve()): DataDirectories {
    try {
      assertSafeRoot(directories.dataRoot);
      mkdirSync(directories.dataRoot, { recursive: true });
      for (const directory of [directories.cache, directories.logs, directories.temp, directories.backups, directories.settings]) {
        mkdirSync(directory, { recursive: true });
      }
      probeWritable(directories.dataRoot);
      probeWritable(directories.cache);
      return directories;
    } catch (error) {
      const code = directories.mode === "portable"
        ? "PORTABLE_DATA_NOT_WRITABLE"
        : "DATA_ROOT_NOT_WRITABLE";
      throw new DataDirectoryError(code, code, { cause: error });
    }
  }

  private detectMode(): DataDirectoryMode {
    if (!this.packaged) return "normal";
    const executableName = basename(this.executablePath).toLowerCase();
    if (executableName !== this.portableExecutableName) return "normal";
    const portableRoot = join(dirname(this.executablePath), "data");
    return isDirectory(portableRoot) ? "portable" : "normal";
  }

  private writeModePreference(): void {
    try {
      mkdirSync(dirname(this.modePreferencePath), { recursive: true });
      writeFileSync(this.modePreferencePath, JSON.stringify({
        ...(this.modeOverride ? { mode: this.modeOverride } : {}),
        ...(this.dataRootOverride ? { dataRoot: this.dataRootOverride } : {}),
      }), "utf8");
    } catch {
      // A preference is only a user choice; the formal executable/data rule remains the fallback.
    }
  }

  private directories(mode: DataDirectoryMode): DataDirectories {
    const dataRoot = mode === "normal" && this.dataRootOverride
      ? this.dataRootOverride
      : mode === "portable"
        ? join(dirname(this.executablePath), "data")
        : this.userDataRoot;
    return {
      mode,
      dataRoot,
      database: join(dataRoot, "qx-yingshi.db"),
      cache: join(dataRoot, "cache"),
      logs: join(dataRoot, "logs"),
      temp: join(dataRoot, "temp"),
      backups: join(dataRoot, "backups"),
      settings: join(dataRoot, "settings"),
    };
  }
}

export interface DataMigrationResult {
  from: DataDirectories;
  to: DataDirectories;
  backupPath: string | null;
  archivedSourcePath: string | null;
}

const MIGRATED_ENTRIES = [
  "qx-yingshi.db",
  "qx-yingshi.db-wal",
  "qx-yingshi.db-shm",
  "cache",
  "logs",
  "temp",
  "backups",
  "settings",
  "trusted-sources.json",
  "desktop-state.json",
  "config-history.json",
  "source-health.json",
  "stream-health.json",
  "storage-mode.json",
] as const;

/** Owns the filesystem side of storage state and mode migration. */
export class DataStorageService {
  public constructor(private readonly resolver: DataDirectoryResolver) {}

  public prepare(): DataDirectories {
    return this.resolver.prepare();
  }

  public directories(): DataDirectories {
    return this.resolver.resolve();
  }

  public selectMode(mode: DataDirectoryMode, dataRoot?: string): void {
    this.resolver.setDataRootOverride(dataRoot);
    this.resolver.setModeOverride(mode);
  }

  public uiState(): StorageUiState {
    const directories = this.directories();
    const databaseBytes = fileSize(directories.database);
    const cacheBytes = directorySize(directories.cache);
    const counts = databaseCounts(directories.database);
    return {
      ...EMPTY_STORAGE_UI_STATE,
      mode: directories.mode,
      dataRoot: redactPath(directories.dataRoot),
      normalRoot: redactPath(this.resolver.resolveForMode("normal").dataRoot),
      portableRoot: redactPath(this.resolver.resolveForMode("portable").dataRoot),
      databaseBytes,
      cacheBytes,
      totalBytes: directorySize(directories.dataRoot),
      ...counts,
      writable: isWritableDirectory(directories.dataRoot) && isWritableDirectory(directories.cache),
    };
  }

  public migrateTo(targetMode: DataDirectoryMode): DataMigrationResult {
    const from = this.directories();
    const to = this.resolver.resolveForMode(targetMode);
    if (samePath(from.dataRoot, to.dataRoot)) {
      return { from, to, backupPath: null, archivedSourcePath: null };
    }
    if (!existsSync(from.database)) {
      throw new DataDirectoryError("DATA_MIGRATION_FAILED", "DATA_MIGRATION_FAILED");
    }
    try {
      assertSafeRoot(from.dataRoot);
      if (existsSync(to.dataRoot)) assertSafeRoot(to.dataRoot);
    } catch (error) {
      throw new DataDirectoryError("DATA_MIGRATION_FAILED", "DATA_MIGRATION_FAILED", { cause: error });
    }

    const stage = join(dirname(to.dataRoot), `.qx-data-migration-${randomUUID()}`);
    let backupPath: string | null = null;
    let archivedSourcePath: string | null = null;
    try {
      mkdirSync(stage, { recursive: true });
      copyEntries(from.dataRoot, stage);
      validateDatabase(join(stage, basename(from.database)));

      if (existsSync(to.dataRoot)) {
        backupPath = join(to.dataRoot, "backups", `mode-switch-${randomUUID()}`);
        mkdirSync(backupPath, { recursive: true });
        backupEntries(to.dataRoot, backupPath);
        try {
          installIntoExisting(stage, to.dataRoot);
        } catch (error) {
          restoreEntries(backupPath, to.dataRoot);
          throw error;
        }
      } else {
        renameSync(stage, to.dataRoot);
      }

      if (from.mode === "portable" && targetMode === "normal") {
        archivedSourcePath = `${from.dataRoot}.previous-${randomUUID()}`;
        renameSync(from.dataRoot, archivedSourcePath);
      }
      this.resolver.setModeOverride(targetMode);
      return { from, to, backupPath, archivedSourcePath };
    } catch (error) {
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      if (error instanceof DataDirectoryError) throw error;
      throw new DataDirectoryError("DATA_MIGRATION_FAILED", "DATA_MIGRATION_FAILED", { cause: error });
    }
  }
}

function copyEntries(sourceRoot: string, targetRoot: string): void {
  for (const entry of MIGRATED_ENTRIES) {
    const source = join(sourceRoot, entry);
    if (!existsSync(source)) continue;
    copyEntry(source, join(targetRoot, entry));
  }
}

function backupEntries(sourceRoot: string, backupRoot: string): void {
  for (const entry of MIGRATED_ENTRIES) {
    if (entry === "backups") continue;
    const source = join(sourceRoot, entry);
    if (!existsSync(source)) continue;
    copyEntry(source, join(backupRoot, entry));
  }
}

function installIntoExisting(stage: string, targetRoot: string): void {
  for (const entry of MIGRATED_ENTRIES) {
    const staged = join(stage, entry);
    if (!existsSync(staged)) continue;
    const target = join(targetRoot, entry);
    if (entry === "backups") {
      mergeDirectory(staged, target);
      continue;
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staged, target);
  }
  rmSync(stage, { recursive: true, force: true });
}

function restoreEntries(backupRoot: string, targetRoot: string): void {
  for (const entry of MIGRATED_ENTRIES) {
    if (entry === "backups") continue;
    const backup = join(backupRoot, entry);
    const target = join(targetRoot, entry);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    if (existsSync(backup)) copyEntry(backup, target);
  }
}

function mergeDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry);
    const targetPath = join(target, entry);
    if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
    renameSync(sourcePath, targetPath);
  }
}

function copyEntry(source: string, target: string): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error("DATA_MIGRATION_SYMLINK");
  if (sourceStat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) copyEntry(join(source, entry), join(target, entry));
    return;
  }
  if (!sourceStat.isFile()) throw new Error("DATA_MIGRATION_ENTRY_INVALID");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function validateDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (row?.integrity_check !== "ok") throw new Error("DATA_MIGRATION_INTEGRITY_FAILED");
  } finally {
    database.close();
  }
}

function probeWritable(directory: string): void {
  const path = join(directory, `.qx-write-test-${randomUUID()}`);
  writeFileSync(path, "ok", { flag: "wx" });
  unlinkSync(path);
}

function assertSafeRoot(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("DATA_ROOT_SYMLINK");
}

function fileSize(path: string): number {
  try {
    const value = statSync(path);
    return value.isFile() ? value.size : 0;
  } catch {
    return 0;
  }
}

function databaseCounts(path: string): Pick<StorageUiState, "historyCount" | "favoritesCount" | "followCount"> {
  if (!existsSync(path)) return { historyCount: 0, favoritesCount: 0, followCount: 0 };
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const count = (table: string): number => {
        const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown } | undefined;
        return typeof row?.count === "number" ? row.count : 0;
      };
      return {
        historyCount: count("history"),
        favoritesCount: count("favorites"),
        followCount: count("follow_items"),
      };
    } finally {
      database.close();
    }
  } catch {
    return { historyCount: 0, favoritesCount: 0, followCount: 0 };
  }
}

function directorySize(path: string): number {
  try {
    const value = lstatSync(path);
    if (value.isSymbolicLink()) return 0;
    if (value.isFile()) return value.size;
    if (!value.isDirectory()) return 0;
    return readdirSync(path).reduce((total, entry) => total + directorySize(join(path, entry)), 0);
  } catch {
    return 0;
  }
}

function isWritableDirectory(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return isDirectory(path);
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function redactPath(path: string): string {
  return `…/${basename(path)}`;
}

function readModePreference(path: string): { mode?: DataDirectoryMode; dataRoot?: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown; dataRoot?: unknown };
    return {
      ...(value.mode === "normal" || value.mode === "portable" ? { mode: value.mode } : {}),
      ...(typeof value.dataRoot === "string" && value.dataRoot.length > 0 ? { dataRoot: resolve(value.dataRoot) } : {}),
    };
  } catch {
    return null;
  }
}
