import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { SubtitleFormat, SubtitleTrack } from "../subtitles.js";
import type { SqliteDataLayer } from "../data/sqlite.js";
import {
  LocalMediaRepository,
  type LocalMediaItemRecord,
  type LocalMediaRootRecord,
} from "./local-media-repository.js";
import {
  EMPTY_LOCAL_MEDIA_UI_STATE,
  type LocalMediaBackend,
  type LocalMediaItem,
  type LocalMediaScanStatus,
  type LocalMediaType,
  type LocalMediaUiState,
  type LocalSubtitleTrack,
} from "./local-media-types.js";

export const LOCAL_MEDIA_MAX_DEPTH = 8;
export const LOCAL_MEDIA_MAX_FILES = 10_000;
export const LOCAL_MEDIA_MAX_DROP_FILES = 100;

const VIDEO_EXTENSIONS = new Set([
  "mp4", "mkv", "webm", "mov", "m4v", "m3u8",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "ogg", "oga", "aac", "m4a"]);
const HTML_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "mp3", "wav", "flac", "ogg", "oga", "aac", "m4a"]);
const MPV_EXTENSIONS = new Set(["mkv"]);
const SUBTITLE_FORMATS = new Map<string, SubtitleFormat>([
  ["vtt", "vtt"],
  ["webvtt", "vtt"],
  ["srt", "srt"],
  ["ass", "ass"],
  ["ssa", "ssa"],
]);
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "system volume information",
  "$recycle.bin",
]);

export interface LocalMediaServiceOptions {
  db: SqliteDataLayer;
  now?: () => number;
  mpvAvailable?: () => boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxDropFiles?: number;
}

export interface LocalMediaPlayback {
  item: LocalMediaItem;
  url: string;
  backend: LocalMediaBackend;
  subtitles: readonly SubtitleTrack[];
}

export interface LocalMediaFileStream {
  kind: "file";
  path: string;
  size: number;
  contentType: string;
}

export interface LocalMediaTextStream {
  kind: "text";
  body: string;
  contentType: string;
}

export type LocalMediaStream = LocalMediaFileStream | LocalMediaTextStream;

export class LocalMediaError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "LocalMediaError";
    this.code = code;
  }
}

interface ScanState {
  rootId: string | null;
  status: LocalMediaScanStatus;
  visitedFiles: number;
  skippedFiles: number;
}

interface CandidateFile {
  path: string;
  size: number;
  modifiedAt: number;
}

export class LocalMediaService {
  private readonly repository: LocalMediaRepository;
  private readonly now: () => number;
  private readonly mpvAvailable: () => boolean;
  private readonly maxDepth: number;
  private readonly maxFiles: number;
  private readonly maxDropFiles: number;
  private scanAbort: AbortController | null = null;
  private scanState: ScanState = { ...EMPTY_LOCAL_MEDIA_UI_STATE.scan };
  private activeItemId: string | null = null;
  private lastError: { code: string; message: string } | null = null;

  public constructor(options: LocalMediaServiceOptions) {
    this.repository = new LocalMediaRepository(options.db);
    this.now = options.now ?? Date.now;
    this.mpvAvailable = options.mpvAvailable ?? (() => false);
    this.maxDepth = clampLimit(options.maxDepth ?? LOCAL_MEDIA_MAX_DEPTH, 1, 32);
    this.maxFiles = clampLimit(options.maxFiles ?? LOCAL_MEDIA_MAX_FILES, 1, 100_000);
    this.maxDropFiles = clampLimit(options.maxDropFiles ?? LOCAL_MEDIA_MAX_DROP_FILES, 1, 500);
  }

  public uiState(baseUrl?: string): LocalMediaUiState {
    const roots = this.repository.listRoots();
    const items = this.repository.listItems();
    return {
      ready: true,
      folders: roots.map((root) => ({
        id: root.id,
        displayName: root.displayName,
        itemCount: items.filter((item) => item.rootId === root.id).length,
        createdAt: root.createdAt,
        updatedAt: root.updatedAt,
        lastScanAt: root.lastScanAt,
        scanStatus: root.id === this.scanState.rootId && this.scanState.status === "scanning"
          ? "scanning"
          : root.scanStatus,
        error: root.lastError,
      })),
      items: items.map((item) => this.publicItem(item, baseUrl)),
      activeItemId: this.activeItemId,
      scan: { ...this.scanState },
      error: this.lastError ? { ...this.lastError } : null,
      limits: {
        maxDepth: this.maxDepth,
        maxFiles: this.maxFiles,
        maxDropFiles: this.maxDropFiles,
      },
    };
  }

  public async openFiles(paths: readonly string[]): Promise<readonly LocalMediaItem[]> {
    if (paths.length === 0) return [];
    if (paths.length > this.maxDropFiles) {
      throw this.fail("LOCAL_MEDIA_FILE_LIMIT", "选择的本地媒体文件数量超过限制。");
    }
    try {
      const result: LocalMediaItem[] = [];
      for (const path of paths) {
        const item = this.registerFile(path, null);
        result.push(this.publicItem(item));
      }
      this.lastError = null;
      return result;
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  public async addFolder(path: string): Promise<LocalMediaUiState> {
    try {
      const rootPath = this.authorizeDirectory(path);
      const existing = this.repository.findRootByPath(rootPath);
      const timestamp = this.now();
      const root: LocalMediaRootRecord = existing ?? {
        id: randomUUID(),
        rootPath,
        displayName: basename(rootPath) || rootPath,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastScanAt: null,
        scanStatus: "idle",
        lastError: null,
      };
      this.repository.upsertRoot(root);
      await this.rescan(root.id);
      this.lastError = null;
      return this.uiState();
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  public async removeFolder(rootId: string): Promise<LocalMediaUiState> {
    this.cancelScan(rootId);
    this.repository.deleteRoot(rootId);
    this.lastError = null;
    return this.uiState();
  }

  public removeItem(itemId: string): LocalMediaUiState {
    this.repository.deleteItem(itemId);
    if (this.activeItemId === itemId) this.activeItemId = null;
    this.lastError = null;
    return this.uiState();
  }

  public async locateItem(itemId: string, path: string): Promise<LocalMediaUiState> {
    const item = this.repository.getItem(itemId);
    if (!item) throw this.fail("LOCAL_MEDIA_ITEM_NOT_FOUND", "本地媒体项不存在。");
    try {
      const candidate = this.inspectFile(path);
      const root = item.rootId ? this.repository.getRoot(item.rootId) : null;
      const rootId = root && isWithin(root.rootPath, candidate.path) ? root.id : null;
      const updated = this.recordFromCandidate(candidate, rootId, item.id, item.createdAt);
      this.repository.upsertItem(updated);
      this.lastError = null;
      return this.uiState();
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  public async importDrop(paths: readonly string[]): Promise<LocalMediaUiState> {
    if (paths.length === 0 || paths.length > this.maxDropFiles) {
      throw this.fail("LOCAL_MEDIA_DROP_INVALID", "拖放的文件数量无效。");
    }
    try {
      for (const path of paths) {
        const stats = lstatSafe(path);
        if (stats?.isDirectory()) await this.addFolder(path);
        else this.registerFile(path, null);
      }
      this.lastError = null;
      return this.uiState();
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  public async rescan(rootId?: string): Promise<LocalMediaUiState> {
    const roots = rootId ? [this.repository.getRoot(rootId)] : [...this.repository.listRoots()];
    const selected = roots.filter((root): root is LocalMediaRootRecord => root !== null);
    if (selected.length === 0) {
      if (rootId) throw this.fail("LOCAL_MEDIA_ROOT_NOT_FOUND", "本地媒体目录不存在。");
      return this.uiState();
    }
    for (const root of selected) await this.scanRoot(root);
    return this.uiState();
  }

  public cancelScan(rootId?: string): LocalMediaUiState {
    if (!this.scanAbort || (rootId && this.scanState.rootId !== rootId)) return this.uiState();
    this.scanAbort.abort();
    return this.uiState();
  }

  public setActiveItem(itemId: string | null): void {
    if (itemId !== null && !this.repository.getItem(itemId)) {
      throw this.fail("LOCAL_MEDIA_ITEM_NOT_FOUND", "本地媒体项不存在。");
    }
    this.activeItemId = itemId;
  }

  public preparePlayback(itemId: string, baseUrl: string): LocalMediaPlayback {
    const item = this.repository.getItem(itemId);
    if (!item) throw this.fail("LOCAL_MEDIA_ITEM_NOT_FOUND", "本地媒体项不存在。");
    const path = this.resolveItemPath(item);
    const extension = item.extension.toLowerCase();
    const backend = this.backendFor(extension);
    const root = ensureTrailingSlash(baseUrl);
    const subtitles: SubtitleTrack[] = item.subtitleTracks.map((track, index) => ({
      id: track.id,
      label: track.label,
      language: track.language,
      format: track.format,
      url: `${root}api/local-media/subtitle/${encodeURIComponent(item.id)}/${encodeURIComponent(track.id)}`,
      default: index === 0,
      forced: false,
      source: "local",
    }));
    this.activeItemId = item.id;
    this.lastError = null;
    return {
      item: this.publicItem(item, baseUrl),
      url: `${root}api/local-media/stream/${encodeURIComponent(item.id)}`,
      backend,
      subtitles,
    };
  }

  public resolveMediaStream(itemId: string, range?: { start: number; end: number | null }): LocalMediaStream {
    const item = this.repository.getItem(itemId);
    if (!item) throw this.fail("LOCAL_MEDIA_ITEM_NOT_FOUND", "本地媒体项不存在。");
    const path = this.resolveItemPath(item);
    if (item.extension === "m3u8") {
      const content = readFileText(path);
      return { kind: "text", body: this.rewritePlaylist(item, content), contentType: "application/vnd.apple.mpegurl; charset=utf-8" };
    }
    const stats = statSync(path);
    const start = range?.start ?? 0;
    const end = range?.end === null || range?.end === undefined
      ? stats.size - 1
      : Math.min(range.end, stats.size - 1);
    if (start < 0 || start > end || start >= stats.size) {
      throw this.fail("LOCAL_MEDIA_RANGE_INVALID", "本地媒体 Range 无效。");
    }
    return { kind: "file", path, size: stats.size, contentType: mediaContentType(item.extension) };
  }

  public resolvePlaylistResource(itemId: string, token: string): LocalMediaFileStream {
    const item = this.requireItem(itemId);
    const path = this.resolveItemPath(item);
    if (item.extension !== "m3u8") throw this.fail("LOCAL_MEDIA_PLAYLIST_INVALID", "当前媒体不是本地 HLS 播放列表。");
    let relativePath: string;
    try {
      relativePath = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      throw this.fail("LOCAL_MEDIA_PLAYLIST_PATH_UNAUTHORIZED", "本地播放列表资源引用无效。");
    }
    const resourcePath = this.authorizePlaylistPath(path, relativePath);
    const stats = statSync(resourcePath);
    if (!stats.isFile()) throw this.fail("LOCAL_MEDIA_NOT_FOUND", "本地媒体资源不存在。");
    return { kind: "file", path: resourcePath, size: stats.size, contentType: mediaContentType(extname(resourcePath).slice(1)) };
  }

  public resolveSubtitle(itemId: string, trackId: string): LocalMediaFileStream {
    const item = this.requireItem(itemId);
    const track = item.subtitleTracks.find((candidate) => candidate.id === trackId);
    if (!track) throw this.fail("LOCAL_MEDIA_SUBTITLE_NOT_FOUND", "本地字幕不存在。");
    const mediaPath = this.resolveItemPath(item);
    const path = this.authorizeSiblingPath(mediaPath, track.fileReference);
    const stats = statSync(path);
    return { kind: "file", path, size: stats.size, contentType: subtitleContentType(track.format) };
  }

  public validatePlaylist(itemId: string): string {
    const item = this.requireItem(itemId);
    if (item.extension !== "m3u8") throw this.fail("LOCAL_MEDIA_PLAYLIST_INVALID", "当前媒体不是本地 HLS 播放列表。");
    return this.rewritePlaylist(item, readFileText(this.resolveItemPath(item)));
  }

  private async scanRoot(root: LocalMediaRootRecord): Promise<void> {
    if (this.scanAbort) this.scanAbort.abort();
    const abort = new AbortController();
    this.scanAbort = abort;
    this.scanState = { rootId: root.id, status: "scanning", visitedFiles: 0, skippedFiles: 0 };
    const timestamp = this.now();
    this.repository.upsertRoot({ ...root, updatedAt: timestamp, scanStatus: "scanning", lastError: null });
    const existing = new Map(this.repository.listItems(root.id).map((item) => [item.fileReference, item]));
    const present: string[] = [];
    try {
      const candidates: CandidateFile[] = [];
      await this.collectFiles(root.rootPath, root.rootPath, 0, abort.signal, candidates);
      for (const candidate of candidates) {
        if (abort.signal.aborted) throw this.fail("LOCAL_MEDIA_SCAN_CANCELLED", "本地媒体扫描已取消。");
        const previous = existing.get(candidate.path) ?? this.repository.getItemByFileReference(candidate.path);
        const item = this.recordFromCandidate(
          candidate,
          root.id,
          previous?.id ?? randomUUID(),
          previous?.createdAt ?? timestamp,
          previous ?? undefined,
        );
        present.push(candidate.path);
        this.repository.upsertItem(item);
      }
      this.repository.markMissingForRoot(root.id, present);
      this.repository.upsertRoot({
        ...root,
        updatedAt: this.now(),
        lastScanAt: this.now(),
        scanStatus: "idle",
        lastError: null,
      });
      this.scanState = { rootId: null, status: "idle", visitedFiles: candidates.length, skippedFiles: this.scanState.skippedFiles };
      this.lastError = null;
    } catch (error) {
      const cancelled = error instanceof LocalMediaError && error.code === "LOCAL_MEDIA_SCAN_CANCELLED";
      this.repository.upsertRoot({
        ...root,
        updatedAt: this.now(),
        scanStatus: cancelled ? "cancelled" : "error",
        lastError: cancelled ? null : safeErrorCode(error),
      });
      this.scanState = {
        rootId: cancelled ? null : root.id,
        status: cancelled ? "cancelled" : "error",
        visitedFiles: this.scanState.visitedFiles,
        skippedFiles: this.scanState.skippedFiles,
      };
      this.rememberError(error);
      throw error;
    } finally {
      if (this.scanAbort === abort) this.scanAbort = null;
    }
  }

  private async collectFiles(
    rootPath: string,
    currentPath: string,
    depth: number,
    signal: AbortSignal,
    output: CandidateFile[],
  ): Promise<void> {
    if (signal.aborted) throw this.fail("LOCAL_MEDIA_SCAN_CANCELLED", "本地媒体扫描已取消。");
    if (depth > this.maxDepth) {
      this.scanState.skippedFiles += 1;
      return;
    }
    if (!isWithin(rootPath, currentPath)) {
      this.scanState.skippedFiles += 1;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      this.scanState.skippedFiles += 1;
      return;
    }
    for (const entry of entries) {
      if (signal.aborted) throw this.fail("LOCAL_MEDIA_SCAN_CANCELLED", "本地媒体扫描已取消。");
      if (isHiddenOrSystemName(entry.name)) {
        this.scanState.skippedFiles += 1;
        continue;
      }
      const candidatePath = join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        this.scanState.skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        const canonicalDirectory = realpathSafe(candidatePath);
        if (!canonicalDirectory || !isWithin(rootPath, canonicalDirectory)) {
          this.scanState.skippedFiles += 1;
          continue;
        }
        await this.collectFiles(rootPath, canonicalDirectory, depth + 1, signal, output);
        continue;
      }
      if (!entry.isFile() || !isAllowedMediaPath(candidatePath)) {
        this.scanState.skippedFiles += 1;
        continue;
      }
      let realPath: string;
      try {
        realPath = realpathSync(candidatePath);
        if (!isWithin(rootPath, realPath)) {
          this.scanState.skippedFiles += 1;
          continue;
        }
        const stats = statSync(realPath);
        if (!stats.isFile()) {
          this.scanState.skippedFiles += 1;
          continue;
        }
        if (output.length >= this.maxFiles) throw this.fail("LOCAL_MEDIA_FILE_LIMIT", "本地媒体文件数量超过限制。");
        output.push({ path: realPath, size: stats.size, modifiedAt: Math.round(stats.mtimeMs) });
        this.scanState.visitedFiles = output.length;
      } catch (error) {
        if (error instanceof LocalMediaError) throw error;
        this.scanState.skippedFiles += 1;
      }
      if (output.length % 100 === 0) await yieldToEventLoop();
    }
  }

  private registerFile(path: string, rootId: string | null): LocalMediaItemRecord {
    const candidate = this.inspectFile(path);
    if (rootId) {
      const root = this.repository.getRoot(rootId);
      if (!root || !isWithin(root.rootPath, candidate.path)) {
        throw this.fail("LOCAL_MEDIA_PATH_UNAUTHORIZED", "本地媒体文件不在已授权目录内。");
      }
    }
    const existing = this.repository.getItemByFileReference(candidate.path);
    const item = this.recordFromCandidate(candidate, rootId, existing?.id ?? randomUUID(), existing?.createdAt ?? this.now(), existing ?? undefined);
    this.repository.upsertItem(item);
    return item;
  }

  private recordFromCandidate(
    candidate: CandidateFile,
    rootId: string | null,
    id: string,
    createdAt: number,
    previous?: LocalMediaItemRecord,
  ): LocalMediaItemRecord {
    const extension = extensionFromPath(candidate.path);
    const mediaType = mediaTypeForExtension(extension);
    const subtitles = discoverSubtitles(candidate.path);
    const subtitleJson = JSON.stringify(subtitles);
    if (previous
      && previous.size === candidate.size
      && previous.modifiedAt === candidate.modifiedAt
      && JSON.stringify(previous.subtitleTracks) === subtitleJson
      && previous.rootId === rootId) {
      return previous.missing ? { ...previous, missing: false } : previous;
    }
    return {
      id,
      rootId,
      fileReference: candidate.path,
      displayName: basename(candidate.path),
      extension,
      size: candidate.size,
      modifiedAt: candidate.modifiedAt,
      mediaType,
      duration: null,
      width: null,
      height: null,
      poster: null,
      subtitleTracks: subtitles,
      createdAt,
      updatedAt: this.now(),
      missing: false,
    };
  }

  private inspectFile(path: string): CandidateFile {
    const absolute = resolve(path);
    let stats;
    try {
      const linkStats = lstatSync(absolute);
      if (linkStats.isSymbolicLink() || !linkStats.isFile()) throw this.fail("LOCAL_MEDIA_PATH_UNAUTHORIZED", "本地媒体文件不是受支持的普通文件。");
      const canonical = realpathSync(absolute);
      stats = statSync(canonical);
      if (!stats.isFile()) throw this.fail("LOCAL_MEDIA_PATH_UNAUTHORIZED", "本地媒体文件不是受支持的普通文件。");
      if (!isAllowedMediaPath(canonical)) throw this.fail("LOCAL_MEDIA_EXTENSION_UNSUPPORTED", "本地媒体扩展名不受支持。");
      return { path: canonical, size: stats.size, modifiedAt: Math.round(stats.mtimeMs) };
    } catch (error) {
      if (error instanceof LocalMediaError) throw error;
      throw this.fail("LOCAL_MEDIA_NOT_FOUND", "本地媒体文件不存在或无法读取。");
    }
  }

  private authorizeDirectory(path: string): string {
    const absolute = resolve(path);
    try {
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw this.fail("LOCAL_MEDIA_ROOT_INVALID", "本地媒体目录必须是普通目录。");
      const canonical = realpathSync(absolute);
      if (lstatSync(canonical).isSymbolicLink()) throw this.fail("LOCAL_MEDIA_ROOT_INVALID", "本地媒体目录不能是链接目录。");
      return canonical;
    } catch (error) {
      if (error instanceof LocalMediaError) throw error;
      throw this.fail("LOCAL_MEDIA_ROOT_INVALID", "本地媒体目录不存在或无法读取。");
    }
  }

  private resolveItemPath(item: LocalMediaItemRecord): string {
    try {
      const linkStats = lstatSync(item.fileReference);
      if (linkStats.isSymbolicLink() || !linkStats.isFile()) throw new Error("not-file");
      const canonical = realpathSync(item.fileReference);
      if (item.rootId) {
        const root = this.repository.getRoot(item.rootId);
        if (!root || !isWithin(root.rootPath, canonical)) throw new Error("outside-root");
      }
      const stats = statSync(canonical);
      if (!stats.isFile()) throw new Error("not-file");
      return canonical;
    } catch {
      if (!item.missing) {
        this.repository.upsertItem({ ...item, missing: true, updatedAt: this.now() });
      }
      throw this.fail("LOCAL_MEDIA_NOT_FOUND", "本地媒体文件已不存在，请定位文件或从媒体库移除。");
    }
  }

  private requireItem(itemId: string): LocalMediaItemRecord {
    const item = this.repository.getItem(itemId);
    if (!item) throw this.fail("LOCAL_MEDIA_ITEM_NOT_FOUND", "本地媒体项不存在。");
    return item;
  }

  private backendFor(extension: string): LocalMediaBackend {
    if (extension === "m3u8") return "hls-js";
    if (HTML_EXTENSIONS.has(extension)) return "html-video";
    if (MPV_EXTENSIONS.has(extension)) {
      if (!this.mpvAvailable()) throw this.fail("MPV_UNAVAILABLE", "当前文件需要 MPV，但本地 MPV 不可用。");
      return "mpv";
    }
    throw this.fail("LOCAL_MEDIA_CODEC_UNSUPPORTED", "当前文件格式需要可用的播放器后端。");
  }

  private rewritePlaylist(item: LocalMediaItemRecord, content: string): string {
    const playlistPath = this.resolveItemPath(item);
    const rewriteUri = (value: string): string => {
      const resourcePath = this.authorizePlaylistPath(playlistPath, value);
      const token = Buffer.from(relative(dirname(playlistPath), resourcePath), "utf8").toString("base64url");
      return `/api/local-media/resource/${encodeURIComponent(item.id)}/${token}`;
    };
    return content.replace(/URI=(['"])([^'"]+)\1/gi, (_match, quote: string, value: string) => `URI=${quote}${rewriteUri(value)}${quote}`)
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        return rewriteUri(trimmed);
      })
      .join("\n");
  }

  private authorizePlaylistPath(playlistPath: string, reference: string): string {
    const value = reference.trim();
    if (!value || isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\") || /^[a-z]:[\\/]/i.test(value)) {
      throw this.fail("LOCAL_MEDIA_PLAYLIST_PATH_UNAUTHORIZED", "本地播放列表只能引用授权目录内的相对资源。");
    }
    const candidate = resolve(dirname(playlistPath), value.replace(/[\\/]+/g, sep));
    const item = this.repository.getItemByFileReference(playlistPath);
    const root = item?.rootId ? this.repository.getRoot(item.rootId) : null;
    const scope = root?.rootPath ?? dirname(playlistPath);
    if (!isWithin(scope, candidate)) throw this.fail("LOCAL_MEDIA_PLAYLIST_PATH_UNAUTHORIZED", "本地播放列表资源越过了授权范围。");
    try {
      const linkStats = lstatSync(candidate);
      if (linkStats.isSymbolicLink() || !linkStats.isFile()) throw new Error("not-file");
      const canonical = realpathSync(candidate);
      if (!isWithin(scope, canonical)) throw new Error("outside-scope");
      return canonical;
    } catch {
      throw this.fail("LOCAL_MEDIA_NOT_FOUND", "本地播放列表资源不存在。");
    }
  }

  private authorizeSiblingPath(mediaPath: string, filePath: string): string {
    const candidate = resolve(filePath);
    if (!isWithin(dirname(mediaPath), candidate)) throw this.fail("LOCAL_MEDIA_PATH_UNAUTHORIZED", "本地字幕不在媒体文件的同一目录内。");
    const linkStats = lstatSafe(candidate);
    if (!linkStats || linkStats.isSymbolicLink() || !linkStats.isFile()) throw this.fail("LOCAL_MEDIA_SUBTITLE_NOT_FOUND", "本地字幕不存在。");
    const canonical = realpathSync(candidate);
    if (!isWithin(dirname(mediaPath), canonical)) throw this.fail("LOCAL_MEDIA_PATH_UNAUTHORIZED", "本地字幕路径越过了授权范围。");
    return canonical;
  }

  private publicItem(item: LocalMediaItemRecord, baseUrl?: string): LocalMediaItem {
    return {
      id: item.id,
      pathIdentity: `local-file:${item.id}`,
      fileReference: `local-file:${item.id}`,
      displayName: item.displayName,
      extension: item.extension,
      size: item.size,
      modifiedAt: item.modifiedAt,
      mediaType: item.mediaType,
      ...(item.duration === null ? {} : { duration: item.duration }),
      ...(item.width === null ? {} : { width: item.width }),
      ...(item.height === null ? {} : { height: item.height }),
      ...(item.poster === null ? {} : { poster: item.poster }),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      missing: item.missing,
      rootId: item.rootId,
      subtitleTracks: item.subtitleTracks.map(({ fileReference: _fileReference, ...track }) => ({
        ...track,
      ...(baseUrl ? { url: `${ensureTrailingSlash(baseUrl)}api/local-media/subtitle/${encodeURIComponent(item.id)}/${encodeURIComponent(track.id)}` } : {}),
      })),
    };
  }

  private fail(code: string, message: string): LocalMediaError {
    return new LocalMediaError(code, message);
  }

  private rememberError(error: unknown): void {
    this.lastError = {
      code: safeErrorCode(error),
      message: error instanceof LocalMediaError ? error.message : "本地媒体操作失败。",
    };
  }
}

function extensionFromPath(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

function isAllowedMediaPath(path: string): boolean {
  const extension = extensionFromPath(path);
  return VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension);
}

function mediaTypeForExtension(extension: string): LocalMediaType {
  return AUDIO_EXTENSIONS.has(extension) ? "audio" : "video";
}

function mediaContentType(extension: string): string {
  switch (extension.toLowerCase()) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mov": return "video/quicktime";
    case "m4v": return "video/x-m4v";
    case "m3u8": return "application/vnd.apple.mpegurl; charset=utf-8";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "flac": return "audio/flac";
    case "ogg":
    case "oga": return "audio/ogg";
    case "aac": return "audio/aac";
    case "m4a": return "audio/mp4";
    default: return "application/octet-stream";
  }
}

function subtitleContentType(format: SubtitleFormat): string {
  return format === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8";
}

function discoverSubtitles(mediaPath: string): LocalSubtitleTrack[] {
  const directory = dirname(mediaPath);
  const stem = basename(mediaPath, extname(mediaPath)).toLowerCase();
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const extension = extensionFromPath(entry.name);
      const format = SUBTITLE_FORMATS.get(extension);
      if (!format) return null;
      const candidateStem = basename(entry.name, extname(entry.name)).toLowerCase();
      if (candidateStem !== stem && !candidateStem.startsWith(`${stem}.`)) return null;
      const suffix = candidateStem === stem ? "und" : candidateStem.slice(stem.length + 1).split(".")[0] || "und";
      const path = realpathSafe(join(directory, entry.name));
      if (!path || path === mediaPath) return null;
      return {
        id: `subtitle:${sha256(path).slice(0, 24)}`,
        label: basename(entry.name),
        language: suffix.slice(0, 32),
        format,
        fileReference: path,
      } satisfies LocalSubtitleTrack;
    })
    .filter((track): track is LocalSubtitleTrack => track !== null)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function isHiddenOrSystemName(name: string): boolean {
  const normalized = name.toLowerCase();
  return name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(normalized);
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = canonicalForComparison(root);
  const normalizedCandidate = canonicalForComparison(candidate);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function canonicalForComparison(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realpathSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new LocalMediaError("LOCAL_MEDIA_NOT_FOUND", "本地媒体文件不存在或无法读取。");
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function clampLimit(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(Number.isFinite(value) ? value : minimum)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeErrorCode(error: unknown): string {
  return error instanceof LocalMediaError ? error.code : "LOCAL_MEDIA_OPERATION_FAILED";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}
