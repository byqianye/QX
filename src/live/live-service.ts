import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { redactSensitiveText } from "../data/safe-persistence.js";
import { LiveRepository } from "../data/repositories.js";
import {
  LiveParserError,
  normalizeChannelName,
  parseLiveContent,
  type ParsedLiveChannel,
  type ParsedLiveStream,
} from "./live-parser.js";
import {
  liveFormatForType,
  type LiveChannelWithStreams,
  type LiveImportPreview,
  type LiveImportStats,
  type LiveSourceImportInput,
  type LiveSourceRecord,
  type LiveSourceUiState,
  type LiveUiError,
  type LiveUiState,
  type LivePreviewUiState,
} from "./live-types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class LiveSourceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiveSourceError";
    this.code = code;
  }
}

export interface LiveSourceServiceOptions {
  repository: LiveRepository;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  now?: () => number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

interface LoadedSourceContent {
  content: string | null;
  location: string;
  baseUrl: string | undefined;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

interface PendingPreview {
  preview: LiveImportPreview;
  input: LiveSourceImportInput;
  content: string | null;
}

export class LiveSourceService {
  private readonly repository: LiveRepository;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (path: string) => string;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly pending = new Map<string, PendingPreview>();
  private readonly fileContents = new Map<string, string>();
  private readonly loadedContents = new Map<string, string | null>();
  private previewValue: LiveImportPreview | null = null;
  private loadingValue = false;
  private errorValue: LiveUiError | null = null;

  public constructor(options: LiveSourceServiceOptions) {
    this.repository = options.repository;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  }

  public uiState(): LiveUiState {
    const sources = this.repository.listSources().map((source) => this.sourceUiState(source));
    return {
      sources,
      preview: this.previewValue ? previewUiState(this.previewValue) : null,
      loading: this.loadingValue,
      error: this.errorValue ? { ...this.errorValue } : null,
    };
  }

  public async previewSource(input: LiveSourceImportInput): Promise<LiveImportPreview> {
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
      const mapped = mapLiveError(error);
      this.errorValue = { code: mapped.code, message: mapped.message };
      this.previewValue = null;
      this.pending.clear();
      for (const id of this.loadedContents.keys()) this.loadedContents.delete(id);
      throw mapped;
    } finally {
      this.loadingValue = false;
    }
  }

  public async applyPreview(previewId: string): Promise<LiveSourceRecord> {
    this.loadingValue = true;
    this.errorValue = null;
    try {
      const pending = this.pending.get(previewId);
      if (!pending) throw new LiveSourceError("LIVE_PREVIEW_NOT_FOUND", "直播源预览已过期，请重新导入。");
      const sourceId = pending.preview.source.id.startsWith("pending:")
        ? `live-${randomUUID()}`
        : pending.preview.source.id;
      const source: LiveSourceRecord = {
        ...pending.preview.source,
        id: sourceId,
        lastUpdatedAt: this.now(),
        lastSuccessAt: this.now(),
        lastError: null,
      };
      if (pending.preview.contentHash) source.contentHash = pending.preview.contentHash;
      const channels = pending.preview.channels.map((channel) => rematerializeChannel(channel, sourceId));
      if (!pending.preview.source.id.startsWith("pending:") && pending.preview.channels.length === 0) {
        this.repository.upsertSource(source);
      } else {
        this.repository.saveSourceContent(source, channels);
      }
      if (pending.content !== null && (source.type === "m3u-file" || source.type === "txt-file" || source.type === "fixture")) {
        this.fileContents.set(source.id, pending.content);
      }
      this.pending.delete(previewId);
      this.previewValue = null;
      return source;
    } catch (error) {
      const mapped = mapLiveError(error);
      this.errorValue = { code: mapped.code, message: mapped.message };
      throw mapped;
    } finally {
      this.loadingValue = false;
    }
  }

  public async refreshSource(sourceId: string): Promise<LiveSourceRecord> {
    const source = this.repository.getSource(sourceId);
    if (!source) throw new LiveSourceError("LIVE_SOURCE_NOT_FOUND", "直播源不存在。");
    if (!source.enabled) throw new LiveSourceError("LIVE_SOURCE_DISABLED", "直播源已停用，请先启用后刷新。");

    try {
      const input = this.inputForExistingSource(source);
      const preview = await this.previewSource(input);
      const loaded = this.pending.get(preview.id);
      if (loaded?.preview.contentHash === source.contentHash && loaded.preview.channels.length > 0) {
        const updated: LiveSourceRecord = {
          ...source,
          lastUpdatedAt: this.now(),
          lastSuccessAt: this.now(),
          lastError: null,
          etag: preview.etag ?? source.etag,
          lastModified: preview.lastModified ?? source.lastModified,
        };
        this.repository.upsertSource(updated);
        this.pending.delete(preview.id);
        this.previewValue = null;
        this.errorValue = null;
        return updated;
      }
      return await this.applyPreview(preview.id);
    } catch (error) {
      const mapped = mapLiveError(error);
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

  public setSourceEnabled(sourceId: string, enabled: boolean): LiveSourceRecord {
    const source = this.repository.getSource(sourceId);
    if (!source) throw new LiveSourceError("LIVE_SOURCE_NOT_FOUND", "直播源不存在。");
    const updated = { ...source, enabled };
    this.repository.upsertSource(updated);
    this.errorValue = null;
    return updated;
  }

  public removeSource(sourceId: string): void {
    if (!this.repository.getSource(sourceId)) throw new LiveSourceError("LIVE_SOURCE_NOT_FOUND", "直播源不存在。");
    this.repository.deleteSource(sourceId);
    this.fileContents.delete(sourceId);
    for (const [id, pending] of this.pending) {
      if (pending.preview.source.id === sourceId) this.pending.delete(id);
    }
    if (this.previewValue?.source.id === sourceId) this.previewValue = null;
    this.errorValue = null;
  }

  public channels(sourceId: string): readonly LiveChannelWithStreams[] {
    return this.repository.getChannels(sourceId);
  }

  public clearPreview(): void {
    this.previewValue = null;
    this.pending.clear();
    this.errorValue = null;
  }

  private async buildPreview(input: LiveSourceImportInput): Promise<LiveImportPreview> {
    const name = normalizeSourceName(input.name);
    const previewId = `preview-${randomUUID()}`;
    const existing = input.sourceId ? this.repository.getSource(input.sourceId) : null;
    if (input.sourceId && !existing) throw new LiveSourceError("LIVE_SOURCE_NOT_FOUND", "直播源不存在。");
    const loaded = await this.loadInput(input, existing);
    this.loadedContents.set(previewId, loaded.content);
    const sourceId = existing?.id ?? `pending:${previewId}`;
    const source: LiveSourceRecord = {
      id: sourceId,
      name: existing?.name ?? name,
      type: existing?.type ?? input.type,
      location: existing?.location ?? loaded.location,
      enabled: existing?.enabled ?? true,
      refreshMode: existing?.refreshMode ?? "manual",
      lastUpdatedAt: existing?.lastUpdatedAt ?? null,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastError: existing?.lastError ?? null,
      contentHash: existing?.contentHash ?? null,
      etag: existing?.etag ?? null,
      lastModified: existing?.lastModified ?? null,
    };

    if (loaded.notModified) {
      const current = existing ? this.repository.getChannels(existing.id) : [];
      if (!existing || current.length === 0) {
        throw new LiveSourceError("LIVE_SOURCE_FETCH_FAILED", "直播源返回未修改，但没有可用的历史版本。");
      }
      const stats = statsForChannels(current, current, 0);
      return {
        id: previewId,
        source: {
          ...source,
          contentHash: existing.contentHash,
          etag: loaded.etag ?? existing.etag,
          lastModified: loaded.lastModified ?? existing.lastModified,
        },
        channels: current,
        issues: [],
        stats,
        contentHash: existing.contentHash ?? "",
        etag: loaded.etag ?? existing.etag,
        lastModified: loaded.lastModified ?? existing.lastModified,
      };
    }

    if (loaded.content === null) throw new LiveSourceError("LIVE_SOURCE_FETCH_FAILED", "直播源没有返回内容。");
    const parsed = parseLiveContent(loaded.content, {
      format: liveFormatForInput(input),
      ...(loaded.baseUrl ? { baseUrl: loaded.baseUrl } : {}),
    });
    const channels = materializeChannels(sourceId, deduplicateChannels(parsed.channels));
    if (channels.length === 0) {
      throw new LiveSourceError(
        parsed.issues[0]?.code ?? "LIVE_PARSE_FAILED",
        parsed.issues[0]?.message ?? "直播源没有可用频道。",
      );
    }
    const contentHash = sha256(loaded.content);
    const stats = statsForChannels(existing ? this.repository.getChannels(existing.id) : [], channels, parsed.issues.length);
    return {
      id: previewId,
      source: {
        ...source,
        location: existing?.location ?? loaded.location,
        contentHash,
        etag: loaded.etag ?? existing?.etag ?? null,
        lastModified: loaded.lastModified ?? existing?.lastModified ?? null,
      },
      channels,
      issues: parsed.issues,
      stats,
      contentHash,
      etag: loaded.etag ?? existing?.etag ?? null,
      lastModified: loaded.lastModified ?? existing?.lastModified ?? null,
    };
  }

  private async loadInput(
    input: LiveSourceImportInput,
    existing: LiveSourceRecord | null,
  ): Promise<LoadedSourceContent> {
    if (input.type === "m3u-url" || input.type === "txt-url") {
      const location = normalizeRemoteLocation(existing?.location ?? input.location);
      return this.loadRemote(location, existing, liveFormatForType(input.type));
    }

    if (input.type === "fixture") {
      const content = input.content;
      assertContentSize(content, this.maxResponseBytes);
      const location = existing?.location ?? `fixture:${input.format}:${sha256(content).slice(0, 16)}`;
      return {
        content,
        location,
        baseUrl: undefined,
        etag: null,
        lastModified: null,
        notModified: false,
      };
    }

    if (input.type === "m3u-file" || input.type === "txt-file") {
      if (input.content !== undefined) {
      assertContentSize(input.content, this.maxResponseBytes);
      return {
        content: input.content,
        location: existing?.location ?? `file:${safeFileName(input.fileName)}`,
        baseUrl: undefined,
        etag: null,
        lastModified: null,
        notModified: false,
      };
    }

    const filePath = input.filePath ?? input.location;
    if (!filePath) throw new LiveSourceError("LIVE_FILE_SOURCE_UNAVAILABLE", "本地直播源文件不可用。");
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      if (stat.size > this.maxResponseBytes) throw new LiveSourceError("LIVE_SOURCE_TOO_LARGE", "直播源文件超过大小限制。");
      const content = this.readFile(filePath);
      assertContentSize(content, this.maxResponseBytes);
      return {
        content,
        location: existing?.location ?? `file:${safeFileName(input.fileName || basename(filePath))}`,
        baseUrl: pathToFileURL(`${dirname(filePath)}${filePath.endsWith("\\") || filePath.endsWith("/") ? "" : "/"}`).toString(),
        etag: null,
        lastModified: null,
        notModified: false,
      };
    } catch (error) {
      if (error instanceof LiveSourceError) throw error;
      throw new LiveSourceError("LIVE_FILE_READ_FAILED", "本地直播源文件读取失败。", { cause: error });
      }
    }
    throw new LiveSourceError("LIVE_SOURCE_TYPE_INVALID", "直播源类型无效。");
  }

  private async loadRemote(
    location: string,
    existing: LiveSourceRecord | null,
    format: "m3u" | "txt",
  ): Promise<LoadedSourceContent> {
    const initial = parseRemoteUrl(location);
    const origin = initial.origin;
    let current = initial;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const headers: Record<string, string> = {};
      if (existing?.etag) headers["if-none-match"] = existing.etag;
      if (existing?.lastModified) headers["if-modified-since"] = existing.lastModified;
      let response: Response;
      try {
        response = await this.fetchImpl(current.toString(), {
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new LiveSourceError("LIVE_SOURCE_TIMEOUT", "直播源请求超时。", { cause: error });
        }
        throw new LiveSourceError("LIVE_SOURCE_FETCH_FAILED", "直播源请求失败。", { cause: error });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const locationHeader = response.headers.get("location");
        if (!locationHeader) throw new LiveSourceError("LIVE_REDIRECT_INVALID", "直播源重定向缺少目标地址。");
        let next: URL;
        try {
          next = new URL(locationHeader, current);
        } catch {
          throw new LiveSourceError("LIVE_REDIRECT_INVALID", "直播源重定向地址无效。");
        }
        validateRemoteUrl(next);
        if (next.origin !== origin) {
          throw new LiveSourceError("LIVE_REDIRECT_ORIGIN_MISMATCH", "直播源重定向跨越了原始来源。");
        }
        current = next;
        continue;
      }
      if (response.status === 304) {
        return {
          content: null,
          location: initial.toString(),
          baseUrl: current.toString(),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          notModified: true,
        };
      }
      if (!response.ok) {
        throw new LiveSourceError(
          response.status === 408 || response.status === 504 ? "LIVE_SOURCE_TIMEOUT" : "LIVE_SOURCE_FETCH_FAILED",
          "直播源返回了不可用的响应。",
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        throw new LiveSourceError("LIVE_SOURCE_TOO_LARGE", "直播源响应超过大小限制。");
      }
      validateContentType(response.headers.get("content-type"), format, current);
      const content = await readResponseText(response, this.maxResponseBytes);
      return {
        content,
        location: initial.toString(),
        baseUrl: current.toString(),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        notModified: false,
      };
    }
    throw new LiveSourceError("LIVE_REDIRECT_LIMIT", "直播源重定向次数超过限制。");
  }

  private inputForExistingSource(source: LiveSourceRecord): LiveSourceImportInput {
    if (source.type === "m3u-url" || source.type === "txt-url") {
      return { name: source.name, type: source.type, location: source.location, sourceId: source.id };
    }
    const content = this.fileContents.get(source.id);
    if (source.type === "fixture") {
      if (!content) throw new LiveSourceError("LIVE_FIXTURE_UNAVAILABLE", "直播 fixture 内容不可用。");
      return {
        name: source.name,
        type: source.type,
        format: source.location.startsWith("fixture:txt:") ? "txt" : "m3u",
        content,
        location: source.location,
        sourceId: source.id,
      };
    }
    if (!content) throw new LiveSourceError("LIVE_FILE_SOURCE_UNAVAILABLE", "本地直播源文件需要重新选择。");
    return {
      name: source.name,
      type: source.type,
      fileName: source.location.replace(/^file:/iu, "") || "playlist",
      content,
      sourceId: source.id,
    };
  }

  private sourceUiState(source: LiveSourceRecord): LiveSourceUiState {
    const channels = this.repository.getChannels(source.id);
    return {
      ...source,
      channelCount: channels.length,
      groupCount: new Set(channels.map((channel) => channel.group).filter((group): group is string => Boolean(group))).size,
      streamCount: channels.reduce((total, channel) => total + channel.streams.length, 0),
    };
  }
}

function materializeChannels(sourceId: string, channels: readonly ParsedLiveChannel[]): readonly LiveChannelWithStreams[] {
  return channels.map((channel, index) => {
    const key = channelKey(channel);
    const channelId = `live-channel-${sha256(`${sourceId}|${key}`).slice(0, 24)}`;
    return {
      id: channelId,
      sourceId,
      externalId: channel.externalId,
      name: channel.name,
      normalizedName: channel.normalizedName,
      group: channel.group,
      logo: channel.logo,
      tvgId: channel.tvgId,
      tvgName: channel.tvgName,
      tvgLogo: channel.tvgLogo,
      tvgChno: channel.tvgChno,
      catchup: channel.catchup,
      attributes: { ...channel.attributes },
      enabled: true,
      sortOrder: index,
      streams: channel.streams.map((stream, priority) => ({
        id: `live-stream-${sha256(`${channelId}|${stream.url}|${JSON.stringify(stream.headers)}`).slice(0, 24)}`,
        channelId,
        url: stream.url,
        headers: { ...stream.headers },
        priority,
        label: stream.label ?? (channel.streams.length > 1 ? `线路 ${priority + 1}` : null),
        protocol: stream.protocol,
      })),
    };
  });
}

function rematerializeChannel(channel: LiveChannelWithStreams, sourceId: string): LiveChannelWithStreams {
  const channelId = `live-channel-${sha256(`${sourceId}|${channelKey(channel)}`).slice(0, 24)}`;
  return {
    ...channel,
    id: channelId,
    sourceId,
    streams: channel.streams.map((stream, priority) => ({
      ...stream,
      id: `live-stream-${sha256(`${channelId}|${stream.url}|${JSON.stringify(stream.headers)}`).slice(0, 24)}`,
      channelId,
      priority,
    })),
  };
}

function deduplicateChannels(channels: readonly ParsedLiveChannel[]): readonly ParsedLiveChannel[] {
  const result: ParsedLiveChannel[] = [];
  const byKey = new Map<string, number>();
  for (const channel of channels) {
    const key = channelKey(channel);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, result.length);
      result.push({ ...channel, streams: channel.streams.map((stream) => ({ ...stream, headers: { ...stream.headers } })) });
      continue;
    }
    const existing = result[existingIndex];
    if (!existing) continue;
    const known = new Set(existing.streams.map(streamSignature));
    const streams = [...existing.streams];
    for (const stream of channel.streams) {
      if (known.has(streamSignature(stream))) continue;
      known.add(streamSignature(stream));
      streams.push({ ...stream, priority: streams.length });
    }
    result[existingIndex] = { ...existing, streams };
  }
  return result;
}

function channelKey(channel: Pick<ParsedLiveChannel, "externalId" | "normalizedName" | "streams"> | LiveChannelWithStreams): string {
  const streamSignatureValue = channel.streams.map(streamSignature).sort().join("|");
  return channel.externalId
    ? `id:${normalizeChannelName(channel.externalId)}|name:${channel.normalizedName}`
    : `name:${channel.normalizedName}|streams:${streamSignatureValue}`;
}

function streamSignature(stream: Pick<ParsedLiveStream, "url" | "headers">): string {
  return `${stream.url}|${JSON.stringify(stream.headers)}`;
}

function statsForChannels(
  previous: readonly LiveChannelWithStreams[],
  next: readonly LiveChannelWithStreams[],
  invalidCount: number,
): LiveImportStats {
  const previousByKey = new Map(previous.map((channel) => [channelKey(channel), channel] as const));
  const nextByKey = new Map(next.map((channel) => [channelKey(channel), channel] as const));
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  for (const [key, channel] of nextByKey) {
    const old = previousByKey.get(key);
    if (!old) addedCount += 1;
    else if (channelSignature(old) !== channelSignature(channel)) changedCount += 1;
  }
  for (const key of previousByKey.keys()) if (!nextByKey.has(key)) removedCount += 1;
  const protocolCounts: Record<string, number> = {};
  for (const channel of next) {
    for (const stream of channel.streams) {
      const protocol = stream.protocol ?? "UNKNOWN";
      protocolCounts[protocol] = (protocolCounts[protocol] ?? 0) + 1;
    }
  }
  return {
    channelCount: next.length,
    groupCount: new Set(next.map((channel) => channel.group).filter((group): group is string => Boolean(group))).size,
    streamCount: next.reduce((total, channel) => total + channel.streams.length, 0),
    invalidCount,
    protocolCounts,
    addedCount,
    removedCount,
    changedCount,
  };
}

function channelSignature(channel: LiveChannelWithStreams): string {
  return JSON.stringify({
    name: channel.name,
    group: channel.group,
    logo: channel.logo,
    tvgId: channel.tvgId,
    attributes: channel.attributes,
    streams: channel.streams.map(streamSignature),
  });
}

function previewUiState(preview: LiveImportPreview): LivePreviewUiState {
  return {
    id: preview.id,
    source: { ...preview.source },
    channelNames: preview.channels.slice(0, 50).map((channel) => channel.name),
    issues: preview.issues.map((issue) => ({ ...issue })),
    stats: {
      ...preview.stats,
      protocolCounts: { ...preview.stats.protocolCounts },
    },
  };
}

function normalizeSourceName(value: string): string {
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 120) throw new LiveSourceError("LIVE_SOURCE_NAME_INVALID", "直播源名称不能为空且不能超过 120 个字符。");
  return name;
}

function safeFileName(value: string): string {
  const name = basename(value).replace(/[\r\n]/gu, "").trim();
  return name.slice(0, 160) || "playlist";
}

function normalizeRemoteLocation(value: string): string {
  const url = parseRemoteUrl(value);
  if (/[?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|password|secret)=/iu.test(url.search)) {
    throw new LiveSourceError("LIVE_SOURCE_AUTH_UNSUPPORTED", "带敏感查询认证的直播源暂不保存，请使用不含凭据的授权地址。");
  }
  url.hash = "";
  return url.toString();
}

function parseRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LiveSourceError("LIVE_SOURCE_URL_INVALID", "直播源 URL 无效。");
  }
  validateRemoteUrl(url);
  return url;
}

function validateRemoteUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LiveSourceError("LIVE_SOURCE_PROTOCOL_UNSUPPORTED", "直播源只允许 HTTP 或 HTTPS。");
  }
  if (url.username || url.password) {
    throw new LiveSourceError("LIVE_SOURCE_AUTH_UNSUPPORTED", "直播源 URL 不能包含内嵌账号或密码。");
  }
}

function validateContentType(contentType: string | null, format: "m3u" | "txt", url: URL): void {
  if (!contentType) return;
  const value = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const path = url.pathname.toLowerCase();
  const extensionMatches = format === "m3u"
    ? path.endsWith(".m3u") || path.endsWith(".m3u8")
    : path.endsWith(".txt") || path.endsWith(".csv");
  const accepted = format === "m3u"
    ? value.includes("mpegurl") || value.includes("m3u") || value === "text/plain" || (value === "application/octet-stream" && extensionMatches)
    : value.startsWith("text/") || value.includes("csv") || (value === "application/octet-stream" && extensionMatches);
  if (!accepted) throw new LiveSourceError("LIVE_SOURCE_CONTENT_TYPE_UNSUPPORTED", "直播源响应类型与所选格式不匹配。");
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  try {
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new LiveSourceError("LIVE_SOURCE_TOO_LARGE", "直播源响应超过大小限制。");
      return bytes.toString("utf8");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel();
          throw new LiveSourceError("LIVE_SOURCE_TOO_LARGE", "直播源响应超过大小限制。");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof LiveSourceError) throw error;
    throw new LiveSourceError("LIVE_SOURCE_FETCH_FAILED", "直播源内容读取失败。", { cause: error });
  }
}

function assertContentSize(content: string, maxBytes: number): void {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new LiveSourceError("LIVE_SOURCE_TOO_LARGE", "直播源内容超过大小限制。");
  }
}

function liveFormatForInput(input: LiveSourceImportInput): "m3u" | "txt" {
  return input.type === "fixture" ? input.format : liveFormatForType(input.type);
}

function mapLiveError(error: unknown): LiveSourceError {
  if (error instanceof LiveSourceError) return error;
  if (error instanceof LiveParserError) return new LiveSourceError(error.code, error.message, { cause: error });
  return new LiveSourceError("LIVE_SOURCE_FAILED", "直播源处理失败。", { cause: error });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
