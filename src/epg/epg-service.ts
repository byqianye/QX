import { gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { redactSensitiveText } from "../data/safe-persistence.js";
import { EpgRepository } from "../data/repositories.js";
import { normalizeChannelName } from "../live/live-parser.js";
import { parseXmltv, EpgParserError } from "./epg-parser.js";
import {
  DEFAULT_EPG_RETENTION,
  type EpgChannelRecord,
  type EpgImportPreview,
  type EpgImportStats,
  type EpgProgrammeRecord,
  type EpgRetentionSettings,
  type EpgSourceImportInput,
  type EpgSourceRecord,
  type EpgSourceUiState,
  type EpgUiError,
  type EpgUiState,
  type EpgPreviewUiState,
} from "./epg-types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMPRESSED_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CHANNELS = 10_000;
const DEFAULT_MAX_PROGRAMMES = 100_000;
const DEFAULT_MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class EpgSourceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EpgSourceError";
    this.code = code;
  }
}

export interface EpgServiceOptions {
  repository: EpgRepository;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string | Uint8Array;
  now?: () => number;
  requestTimeoutMs?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxChannels?: number;
  maxProgrammes?: number;
  maxTextBytes?: number;
  retention?: Partial<EpgRetentionSettings>;
}

interface LoadedEpgContent {
  content: string | null;
  location: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

interface PendingEpgPreview {
  preview: EpgImportPreview;
  input: EpgSourceImportInput;
  content: string | null;
}

export class EpgService {
  private readonly repository: EpgRepository;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (path: string) => string | Uint8Array;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxCompressedBytes: number;
  private readonly maxDecompressedBytes: number;
  private readonly maxChannels: number;
  private readonly maxProgrammes: number;
  private readonly maxTextBytes: number;
  private readonly retention: EpgRetentionSettings;
  private readonly pending = new Map<string, PendingEpgPreview>();
  private readonly fileContents = new Map<string, string>();
  private readonly loadedContents = new Map<string, string | null>();
  private previewValue: EpgImportPreview | null = null;
  private loadingValue = false;
  private errorValue: EpgUiError | null = null;

  public constructor(options: EpgServiceOptions) {
    this.repository = options.repository;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readFile = options.readFile ?? ((path) => readFileSync(path));
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxCompressedBytes = positiveInteger(options.maxCompressedBytes, DEFAULT_MAX_COMPRESSED_BYTES);
    this.maxDecompressedBytes = positiveInteger(options.maxDecompressedBytes, DEFAULT_MAX_DECOMPRESSED_BYTES);
    this.maxChannels = positiveInteger(options.maxChannels, DEFAULT_MAX_CHANNELS);
    this.maxProgrammes = positiveInteger(options.maxProgrammes, DEFAULT_MAX_PROGRAMMES);
    this.maxTextBytes = positiveInteger(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES);
    this.retention = {
      pastRetentionMs: positiveInteger(options.retention?.pastRetentionMs, DEFAULT_EPG_RETENTION.pastRetentionMs),
      futureRetentionMs: positiveInteger(options.retention?.futureRetentionMs, DEFAULT_EPG_RETENTION.futureRetentionMs),
    };
  }

  public uiState(): EpgUiState {
    return {
      sources: this.repository.listSources().map((source) => this.sourceUiState(source)),
      preview: this.previewValue ? previewUiState(this.previewValue) : null,
      loading: this.loadingValue,
      error: this.errorValue ? { ...this.errorValue } : null,
      retention: { ...this.retention },
      mappings: [],
      timeline: null,
    };
  }

  public async previewSource(input: EpgSourceImportInput): Promise<EpgImportPreview> {
    this.loadingValue = true;
    this.errorValue = null;
    try {
      const preview = await this.buildPreview(input);
      const content = this.loadedContents.get(preview.id) ?? null;
      this.loadedContents.delete(preview.id);
      this.pending.clear();
      this.pending.set(preview.id, { preview, input, content });
      this.previewValue = preview;
      return preview;
    } catch (error) {
      const mapped = mapEpgError(error);
      this.errorValue = { code: mapped.code, message: mapped.message };
      this.previewValue = null;
      this.pending.clear();
      this.loadedContents.clear();
      throw mapped;
    } finally {
      this.loadingValue = false;
    }
  }

  public async applyPreview(previewId: string): Promise<EpgSourceRecord> {
    this.loadingValue = true;
    this.errorValue = null;
    try {
      const pending = this.pending.get(previewId);
      if (!pending) throw new EpgSourceError("EPG_PREVIEW_NOT_FOUND", "EPG 预览已过期，请重新导入。");
      const sourceId = pending.preview.source.id.startsWith("pending:")
        ? `epg-${randomUUID()}`
        : pending.preview.source.id;
      const source: EpgSourceRecord = {
        ...pending.preview.source,
        id: sourceId,
        lastUpdatedAt: this.now(),
        lastSuccessAt: this.now(),
        lastError: null,
      };
      const materialized = rematerializePreview(pending.preview, sourceId);
      this.repository.saveSourceContent(source, materialized.channels, materialized.programmes);
      this.repository.pruneProgrammes(this.now(), this.retention);
      if (pending.content !== null && (source.type === "xmltv-file" || source.type === "fixture")) {
        this.fileContents.set(source.id, pending.content);
      }
      this.pending.delete(previewId);
      this.previewValue = null;
      return source;
    } catch (error) {
      const mapped = mapEpgError(error);
      this.errorValue = { code: mapped.code, message: mapped.message };
      throw mapped;
    } finally {
      this.loadingValue = false;
    }
  }

  public async refreshSource(sourceId: string): Promise<EpgSourceRecord> {
    const source = this.repository.getSource(sourceId);
    if (!source) throw new EpgSourceError("EPG_SOURCE_NOT_FOUND", "EPG 来源不存在。");
    if (!source.enabled) throw new EpgSourceError("EPG_SOURCE_DISABLED", "EPG 来源已停用，请先启用后刷新。");
    try {
      const preview = await this.previewSource(this.inputForExistingSource(source));
      const pending = this.pending.get(preview.id);
      if (pending?.preview.source.contentHash === source.contentHash) {
        const updated: EpgSourceRecord = {
          ...source,
          lastUpdatedAt: this.now(),
          lastSuccessAt: this.now(),
          lastError: null,
          etag: preview.etag ?? source.etag,
          lastModified: preview.lastModified ?? source.lastModified,
        };
        this.repository.upsertSource(updated);
        this.repository.pruneProgrammes(this.now(), this.retention);
        this.pending.delete(preview.id);
        this.previewValue = null;
        return updated;
      }
      return await this.applyPreview(preview.id);
    } catch (error) {
      const mapped = mapEpgError(error);
      const current = this.repository.getSource(sourceId);
      if (current) {
        this.repository.upsertSource({
          ...current,
          lastUpdatedAt: this.now(),
          lastError: redactSensitiveText(mapped.message).slice(0, 240),
        });
      }
      this.errorValue = { code: mapped.code, message: mapped.message };
      throw mapped;
    }
  }

  public setSourceEnabled(sourceId: string, enabled: boolean): EpgSourceRecord {
    const source = this.repository.getSource(sourceId);
    if (!source) throw new EpgSourceError("EPG_SOURCE_NOT_FOUND", "EPG 来源不存在。");
    const updated = { ...source, enabled };
    this.repository.upsertSource(updated);
    this.errorValue = null;
    return updated;
  }

  public removeSource(sourceId: string): void {
    if (!this.repository.getSource(sourceId)) throw new EpgSourceError("EPG_SOURCE_NOT_FOUND", "EPG 来源不存在。");
    this.repository.deleteSource(sourceId);
    this.fileContents.delete(sourceId);
    for (const [id, pending] of this.pending) {
      if (pending.preview.source.id === sourceId) this.pending.delete(id);
    }
    if (this.previewValue?.source.id === sourceId) this.previewValue = null;
    this.errorValue = null;
  }

  public clearPreview(): void {
    this.previewValue = null;
    this.pending.clear();
    this.loadedContents.clear();
    this.errorValue = null;
  }

  public getProgrammes(channelId: string, fromAt?: number, toAt?: number): readonly EpgProgrammeRecord[] {
    return this.repository.listProgrammes(channelId, fromAt, toAt);
  }

  public currentNext(channelId: string, at = this.now()): { current: EpgProgrammeRecord | null; next: EpgProgrammeRecord | null } {
    return {
      current: this.repository.currentProgramme(channelId, at),
      next: this.repository.nextProgramme(channelId, at),
    };
  }

  public close(): void {
    this.clearPreview();
    this.fileContents.clear();
  }

  private async buildPreview(input: EpgSourceImportInput): Promise<EpgImportPreview> {
    const name = normalizeSourceName(input.name);
    const previewId = `preview-${randomUUID()}`;
    const existing = input.sourceId ? this.repository.getSource(input.sourceId) : null;
    if (input.sourceId && !existing) throw new EpgSourceError("EPG_SOURCE_NOT_FOUND", "EPG 来源不存在。");
    const loaded = await this.loadInput(input, existing);
    this.loadedContents.set(previewId, loaded.content);
    const sourceId = existing?.id ?? `pending:${previewId}`;
    const source: EpgSourceRecord = {
      id: sourceId,
      name: existing?.name ?? name,
      type: existing?.type ?? input.type,
      location: existing?.location ?? loaded.location,
      enabled: existing?.enabled ?? true,
      lastUpdatedAt: existing?.lastUpdatedAt ?? null,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastError: existing?.lastError ?? null,
      etag: existing?.etag ?? null,
      lastModified: existing?.lastModified ?? null,
      contentHash: existing?.contentHash ?? null,
    };

    if (loaded.notModified) {
      const channels = existing ? this.repository.getChannels(existing.id) : [];
      const programmes = existing ? this.repository.getProgrammes(existing.id) : [];
      if (!existing || channels.length === 0) {
        throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 返回未修改，但没有可用的历史版本。");
      }
      const stats = { channelCount: channels.length, programmeCount: programmes.length, invalidCount: 0 };
      return {
        id: previewId,
        source: { ...source, contentHash: existing.contentHash, etag: loaded.etag ?? existing.etag, lastModified: loaded.lastModified ?? existing.lastModified },
        channels,
        programmes,
        issues: [],
        stats,
        contentHash: existing.contentHash ?? "",
        etag: loaded.etag ?? existing.etag,
        lastModified: loaded.lastModified ?? existing.lastModified,
      };
    }
    if (loaded.content === null) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 没有返回内容。");
    const parsed = parseXmltv(loaded.content, {
      maxChannels: this.maxChannels,
      maxProgrammes: this.maxProgrammes,
      maxTextBytes: this.maxTextBytes,
    });
    const materialized = materializeParsed(sourceId, parsed.channels, parsed.programmes);
    const contentHash = sha256(loaded.content);
    const stats: EpgImportStats = {
      channelCount: materialized.channels.length,
      programmeCount: materialized.programmes.length,
      invalidCount: parsed.issues.length,
    };
    return {
      id: previewId,
      source: {
        ...source,
        location: existing?.location ?? loaded.location,
        contentHash,
        etag: loaded.etag ?? existing?.etag ?? null,
        lastModified: loaded.lastModified ?? existing?.lastModified ?? null,
      },
      channels: materialized.channels,
      programmes: materialized.programmes,
      issues: parsed.issues,
      stats,
      contentHash,
      etag: loaded.etag,
      lastModified: loaded.lastModified,
    };
  }

  private async loadInput(input: EpgSourceImportInput, existing: EpgSourceRecord | null): Promise<LoadedEpgContent> {
    if (input.type === "xmltv-url") {
      const location = normalizeRemoteLocation(existing?.location ?? input.location);
      return this.loadRemote(location, existing);
    }
    if (input.type === "fixture") {
      const content = decodeXmlBytes(Buffer.from(input.content, "utf8"), this.maxDecompressedBytes);
      return { content, location: existing?.location ?? input.location ?? `fixture:${sha256(content).slice(0, 16)}`, etag: null, lastModified: null, notModified: false };
    }
    if (input.content !== undefined) {
      const content = decodeXmlBytes(Buffer.from(input.content, "utf8"), this.maxDecompressedBytes);
      return { content, location: existing?.location ?? `file:${safeFileName(input.fileName)}`, etag: null, lastModified: null, notModified: false };
    }
    const filePath = input.filePath ?? input.location;
    if (!filePath) throw new EpgSourceError("EPG_SOURCE_FAILED", "本地 EPG 文件不可用。");
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      if (stat.size > this.maxCompressedBytes) throw new EpgSourceError("EPG_TOO_LARGE", "EPG 文件超过大小限制。");
      const content = decodeXmlBytes(toBuffer(this.readFile(filePath)), this.maxDecompressedBytes);
      return { content, location: existing?.location ?? `file:${safeFileName(input.fileName || basename(filePath))}`, etag: null, lastModified: null, notModified: false };
    } catch (error) {
      if (error instanceof EpgSourceError) throw error;
      throw new EpgSourceError("EPG_SOURCE_FAILED", "本地 EPG 文件读取失败。", { cause: error });
    }
  }

  private async loadRemote(location: string, existing: EpgSourceRecord | null): Promise<LoadedEpgContent> {
    const initial = parseRemoteUrl(location);
    const origin = initial.origin;
    let current = initial;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const headers: Record<string, string> = {};
      if (existing?.etag) headers["if-none-match"] = existing.etag;
      if (existing?.lastModified) headers["if-modified-since"] = existing.lastModified;
      try {
        const response = await this.fetchImpl(current.toString(), { headers, redirect: "manual", signal: controller.signal });
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
          const locationHeader = response.headers.get("location");
          if (!locationHeader) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 重定向缺少目标地址。");
          const next = new URL(locationHeader, current);
          validateRemoteUrl(next);
          if (next.origin !== origin) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 重定向跨越了原始来源。");
          current = next;
          continue;
        }
        if (response.status === 304) {
          return { content: null, location: initial.toString(), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), notModified: true };
        }
        if (!response.ok) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 返回了不可用的响应。");
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > this.maxCompressedBytes) throw new EpgSourceError("EPG_TOO_LARGE", "EPG 响应超过压缩大小限制。");
        validateContentType(response.headers.get("content-type"), current);
        const bytes = await readResponseBytes(response, this.maxCompressedBytes, controller.signal);
        const content = decodeXmlBytes(bytes, this.maxDecompressedBytes, response.headers.get("content-encoding"));
        return { content, location: initial.toString(), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), notModified: false };
      } catch (error) {
        if (controller.signal.aborted) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 请求超时。", { cause: error });
        if (error instanceof EpgSourceError) throw error;
        throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 请求失败。", { cause: error });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 重定向次数超过限制。");
  }

  private inputForExistingSource(source: EpgSourceRecord): EpgSourceImportInput {
    if (source.type === "xmltv-url") return { name: source.name, type: source.type, location: source.location, sourceId: source.id };
    const content = this.fileContents.get(source.id);
    if (!content) throw new EpgSourceError("EPG_SOURCE_FAILED", "本地 EPG 文件需要重新选择。");
    return source.type === "fixture"
      ? { name: source.name, type: source.type, content, location: source.location, sourceId: source.id }
      : { name: source.name, type: source.type, fileName: source.location.replace(/^file:/iu, "") || "epg.xml", content, sourceId: source.id };
  }

  private sourceUiState(source: EpgSourceRecord): EpgSourceUiState {
    return {
      ...source,
      channelCount: this.repository.getChannels(source.id).length,
      programmeCount: this.repository.sourceProgrammeCount(source.id),
    };
  }
}

function materializeParsed(
  sourceId: string,
  parsedChannels: readonly EpgChannelRecord[],
  parsedProgrammes: readonly EpgProgrammeRecord[],
): { channels: readonly EpgChannelRecord[]; programmes: readonly EpgProgrammeRecord[] } {
  const channels = new Map<string, EpgChannelRecord>();
  for (const channel of parsedChannels) {
    const existing = channels.get(channel.externalId);
    if (existing) {
      channels.set(channel.externalId, {
        ...existing,
        displayNames: [...new Set([...existing.displayNames, ...channel.displayNames])],
        icon: existing.icon ?? channel.icon,
      });
      continue;
    }
    const id = `epg-channel-${sha256(`${sourceId}|${channel.externalId}`).slice(0, 24)}`;
    channels.set(channel.externalId, { ...channel, id, sourceId });
  }
  const programmes: EpgProgrammeRecord[] = [];
  const seen = new Set<string>();
  for (const programme of parsedProgrammes) {
    const channel = channels.get(programme.channelId);
    if (!channel) continue;
    const id = `epg-programme-${sha256(`${sourceId}|${channel.id}|${programme.startAt}|${programme.endAt}|${programme.title}|${programme.subTitle ?? ""}`).slice(0, 24)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    programmes.push({ ...programme, id, sourceId, channelId: channel.id });
  }
  return { channels: [...channels.values()], programmes };
}

function rematerializePreview(preview: EpgImportPreview, sourceId: string): { channels: readonly EpgChannelRecord[]; programmes: readonly EpgProgrammeRecord[] } {
  const oldToExternal = new Map(preview.channels.map((channel) => [channel.id, channel.externalId] as const));
  const parsedChannels = preview.channels.map((channel) => ({ ...channel, id: "", sourceId: "" }));
  const parsedProgrammes = preview.programmes.map((programme) => ({
    ...programme,
    id: "",
    sourceId: "",
    channelId: oldToExternal.get(programme.channelId) ?? programme.channelId,
  }));
  return materializeParsed(sourceId, parsedChannels, parsedProgrammes);
}

function previewUiState(preview: EpgImportPreview): EpgPreviewUiState {
  return {
    id: preview.id,
    source: { ...preview.source },
    channelNames: preview.channels.slice(0, 100).map((channel) => channel.displayName),
    issues: preview.issues.map((issue) => ({ ...issue })),
    stats: { ...preview.stats },
  };
}

function normalizeSourceName(value: string): string {
  const result = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!result) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 来源名称不能为空。");
  return result.slice(0, 80);
}

function normalizeRemoteLocation(value: string): string {
  const url = parseRemoteUrl(value);
  if (/[?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|password|secret)=/iu.test(url.search)) {
    throw new EpgSourceError("EPG_SOURCE_FAILED", "带敏感查询认证的 EPG 地址不保存。");
  }
  url.hash = "";
  return url.toString();
}

function parseRemoteUrl(value: string): URL {
  try {
    const url = new URL(value);
    validateRemoteUrl(url);
    return url;
  } catch (error) {
    if (error instanceof EpgSourceError) throw error;
    throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG URL 无效。", { cause: error });
  }
}

function validateRemoteUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 只允许 HTTP 或 HTTPS。");
  if (url.username || url.password) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG URL 不能包含账号或密码。");
}

function validateContentType(contentType: string | null, url: URL): void {
  if (!contentType) return;
  const value = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extensionMatches = /\.(?:xml|xmltv|gz)$/iu.test(url.pathname);
  if (!(value.includes("xml") || value === "text/plain" || value === "application/octet-stream" && extensionMatches)) {
    throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 响应类型不是 XML。");
  }
}

async function readResponseBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new EpgSourceError("EPG_TOO_LARGE", "EPG 响应超过压缩大小限制。");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new EpgSourceError("EPG_SOURCE_FAILED", "EPG 请求超时。");
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new EpgSourceError("EPG_TOO_LARGE", "EPG 响应超过压缩大小限制。");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function decodeXmlBytes(bytes: Buffer, maxBytes: number, contentEncoding?: string | null): string {
  if (bytes.length > maxBytes) throw new EpgSourceError("EPG_TOO_LARGE", "EPG 解压后内容超过限制。");
  let decoded = bytes;
  if (contentEncoding?.toLowerCase().includes("gzip") || isGzip(bytes)) {
    try {
      decoded = gunzipSync(bytes, { maxOutputLength: maxBytes + 1 });
    } catch (error) {
      if (isGzip(bytes)) throw new EpgSourceError("EPG_TOO_LARGE", "EPG gzip 解压失败或超过限制。", { cause: error });
    }
  }
  if (decoded.length > maxBytes) throw new EpgSourceError("EPG_TOO_LARGE", "EPG 解压后内容超过限制。");
  return decoded.toString("utf8");
}

function toBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function isGzip(value: Uint8Array): boolean {
  return value[0] === 0x1f && value[1] === 0x8b;
}

function safeFileName(value: string): string {
  const base = basename(value || "epg.xml").replace(/[\\/\0]/gu, "_").trim();
  return (base || "epg.xml").slice(0, 160);
}

function mapEpgError(error: unknown): EpgSourceError {
  if (error instanceof EpgSourceError) return error;
  if (error instanceof EpgParserError) return new EpgSourceError(error.code, error.message, { cause: error });
  return new EpgSourceError("EPG_SOURCE_FAILED", "EPG 处理失败。", { cause: error });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
