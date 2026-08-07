import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";

import { isDataLayerError } from "./errors.js";
import { SqliteDataLayer, type SqliteDataLayer as SqliteDataLayerType } from "./sqlite.js";
import {
  type BackupManifest,
  type BackupPreview,
  type BackupSummary,
} from "../backup-types.js";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATABASE_ENTRY = "data/database.db";
export const BACKUP_TRUST_ENTRY = "data/trusted-sources.json";

const DEFAULT_LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 1000,
} as const;

export type BackupRestoreErrorCode =
  | "BACKUP_ARCHIVE_INVALID"
  | "BACKUP_CHECKSUM_FAILED"
  | "BACKUP_DATABASE_INVALID"
  | "BACKUP_PATH_INVALID"
  | "BACKUP_PRE_RESTORE_FAILED"
  | "BACKUP_RESTORE_FAILED"
  | "BACKUP_VERSION_TOO_NEW"
  | "BACKUP_ZIP_BOMB"
  | "BACKUP_ZIP_SLIP";

export class BackupRestoreError extends Error {
  public readonly code: BackupRestoreErrorCode;

  public constructor(code: BackupRestoreErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupRestoreError";
    this.code = code;
  }
}

export interface BackupCreationResult {
  fileName: string;
  size: number;
  createdAt: string;
  includeCache: boolean;
  summary: BackupSummary;
  manifest: BackupManifest;
}

export interface BackupRestoreResult {
  preRestoreBackupPath: string | null;
  summary: BackupSummary;
}

export interface BackupRestoreServiceOptions {
  dataRoot: string;
  databasePath: string;
  backupsDirectory: string;
  tempDirectory?: string;
  appVersion?: string;
  now?: () => number;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

interface PendingRestore {
  archivePath: string;
  stageDirectory: string;
  preview: BackupPreview;
}

export class BackupRestoreService {
  private readonly dataRoot: string;
  private readonly databasePath: string;
  private readonly backupsDirectory: string;
  private readonly tempDirectory: string;
  private readonly appVersion: string;
  private readonly now: () => number;
  private readonly limits: typeof DEFAULT_LIMITS;
  private pendingRestore: PendingRestore | null = null;

  public constructor(options: BackupRestoreServiceOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.databasePath = resolve(options.databasePath);
    this.backupsDirectory = resolve(options.backupsDirectory);
    this.tempDirectory = resolve(options.tempDirectory ?? join(this.dataRoot, "temp"));
    this.appVersion = options.appVersion ?? "0.1.0";
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  }

  public async createBackup(
    layer: SqliteDataLayer,
    options: { includeCache?: boolean } = {},
  ): Promise<BackupCreationResult> {
    const includeCache = options.includeCache === true;
    const workDirectory = this.createWorkDirectory(".qx-backup-");
    const snapshotPath = join(workDirectory, "database.db");
    let snapshot: DatabaseSync | undefined;
    try {
      await layer.backupTo(snapshotPath);
      snapshot = new DatabaseSync(snapshotPath, { timeout: 500 });
      sanitizeSnapshot(snapshot, includeCache);
      const summary = summarizeDatabase(snapshot);
      const databaseSchemaVersion = schemaVersion(snapshot);
      snapshot.close();
      snapshot = undefined;

      const dataEntries: ZipEntry[] = [{
        name: BACKUP_DATABASE_ENTRY,
        data: readFileSync(snapshotPath),
      }];
      const trustedPath = join(this.dataRoot, "trusted-sources.json");
      if (existsSync(trustedPath)) {
        const trustedData = sanitizeTrustFile(readFileSync(trustedPath));
        if (trustedData) dataEntries.push({ name: BACKUP_TRUST_ENTRY, data: trustedData });
      }
      if (includeCache) {
        for (const entry of collectFiles(join(this.dataRoot, "cache"), "cache", this.limits)) {
          dataEntries.push(entry);
        }
      }

      const createdAt = new Date(this.now()).toISOString();
      const sections = [
        "database",
        ...(dataEntries.some((entry) => entry.name === BACKUP_TRUST_ENTRY) ? ["trusted-sources"] : []),
        ...(includeCache ? ["cache"] : []),
      ];
      const checksums = Object.fromEntries(dataEntries.map((entry) => [entry.name, sha256(entry.data)]));
      const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        appVersion: this.appVersion,
        createdAt,
        sections,
        checksums,
        databaseSchemaVersion,
        summary,
      };
      const fileName = `qx-backup-${formatFileStamp(this.now())}-${randomUUID()}.zip`;
      mkdirSync(this.backupsDirectory, { recursive: true });
      const outputPath = join(this.backupsDirectory, fileName);
      const partialPath = `${outputPath}.part`;
      writeZipArchive(partialPath, [
        { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
        ...dataEntries,
      ]);
      renameSync(partialPath, outputPath);
      return {
        fileName,
        size: statSync(outputPath).size,
        createdAt,
        includeCache,
        summary,
        manifest,
      };
    } catch (error) {
      throw mapBackupError(error, "BACKUP_ARCHIVE_INVALID");
    } finally {
      snapshot?.close();
      removePath(workDirectory);
    }
  }

  public preview(archivePath: string): BackupPreview {
    this.clearPreview();
    const stageDirectory = this.createWorkDirectory(".qx-restore-");
    try {
      const entries = readZipArchive(resolve(archivePath), this.limits);
      const manifest = parseManifest(entries);
      verifyArchive(entries, manifest);
      extractEntries(entries, manifest, stageDirectory);

      const stageDatabase = join(stageDirectory, BACKUP_DATABASE_ENTRY);
      let layer: SqliteDataLayer | undefined;
      try {
        const opened = openStagedDatabase(stageDatabase);
        layer = opened.layer;
        const summary = summarizeLayer(layer);
        const preview: BackupPreview = {
          formatVersion: manifest.formatVersion,
          appVersion: manifest.appVersion,
          createdAt: manifest.createdAt,
          sections: [...manifest.sections],
          databaseSchemaVersion: layer.schemaVersion,
          summary,
          includeCache: manifest.sections.includes("cache"),
          compatibility: manifest.formatVersion < BACKUP_FORMAT_VERSION ? "migration-required" : "compatible",
        };
        this.pendingRestore = { archivePath: resolve(archivePath), stageDirectory, preview };
        layer.close();
        layer = undefined;
        return clonePreview(preview);
      } finally {
        layer?.close();
      }
    } catch (error) {
      removePath(stageDirectory);
      throw mapBackupError(error, "BACKUP_ARCHIVE_INVALID");
    }
  }

  public currentPreview(): BackupPreview | null {
    return this.pendingRestore ? clonePreview(this.pendingRestore.preview) : null;
  }

  public clearPreview(): void {
    if (this.pendingRestore) removePath(this.pendingRestore.stageDirectory);
    this.pendingRestore = null;
  }

  public restore(): BackupRestoreResult {
    const pending = this.pendingRestore;
    if (!pending) throw new BackupRestoreError("BACKUP_RESTORE_FAILED", "No backup restore is staged");

    const includeCache = pending.preview.includeCache;
    let preRestoreBackupPath: string | null = null;
    try {
      preRestoreBackupPath = this.createPreRestoreBackup(includeCache);
    } catch (error) {
      throw new BackupRestoreError("BACKUP_PRE_RESTORE_FAILED", "Unable to create the pre-restore backup", { cause: error });
    }

    const restoreId = randomUUID();
    const previousDatabase = `${this.databasePath}.restore-previous-${restoreId}`;
    const previousWal = `${this.databasePath}-wal.restore-previous-${restoreId}`;
    const previousShm = `${this.databasePath}-shm.restore-previous-${restoreId}`;
    const trustedPath = join(this.dataRoot, "trusted-sources.json");
    const previousTrusted = `${trustedPath}.restore-previous-${restoreId}`;
    const cachePath = join(this.dataRoot, "cache");
    const previousCache = `${cachePath}.restore-previous-${restoreId}`;
    const stagedDatabase = join(pending.stageDirectory, BACKUP_DATABASE_ENTRY);
    const stagedTrusted = join(pending.stageDirectory, BACKUP_TRUST_ENTRY);
    const stagedCache = join(pending.stageDirectory, "cache");
    let oldDatabaseMoved = false;
    let oldWalMoved = false;
    let oldShmMoved = false;
    let oldTrustedMoved = false;
    let oldCacheMoved = false;
    let newDatabaseInstalled = false;
    let newTrustedInstalled = false;
    let newCacheInstalled = false;
    let restoreSucceeded = false;
    try {
      moveIfExists(this.databasePath, previousDatabase);
      oldDatabaseMoved = existsSync(previousDatabase);
      moveIfExists(`${this.databasePath}-wal`, previousWal);
      oldWalMoved = existsSync(previousWal);
      moveIfExists(`${this.databasePath}-shm`, previousShm);
      oldShmMoved = existsSync(previousShm);
      moveIfExists(trustedPath, previousTrusted);
      oldTrustedMoved = existsSync(previousTrusted);
      if (includeCache) {
        moveIfExists(cachePath, previousCache);
        oldCacheMoved = existsSync(previousCache);
      }

      renameSync(stagedDatabase, this.databasePath);
      newDatabaseInstalled = true;
      if (existsSync(stagedTrusted)) {
        renameSync(stagedTrusted, trustedPath);
        newTrustedInstalled = true;
      }
      if (includeCache) {
        if (existsSync(stagedCache)) renameSync(stagedCache, cachePath);
        else mkdirSync(cachePath, { recursive: true });
        newCacheInstalled = true;
      }
      validateDatabaseFile(this.databasePath);
      removePath(previousDatabase);
      removePath(previousWal);
      removePath(previousShm);
      removePath(previousTrusted);
      removePath(previousCache);
      removePath(pending.stageDirectory);
      this.pendingRestore = null;
      restoreSucceeded = true;
      return {
        preRestoreBackupPath,
        summary: pending.preview.summary,
      };
    } catch (error) {
      try {
        if (newCacheInstalled) removePath(cachePath);
        if (oldCacheMoved) moveIfExists(previousCache, cachePath);
        if (newTrustedInstalled) removePath(trustedPath);
        if (oldTrustedMoved) moveIfExists(previousTrusted, trustedPath);
        if (newDatabaseInstalled) removePath(this.databasePath);
        if (oldDatabaseMoved) moveIfExists(previousDatabase, this.databasePath);
        if (oldWalMoved) moveIfExists(previousWal, `${this.databasePath}-wal`);
        if (oldShmMoved) moveIfExists(previousShm, `${this.databasePath}-shm`);
      } finally {
        removePath(pending.stageDirectory);
        this.pendingRestore = null;
      }
      throw new BackupRestoreError("BACKUP_RESTORE_FAILED", "Restore failed and the previous state was retained", { cause: error });
    } finally {
      if (restoreSucceeded) {
        removePath(previousDatabase);
        removePath(previousWal);
        removePath(previousShm);
        removePath(previousTrusted);
        removePath(previousCache);
      }
    }
  }

  private createPreRestoreBackup(includeCache: boolean): string | null {
    if (!existsSync(this.databasePath) && !existsSync(join(this.dataRoot, "trusted-sources.json"))) return null;
    const path = join(this.backupsDirectory, `pre-restore-${formatFileStamp(this.now())}-${randomUUID()}`);
    mkdirSync(path, { recursive: true });
    try {
      copyIfFile(this.databasePath, join(path, "qx-yingshi.db"));
      copyIfFile(`${this.databasePath}-wal`, join(path, "qx-yingshi.db-wal"));
      copyIfFile(`${this.databasePath}-shm`, join(path, "qx-yingshi.db-shm"));
      copyIfFile(join(this.dataRoot, "trusted-sources.json"), join(path, "trusted-sources.json"));
      if (includeCache && existsSync(join(this.dataRoot, "cache"))) {
        copyEntry(join(this.dataRoot, "cache"), join(path, "cache"));
      }
      writeFileSync(join(path, "manifest.json"), JSON.stringify({ createdAt: new Date(this.now()).toISOString(), includeCache }, null, 2), "utf8");
      return path;
    } catch (error) {
      removePath(path);
      throw error;
    }
  }

  private createWorkDirectory(prefix: string): string {
    mkdirSync(this.tempDirectory, { recursive: true });
    return mkdtempSync(join(this.tempDirectory, prefix));
  }
}

function openStagedDatabase(path: string): { layer: SqliteDataLayer } {
  try {
    // Imported lazily to keep the service's public dependency surface narrow.
    return { layer: SqliteDataLayer.create(path) };
  } catch (error) {
    if (isDataLayerError(error) && error.code === "DATABASE_VERSION_TOO_NEW") {
      throw new BackupRestoreError("BACKUP_VERSION_TOO_NEW", "The backup database is newer than this application", { cause: error });
    }
    throw new BackupRestoreError("BACKUP_DATABASE_INVALID", "The backup database could not be opened", { cause: error });
  }
}

function summarizeLayer(layer: SqliteDataLayerType): BackupSummary {
  return summarizeRows((table) => {
    try {
      const row = layer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown } | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    } catch {
      return 0;
    }
  });
}

function summarizeDatabase(database: DatabaseSync): BackupSummary {
  return summarizeRows((table) => {
    try {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown } | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    } catch {
      return 0;
    }
  });
}

function summarizeRows(count: (table: string) => number): BackupSummary {
  return {
    settings: count("settings"),
    history: count("history"),
    favorites: count("favorites"),
    following: count("follow_items"),
    liveSources: count("live_sources"),
    smartChannels: count("smart_channels"),
  };
}

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version?: unknown } | undefined;
  return typeof row?.version === "number" ? row.version : 0;
}

function sanitizeSnapshot(database: DatabaseSync, includeCache: boolean): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare("SELECT key, value_json FROM settings").all() as Array<{ key?: unknown; value_json?: unknown }>;
    const removeSetting = database.prepare("DELETE FROM settings WHERE key = ?");
    const updateSetting = database.prepare("UPDATE settings SET value_json = ? WHERE key = ?");
    for (const row of rows) {
      if (typeof row.key !== "string") continue;
      if (row.key === "web.security") {
        const safeWebSecurity = sanitizeWebSecuritySetting(row.value_json);
        if (safeWebSecurity) updateSetting.run(safeWebSecurity, row.key);
        else removeSetting.run(row.key);
      } else if (isSensitiveSettingKey(row.key)) {
        removeSetting.run(row.key);
      }
    }
    sanitizeDownloadTaskMetadata(database);
    if (!includeCache) database.exec("DELETE FROM cache_entries");
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original sanitization failure.
    }
    throw error;
  }
}

function isSensitiveSettingKey(key: string): boolean {
  return /authorization|cookie|credential|jellyfin|localproxy|password|pin|secret|session|token|aria2/iu.test(key);
}

function sanitizeWebSecuritySetting(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    return JSON.stringify({ allowLan: parsed.allowLan === true });
  } catch {
    return null;
  }
}

function sanitizeDownloadTaskMetadata(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id FROM download_tasks").all() as Array<{ id?: unknown }>;
  const update = database.prepare("UPDATE download_tasks SET request_reference = ?, backend_id = NULL WHERE id = ?");
  for (const row of rows) {
    if (typeof row.id === "string") update.run(`backup:redacted:${row.id}`, row.id);
  }
}

function sanitizeTrustFile(data: Buffer): Buffer | null {
  try {
    const value: unknown = JSON.parse(data.toString("utf8"));
    if (!Array.isArray(value)) return null;
    const records: Array<string | Record<string, unknown>> = [];
    for (const item of value) {
      if (typeof item === "string") {
        records.push(item);
        continue;
      }
      if (!isRecord(item) || typeof item.source !== "string") continue;
      records.push({
        source: item.source,
        ...(typeof item.fingerprint === "string" ? { fingerprint: item.fingerprint } : {}),
        ...(typeof item.configHash === "string" ? { configHash: item.configHash } : {}),
        ...(isRecord(item.spiderHashes) ? { spiderHashes: item.spiderHashes } : {}),
        ...(Array.isArray(item.engines) ? { engines: item.engines.filter((entry): entry is string => typeof entry === "string") } : {}),
        ...(Array.isArray(item.allowedDomains) ? { allowedDomains: item.allowedDomains.filter((entry): entry is string => typeof entry === "string") } : {}),
        ...(typeof item.usesCookie === "boolean" ? { usesCookie: item.usesCookie } : {}),
        ...(typeof item.requestsLocalService === "boolean" ? { requestsLocalService: item.requestsLocalService } : {}),
        ...(typeof item.trustedAt === "number" ? { trustedAt: item.trustedAt } : {}),
      });
    }
    return Buffer.from(`${JSON.stringify(records, null, 2)}\n`, "utf8");
  } catch {
    return null;
  }
}

function collectFiles(root: string, prefix: string, limits: typeof DEFAULT_LIMITS): ZipEntry[] {
  if (!existsSync(root)) return [];
  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  const visit = (current: string): void => {
    const value = lstatSync(current);
    if (value.isSymbolicLink()) throw new BackupRestoreError("BACKUP_PATH_INVALID", "Cache contains a symbolic link");
    if (value.isDirectory()) {
      for (const entry of readdirSync(current)) visit(join(current, entry));
      return;
    }
    if (!value.isFile()) throw new BackupRestoreError("BACKUP_PATH_INVALID", "Cache contains an unsupported entry");
    if (value.size > limits.maxEntryBytes || totalBytes + value.size > limits.maxTotalBytes) {
      throw new BackupRestoreError("BACKUP_ZIP_BOMB", "Cache exceeds the backup size limits");
    }
    const relativeName = relative(root, current).split(sep).join("/");
    entries.push({ name: `${prefix}/${relativeName}`, data: readFileSync(current) });
    totalBytes += value.size;
  };
  visit(root);
  if (entries.length > limits.maxEntries) throw new BackupRestoreError("BACKUP_ZIP_BOMB", "Backup contains too many entries");
  return entries;
}

function writeZipArchive(path: string, entries: readonly ZipEntry[]): void {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const entry of entries) {
    validateZipName(entry.name);
    if (names.has(entry.name)) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Duplicate ZIP entry");
    names.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.byteLength + entry.data.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(path, Buffer.concat([...localParts, centralDirectory, end]), { flag: "w" });
}

function readZipArchive(path: string, limits: typeof DEFAULT_LIMITS): Map<string, Buffer> {
  let archive: Buffer;
  try {
    archive = readFileSync(path);
  } catch (error) {
    throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "The backup archive could not be read", { cause: error });
  }
  if (archive.byteLength > limits.maxArchiveBytes) throw new BackupRestoreError("BACKUP_ZIP_BOMB", "The backup archive is too large");
  const endOffset = findEndOfCentralDirectory(archive);
  if (endOffset < 0) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "The ZIP end record is missing");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP64 archives are not supported");
  }
  if (entryCount > limits.maxEntries || centralOffset + centralSize > archive.byteLength) {
    throw new BackupRestoreError("BACKUP_ZIP_BOMB", "The ZIP central directory exceeds limits");
  }
  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.byteLength || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Invalid ZIP central directory");
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > archive.byteLength) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Invalid ZIP entry header");
    const name = archive.subarray(nameStart, nameEnd).toString("utf8");
    validateZipName(name);
    const unixMode = (versionMadeBy >>> 8) === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw new BackupRestoreError("BACKUP_ZIP_SLIP", "Symlink ZIP entries are not allowed");
    if (flags & 0x1) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Encrypted ZIP entries are not allowed");
    if (uncompressedSize > limits.maxEntryBytes || totalBytes + uncompressedSize > limits.maxTotalBytes) {
      throw new BackupRestoreError("BACKUP_ZIP_BOMB", "ZIP entry size exceeds limits");
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw new BackupRestoreError("BACKUP_ZIP_BOMB", "ZIP compression ratio exceeds limits");
    }
    if (localOffset + 30 > archive.byteLength || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Invalid ZIP local header");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localDataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (localDataStart + compressedSize > archive.byteLength) {
      throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP entry data is truncated");
    }
    const localName = archive.subarray(localOffset + 30, localDataStart - localExtraLength).toString("utf8");
    if (localName !== name) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP central/local names differ");
    const compressed = archive.subarray(localDataStart, localDataStart + compressedSize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
    } catch (error) {
      throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP decompression failed", { cause: error });
    }
    if (method !== 0 && method !== 8) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP compression method is unsupported");
    if (data.byteLength !== uncompressedSize) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP size check failed");
    if (crc32(data) !== archive.readUInt32LE(cursor + 16)) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "ZIP CRC check failed");
    if (entries.has(name)) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Duplicate ZIP entry");
    entries.set(name, data);
    totalBytes += data.byteLength;
    cursor = next;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const start = Math.max(0, archive.byteLength - 22 - 0xffff);
  for (let index = archive.byteLength - 22; index >= start; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function parseManifest(entries: Map<string, Buffer>): BackupManifest {
  const raw = entries.get("manifest.json");
  if (!raw) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "manifest.json is missing");
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "manifest.json is invalid", { cause: error });
  }
  if (!isRecord(value) || typeof value.formatVersion !== "number" || !Number.isInteger(value.formatVersion)) {
    throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Backup formatVersion is missing");
  }
  if (value.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupRestoreError("BACKUP_VERSION_TOO_NEW", "The backup format is newer than this application");
  }
  if (value.formatVersion < 0) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "Backup formatVersion is invalid");
  const checksums = isRecord(value.checksums)
    ? Object.fromEntries(Object.entries(value.checksums).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  if (value.formatVersion === 0 && Object.keys(checksums).length === 0) {
    for (const name of entries.keys()) if (name !== "manifest.json") checksums[name] = sha256(entries.get(name) as Buffer);
  }
  const sections = Array.isArray(value.sections)
    ? value.sections.filter((entry): entry is string => typeof entry === "string")
    : ["database"];
  const summary = normalizeSummary(value.summary);
  return {
    formatVersion: value.formatVersion,
    appVersion: typeof value.appVersion === "string" ? value.appVersion : "unknown",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    sections,
    checksums,
    databaseSchemaVersion: typeof value.databaseSchemaVersion === "number" ? value.databaseSchemaVersion : 0,
    summary,
  };
}

function verifyArchive(entries: Map<string, Buffer>, manifest: BackupManifest): void {
  const database = manifest.checksums[BACKUP_DATABASE_ENTRY];
  if (!database || !entries.has(BACKUP_DATABASE_ENTRY)) {
    throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", "The backup database entry is missing");
  }
  for (const [name, expected] of Object.entries(manifest.checksums)) {
    const data = entries.get(name);
    if (!data || !/^[a-f0-9]{64}$/iu.test(expected) || sha256(data) !== expected.toLowerCase()) {
      throw new BackupRestoreError("BACKUP_CHECKSUM_FAILED", `Backup checksum failed for ${name}`);
    }
  }
  for (const name of entries.keys()) {
    if (name !== "manifest.json" && !Object.prototype.hasOwnProperty.call(manifest.checksums, name)) {
      throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", `Unexpected backup entry: ${name}`);
    }
  }
  for (const name of Object.keys(manifest.checksums)) {
    if (name !== BACKUP_DATABASE_ENTRY && name !== BACKUP_TRUST_ENTRY && !name.startsWith("cache/")) {
      throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", `Backup entry is outside the allowlist: ${name}`);
    }
  }
}

function extractEntries(entries: Map<string, Buffer>, manifest: BackupManifest, stageDirectory: string): void {
  for (const name of Object.keys(manifest.checksums)) {
    const data = entries.get(name);
    if (!data) throw new BackupRestoreError("BACKUP_ARCHIVE_INVALID", `Missing backup entry: ${name}`);
    const destination = resolveWithin(stageDirectory, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data, { flag: "wx" });
  }
}

function validateDatabaseFile(path: string): void {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    const row = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (row?.integrity_check !== "ok") throw new Error("DATABASE_INTEGRITY_FAILED");
  } finally {
    database?.close();
  }
}

function moveIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  assertNotSymlink(source);
  if (existsSync(target)) removePath(target);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

function copyIfFile(source: string, target: string): void {
  if (!existsSync(source)) return;
  assertNotSymlink(source);
  if (!lstatSync(source).isFile()) throw new Error("BACKUP_PATH_INVALID");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyEntry(source: string, target: string): void {
  assertNotSymlink(source);
  const value = lstatSync(source);
  if (value.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) copyEntry(join(source, entry), join(target, entry));
    return;
  }
  if (!value.isFile()) throw new Error("BACKUP_PATH_INVALID");
  copyIfFile(source, target);
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new BackupRestoreError("BACKUP_PATH_INVALID", "Symlink data entries are not allowed");
}

function resolveWithin(root: string, child: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, child);
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
    throw new BackupRestoreError("BACKUP_ZIP_SLIP", "Archive entry escapes the staging directory");
  }
  return target;
}

function validateZipName(name: string): void {
  if (!name || name.length > 512 || name.includes("\0") || name.includes("\\")) {
    throw new BackupRestoreError("BACKUP_ZIP_SLIP", "Archive entry path is invalid");
  }
  if (name.startsWith("/") || name.startsWith("//") || /^[a-z]:/iu.test(name)) {
    throw new BackupRestoreError("BACKUP_ZIP_SLIP", "Absolute archive paths are not allowed");
  }
  const parts = name.split("/");
  if (parts.includes("..") || parts.includes(".")) {
    throw new BackupRestoreError("BACKUP_ZIP_SLIP", "Archive traversal paths are not allowed");
  }
}

function normalizeSummary(value: unknown): BackupSummary {
  const record = isRecord(value) ? value : {};
  const number = (key: keyof BackupSummary): number => typeof record[key] === "number" && Number.isFinite(record[key])
    ? Math.max(0, Math.floor(record[key] as number))
    : 0;
  return {
    settings: number("settings"),
    history: number("history"),
    favorites: number("favorites"),
    following: number("following"),
    liveSources: number("liveSources"),
    smartChannels: number("smartChannels"),
  };
}

function clonePreview(value: BackupPreview): BackupPreview {
  return { ...value, sections: [...value.sections], summary: { ...value.summary } };
}

function formatFileStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function removePath(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

function mapBackupError(error: unknown, fallback: BackupRestoreErrorCode): BackupRestoreError {
  if (error instanceof BackupRestoreError) return error;
  if (isDataLayerError(error) && error.code === "DATABASE_VERSION_TOO_NEW") {
    return new BackupRestoreError("BACKUP_VERSION_TOO_NEW", "The backup database is newer than this application", { cause: error });
  }
  return new BackupRestoreError(fallback, fallback, { cause: error as Error });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let crcTable: Uint32Array | undefined;

function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of data) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
