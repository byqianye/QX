import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";

import { type SqliteDataLayer } from "../data/sqlite.js";
import {
  Aria2Backend,
  DownloadError,
  FakeDownloadBackend,
  type DownloadBackend,
  type DownloadBackendSnapshot,
  UnavailableDownloadBackend,
} from "./download-backend.js";
import {
  DownloadRepository,
  type DownloadTargetDirectoryRecord,
  type DownloadTaskRecord,
} from "./download-repository.js";
import {
  EMPTY_DOWNLOAD_UI_STATE,
  type DownloadStatus,
  type DownloadTargetDirectory,
  type DownloadTask,
  type DownloadUiState,
} from "./download-types.js";

export type DownloadServiceErrorCode =
  | "DOWNLOAD_URL_INVALID"
  | "DOWNLOAD_NOT_ELIGIBLE"
  | "DOWNLOAD_FILENAME_INVALID"
  | "DOWNLOAD_TARGET_NOT_FOUND"
  | "DOWNLOAD_TARGET_INVALID"
  | "DOWNLOAD_TASK_NOT_FOUND"
  | "DOWNLOAD_OPERATION_INVALID"
  | "DOWNLOAD_LIMIT_REACHED";

export type DownloadErrorCode = DownloadServiceErrorCode | import("./download-backend.js").DownloadErrorCode;

export interface DownloadAddInput {
  title?: string;
  requestReference: string;
  suggestedFilename?: string;
  targetDirectoryId: string;
  sourceId?: string | null;
  contentId?: string | null;
  sourceDownload?: boolean;
  explicitUserUrl?: boolean;
}

export interface DownloadServiceOptions {
  db: SqliteDataLayer;
  backend?: DownloadBackend;
  now?: () => number;
  maxTasks?: number;
}

export class DownloadServiceError extends Error {
  public readonly code: DownloadServiceErrorCode;

  public constructor(code: DownloadServiceErrorCode, message: string) {
    super(message);
    this.name = "DownloadServiceError";
    this.code = code;
  }
}

interface InternalDownloadError extends Error {
  code?: string;
}

export class DownloadService {
  private readonly repository: DownloadRepository;
  private readonly backend: DownloadBackend;
  private readonly now: () => number;
  private readonly maxTasks: number;
  private error: { code: string; message: string } | null = null;
  private closed = false;

  public constructor(options: DownloadServiceOptions) {
    this.repository = new DownloadRepository(options.db);
    this.backend = options.backend ?? new UnavailableDownloadBackend();
    this.now = options.now ?? Date.now;
    this.maxTasks = positiveInteger(options.maxTasks, 1_000);
    if (!this.backend.available) {
      this.error = { code: "ARIA2_UNAVAILABLE", message: "aria2 is not configured; set QX_ARIA2_PATH" };
    }
    this.pauseInterruptedTasks();
  }

  public get backendKind(): DownloadUiState["backend"] {
    return this.backend.kind;
  }

  public get aria2Available(): boolean {
    return this.backend.kind === "aria2" && this.backend.available;
  }

  public uiState(): DownloadUiState {
    const targetDirectories = this.repository.listTargetDirectories().map((directory) => ({
      id: directory.id,
      displayName: directory.displayName,
      createdAt: directory.createdAt,
      updatedAt: directory.updatedAt,
      taskCount: directory.taskCount,
    } satisfies DownloadTargetDirectory));
    const tasks = this.repository.listTasks().map((task) => this.publicTask(task));
    return {
      ...EMPTY_DOWNLOAD_UI_STATE,
      tasks,
      targetDirectories,
      backend: this.backend.kind,
      aria2Available: this.aria2Available,
      error: this.error ? { ...this.error } : null,
    };
  }

  public async selectTargetDirectory(directoryPath: string): Promise<DownloadTargetDirectory> {
    this.ensureOpen();
    const canonical = canonicalTargetDirectory(directoryPath);
    const existing = this.repository.findTargetDirectoryByPath(canonical);
    if (existing) return this.publicTargetDirectory(existing, this.repository.listTargetDirectories());
    const now = this.now();
    const record: DownloadTargetDirectoryRecord = {
      id: `download-dir-${createHash("sha256").update(canonical.toLowerCase(), "utf8").digest("hex").slice(0, 24)}`,
      directoryPath: canonical,
      displayName: basename(canonical) || canonical,
      createdAt: now,
      updatedAt: now,
    };
    this.repository.upsertTargetDirectory(record);
    return this.publicTargetDirectory(record, this.repository.listTargetDirectories());
  }

  /** Only the main process may use this internal path for the native folder opener. */
  public targetDirectoryPath(targetDirectoryId: string): string {
    this.ensureOpen();
    const record = this.repository.getTargetDirectory(targetDirectoryId);
    if (!record) throw new DownloadServiceError("DOWNLOAD_TARGET_NOT_FOUND", "下载目录不存在。");
    return record.directoryPath;
  }

  public async add(input: DownloadAddInput): Promise<DownloadTask> {
    this.ensureOpen();
    if (this.repository.listTasks(true).filter((task) => task.status !== "removed").length >= this.maxTasks) {
      throw new DownloadServiceError("DOWNLOAD_LIMIT_REACHED", "下载任务数量已达到上限。");
    }
    const url = validateDownloadUrl(input.requestReference);
    if (input.sourceDownload !== true && input.explicitUserUrl !== true) {
      throw new DownloadServiceError("DOWNLOAD_NOT_ELIGIBLE", "当前来源没有提供合法下载能力。");
    }
    if (isHlsUrl(url) && input.sourceDownload !== true) {
      throw new DownloadServiceError("DOWNLOAD_NOT_ELIGIBLE", "普通 HLS 播放地址不能直接创建下载任务。");
    }
    const target = this.repository.getTargetDirectory(input.targetDirectoryId);
    if (!target) throw new DownloadServiceError("DOWNLOAD_TARGET_NOT_FOUND", "请先选择下载目录。");
    const filename = uniqueFilename(
      target.directoryPath,
      input.suggestedFilename?.trim()
        ? validateSuggestedFilename(input.suggestedFilename)
        : sanitizeDownloadFilename(filenameFromUrl(url)),
      this.repository.listTasks(true),
      target.id,
    );
    const now = this.now();
    let record: DownloadTaskRecord = {
      id: `download-${randomUUID()}`,
      sourceId: input.sourceId ?? null,
      contentId: input.contentId ?? null,
      title: normalizeTitle(input.title, filename),
      targetDirectoryId: target.id,
      suggestedFilename: filename,
      requestReference: url,
      status: "queued",
      totalBytes: null,
      completedBytes: null,
      speed: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      error: null,
      backendId: null,
    };
    this.repository.upsertTask(record);
    try {
      const snapshot = await this.backend.add({
        url,
        targetDirectory: target.directoryPath,
        filename,
      });
      record = applySnapshot(record, snapshot, this.now());
      this.error = null;
    } catch (error) {
      record = applyFailure(record, error, this.now());
      this.error = { code: errorCode(error), message: safeErrorMessage(error) };
      this.repository.upsertTask(record);
      throw error;
    }
    this.repository.upsertTask(record);
    return this.publicTask(record);
  }

  public async pause(taskId: string): Promise<DownloadTask> {
    return this.mutate(taskId, "pause", (backendId) => this.backend.pause(backendId));
  }

  public async resume(taskId: string): Promise<DownloadTask> {
    return this.mutate(taskId, "resume", (backendId) => this.backend.resume(backendId));
  }

  public async cancel(taskId: string): Promise<DownloadTask> {
    return this.mutate(taskId, "cancel", (backendId) => this.backend.cancel(backendId));
  }

  public async retry(taskId: string): Promise<DownloadTask> {
    return this.mutate(taskId, "retry", (backendId) => this.backend.retry(backendId));
  }

  public async remove(taskId: string): Promise<DownloadTask> {
    return this.mutate(taskId, "remove", (backendId) => this.backend.remove(backendId));
  }

  public async refresh(): Promise<DownloadUiState> {
    this.ensureOpen();
    for (const task of this.repository.listTasks()) {
      if (!task.backendId || !isActiveStatus(task.status)) continue;
      try {
        const snapshot = await this.backend.status(task.backendId);
        this.repository.upsertTask(applySnapshot(task, snapshot, this.now()));
      } catch (error) {
        const failed = applyFailure(task, error, this.now());
        this.repository.upsertTask(failed);
        this.error = { code: errorCode(error), message: safeErrorMessage(error) };
      }
    }
    return this.uiState();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    const active = this.repository.listTasks().filter((task) => isActiveStatus(task.status));
    await this.backend.shutdown();
    const now = this.now();
    for (const task of active) {
      this.repository.upsertTask({
        ...task,
        status: "paused",
        speed: 0,
        updatedAt: now,
      });
    }
    this.closed = true;
  }

  private async mutate(
    taskId: string,
    operation: "pause" | "resume" | "cancel" | "retry" | "remove",
    action: (backendId: string) => Promise<DownloadBackendSnapshot>,
  ): Promise<DownloadTask> {
    this.ensureOpen();
    const task = this.repository.getTask(taskId);
    if (!task) throw new DownloadServiceError("DOWNLOAD_TASK_NOT_FOUND", "下载任务不存在。");
    if (!task.backendId) {
      throw new DownloadServiceError("DOWNLOAD_OPERATION_INVALID", `下载任务不能执行 ${operation}。`);
    }
    try {
      const next = applySnapshot(task, await action(task.backendId), this.now());
      this.repository.upsertTask(next);
      this.error = null;
      return this.publicTask(next);
    } catch (error) {
      const failed = applyFailure(task, error, this.now());
      this.repository.upsertTask(failed);
      this.error = { code: errorCode(error), message: safeErrorMessage(error) };
      throw error;
    }
  }

  private pauseInterruptedTasks(): void {
    const now = this.now();
    for (const task of this.repository.listTasks()) {
      if (!isActiveStatus(task.status)) continue;
      this.repository.upsertTask({ ...task, status: "paused", speed: 0, updatedAt: now });
    }
  }

  private publicTask(task: DownloadTaskRecord): DownloadTask {
    return {
      id: task.id,
      sourceId: task.sourceId,
      contentId: task.contentId,
      title: task.title,
      targetDirectoryId: task.targetDirectoryId,
      suggestedFilename: task.suggestedFilename,
      requestReference: `download:${task.id}`,
      status: task.status,
      totalBytes: task.totalBytes,
      completedBytes: task.completedBytes,
      speed: task.speed,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      error: task.error,
    };
  }

  private publicTargetDirectory(
    record: DownloadTargetDirectoryRecord,
    directories: readonly (DownloadTargetDirectoryRecord & { taskCount: number })[],
  ): DownloadTargetDirectory {
    return {
      id: record.id,
      displayName: record.displayName,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      taskCount: directories.find((item) => item.id === record.id)?.taskCount ?? 0,
    };
  }

  private ensureOpen(): void {
    if (this.closed) throw new DownloadError("DOWNLOAD_BACKEND_CLOSED", "下载服务已关闭。");
  }
}

export function createDownloadBackend(environment: NodeJS.ProcessEnv = process.env): DownloadBackend {
  if (environment.QX_E2E_FAKE_ARIA2 === "1") {
    // The fake backend is intentionally opt-in and only used for contract/E2E fixtures.
    return new FakeDownloadBackend({ completeOnStatus: true });
  }
  const backend = new Aria2Backend({ env: environment });
  return backend.available ? backend : new UnavailableDownloadBackend();
}

/** Sanitizes a filename without ever returning a path. */
export function sanitizeDownloadFilename(value: string): string {
  const raw = value.trim();
  if (!raw) return "download";
  let safe = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+$/, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!safe) safe = "download";
  const extension = extname(safe);
  const base = safe.slice(0, safe.length - extension.length);
  if (isReservedWindowsName(base)) safe = `_${safe}`;
  return safe.slice(0, 180).replace(/[. ]+$/g, "") || "download";
}

export function validateDownloadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DownloadServiceError("DOWNLOAD_URL_INVALID", "下载地址不是有效 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DownloadServiceError("DOWNLOAD_URL_INVALID", "下载只允许 HTTP 或 HTTPS。");
  }
  if (url.username || url.password || hasSensitiveQuery(url.searchParams)) {
    throw new DownloadServiceError("DOWNLOAD_URL_INVALID", "下载地址包含未被允许的凭据参数。");
  }
  return url.toString();
}

function canonicalTargetDirectory(value: string): string {
  if (!value || !isAbsolute(value)) throw new DownloadServiceError("DOWNLOAD_TARGET_INVALID", "下载目录必须由系统选择器提供。");
  try {
    const stat = lstatSync(value);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DownloadServiceError("DOWNLOAD_TARGET_INVALID", "下载目录不是安全的本地目录。");
    }
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    if (error instanceof DownloadServiceError) throw error;
    throw new DownloadServiceError("DOWNLOAD_TARGET_INVALID", "下载目录不可用。");
  }
}

function uniqueFilename(
  directory: string,
  filename: string,
  tasks: readonly DownloadTaskRecord[],
  targetDirectoryId: string,
): string {
  const used = new Set<string>();
  try {
    for (const entry of readdirSync(directory)) used.add(entry.toLowerCase());
  } catch {
    throw new DownloadServiceError("DOWNLOAD_TARGET_INVALID", "下载目录不可读。");
  }
  for (const task of tasks) {
    if (task.targetDirectoryId === targetDirectoryId && task.status !== "removed") {
      used.add(task.suggestedFilename.toLowerCase());
    }
  }
  const extension = extname(filename);
  const base = filename.slice(0, filename.length - extension.length) || "download";
  let candidate = filename;
  let suffix = 1;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})${extension}`;
    suffix += 1;
  }
  return candidate;
}

function validateSuggestedFilename(value: string): string {
  const trimmed = value.trim();
  if (isUnsafeFilename(trimmed)) {
    throw new DownloadServiceError("DOWNLOAD_FILENAME_INVALID", "Filename must not contain a path");
  }
  const withoutTrailing = trimmed.replace(/[. ]+$/g, "");
  const deviceBase = withoutTrailing.split(".", 1)[0] ?? withoutTrailing;
  if (isReservedWindowsName(deviceBase)) {
    throw new DownloadServiceError("DOWNLOAD_FILENAME_INVALID", "Filename uses a reserved Windows device name");
  }
  return sanitizeDownloadFilename(trimmed);
}

function isUnsafeFilename(value: string): boolean {
  return value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || /^[A-Za-z]:/.test(value)
    || isAbsolute(value);
}

function filenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const last = basename(url.pathname);
    return last && last !== "." && last !== "/" ? last : "download";
  } catch {
    return "download";
  }
}

function normalizeTitle(value: string | undefined, fallback: string): string {
  const title = value?.trim().replace(/[\r\n]+/g, " ").slice(0, 200);
  return title || fallback;
}

function isReservedWindowsName(value: string): boolean {
  const normalized = value.trim().replace(/[. ]+$/g, "").toUpperCase();
  return normalized === "CON"
    || normalized === "PRN"
    || normalized === "AUX"
    || normalized === "NUL"
    || /^COM[1-9]$/.test(normalized)
    || /^LPT[1-9]$/.test(normalized);
}

function hasSensitiveQuery(params: URLSearchParams): boolean {
  return [...params.keys()].some((key) => /^(?:token|access_token|auth|authorization|cookie|secret|password|api[_-]?key)$/i.test(key));
}

function isHlsUrl(value: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(value);
}

function isActiveStatus(status: DownloadStatus): boolean {
  return status === "queued" || status === "starting" || status === "downloading";
}

function applySnapshot(
  task: DownloadTaskRecord,
  snapshot: DownloadBackendSnapshot,
  now: number,
): DownloadTaskRecord {
  const completedAt = snapshot.status === "completed" ? task.completedAt ?? now : null;
  return {
    ...task,
    status: snapshot.status,
    totalBytes: snapshot.totalBytes,
    completedBytes: snapshot.completedBytes,
    speed: snapshot.speed,
    startedAt: task.startedAt ?? (isActiveStatus(snapshot.status) ? now : null),
    completedAt,
    updatedAt: now,
    error: snapshot.error,
    backendId: snapshot.backendId,
  };
}

function applyFailure(task: DownloadTaskRecord, error: unknown, now: number): DownloadTaskRecord {
  return {
    ...task,
    status: "failed",
    speed: 0,
    updatedAt: now,
    error: errorCode(error),
  };
}

function errorCode(error: unknown): string {
  const candidate = error as InternalDownloadError;
  return typeof candidate?.code === "string" ? candidate.code : "DOWNLOAD_OPERATION_FAILED";
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").replace(/token:[^ ]+/gi, "token:[redacted]").slice(0, 200);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
