import { redactSensitiveText } from "../data/safe-persistence.js";
import type {
  LiveChannelStreamRecord,
  LiveImportIssue,
  LiveSourceFormat,
} from "./live-types.js";

export interface ParsedLiveStream {
  url: string;
  headers: Record<string, string>;
  priority: number;
  label: string | null;
  protocol: string;
}

export interface ParsedLiveChannel {
  externalId: string | null;
  name: string;
  normalizedName: string;
  group: string | null;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
  tvgLogo: string | null;
  tvgChno: string | null;
  catchup: string | null;
  attributes: Record<string, string>;
  streams: readonly ParsedLiveStream[];
}

export interface LiveParserOptions {
  format: LiveSourceFormat;
  baseUrl?: string;
}

export interface LiveParseResult {
  channels: readonly ParsedLiveChannel[];
  issues: readonly LiveImportIssue[];
}

export class LiveParserError extends Error {
  public readonly code: string;
  public readonly line: number | null;

  public constructor(code: string, message: string, line: number | null = null) {
    super(message);
    this.name = "LiveParserError";
    this.code = code;
    this.line = line;
  }
}

export function parseLiveContent(content: string, options: LiveParserOptions): LiveParseResult {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.trim()) throw new LiveParserError("LIVE_FORMAT_UNSUPPORTED", "直播源内容为空。", null);
  return options.format === "m3u"
    ? parseM3u(normalized, options.baseUrl)
    : parseTxt(normalized, options.baseUrl);
}

export function normalizeChannelName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function parseM3u(content: string, baseUrl: string | undefined): LiveParseResult {
  const lines = content.split(/\r?\n/u);
  const channels: ParsedLiveChannel[] = [];
  const issues: LiveImportIssue[] = [];
  let pending: PendingM3uEntry | null = null;
  let pendingHeaders: Record<string, string> = {};
  let sawHeader = false;
  let sawMeaningfulLine = false;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    sawMeaningfulLine = true;

    if (trimmed.startsWith("#")) {
      const upper = trimmed.toUpperCase();
      if (upper === "#EXTM3U" || upper.startsWith("#EXTM3U ")) {
        sawHeader = true;
        return;
      }
      if (upper.startsWith("#EXTINF")) {
        if (pending) {
          issues.push(issue(lineNumber, "LIVE_ENTRY_MISSING_URL", "上一条频道缺少播放地址。", trimmed));
        }
        pendingHeaders = {};
        try {
          pending = parseExtinf(trimmed, lineNumber);
        } catch (error) {
          pending = null;
          issues.push(issue(
            lineNumber,
            codeOf(error, "LIVE_EXTINF_INVALID"),
            messageOf(error, "EXTINF 行无法解析。"),
            trimmed,
          ));
        }
        return;
      }
      if (pending && upper.startsWith("#EXTVLCOPT:")) {
        const header = parseVlcOption(trimmed);
        if (header) pendingHeaders[header.name] = header.value;
        return;
      }
      return;
    }

    if (!pending) {
      issues.push(issue(lineNumber, "LIVE_ENTRY_WITHOUT_EXTINF", "播放地址前缺少频道描述。", trimmed));
      return;
    }

    const stream = resolveStream(trimmed, baseUrl, lineNumber, pendingHeaders);
    if (stream) {
      channels.push({
        ...pending.channel,
        streams: [{ ...stream, priority: 0 }],
      });
    } else {
      issues.push(issue(lineNumber, "LIVE_STREAM_INVALID", "频道播放地址无效或不安全。", trimmed));
    }
    pending = null;
    pendingHeaders = {};
  });

  const trailingPending = pending as PendingM3uEntry | null;
  if (trailingPending) {
    issues.push(issue(lines.length, "LIVE_ENTRY_MISSING_URL", "频道描述后缺少播放地址。", trailingPending.channel.name));
  }
  if (!sawMeaningfulLine || (channels.length === 0 && issues.length === 0)) {
    throw new LiveParserError("LIVE_FORMAT_UNSUPPORTED", "内容不是可识别的 M3U 直播源。", null);
  }
  if (!sawHeader && channels.length === 0) {
    throw new LiveParserError("LIVE_FORMAT_UNSUPPORTED", "M3U 直播源缺少可识别的频道条目。", null);
  }
  return { channels, issues };
}

function parseTxt(content: string, baseUrl: string | undefined): LiveParseResult {
  const lines = content.split(/\r?\n/u);
  const channels: ParsedLiveChannel[] = [];
  const issues: LiveImportIssue[] = [];
  let currentGroup: string | null = null;
  let recognized = false;
  let meaningful = false;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;
    meaningful = true;

    const genre = parseGenreLine(trimmed);
    if (genre !== null) {
      currentGroup = genre || null;
      recognized = true;
      return;
    }
    if (trimmed.startsWith("#")) return;

    const comma = trimmed.indexOf(",");
    if (comma <= 0) {
      issues.push(issue(lineNumber, "LIVE_TXT_LINE_INVALID", "TXT 行缺少“频道名,地址”结构。", trimmed));
      return;
    }
    const name = trimmed.slice(0, comma).trim();
    const urlText = trimmed.slice(comma + 1).trim();
    if (!name || !urlText) {
      issues.push(issue(lineNumber, "LIVE_TXT_LINE_INVALID", "TXT 行的频道名或地址为空。", trimmed));
      return;
    }
    const streams: ParsedLiveStream[] = [];
    for (const [priority, value] of splitTxtUrls(urlText).entries()) {
      const stream = resolveStream(value, baseUrl, lineNumber, {});
      if (stream) {
        streams.push({ ...stream, priority, label: streams.length > 0 ? `线路 ${priority + 1}` : null });
      } else {
        issues.push(issue(lineNumber, "LIVE_STREAM_INVALID", "TXT 播放地址无效或不安全。", value));
      }
    }
    if (streams.length === 0) return;
    recognized = true;
    channels.push({
      externalId: null,
      name,
      normalizedName: normalizeChannelName(name),
      group: currentGroup,
      logo: null,
      tvgId: null,
      tvgName: null,
      tvgLogo: null,
      tvgChno: null,
      catchup: null,
      attributes: { format: "txt" },
      streams,
    });
  });

  if (!meaningful || (!recognized && channels.length === 0)) {
    throw new LiveParserError("LIVE_FORMAT_UNSUPPORTED", "内容不是可识别的 TXT 直播源。", null);
  }
  return { channels, issues };
}

interface PendingM3uEntry {
  channel: Omit<ParsedLiveChannel, "streams">;
}

function parseExtinf(line: string, lineNumber: number): PendingM3uEntry {
  const comma = findUnquotedComma(line, 8);
  if (comma < 0) throw new LiveParserError("LIVE_EXTINF_INVALID", "EXTINF 缺少频道名称。", lineNumber);
  const descriptor = line.slice(8, comma).trim();
  const name = line.slice(comma + 1).trim();
  if (!name) throw new LiveParserError("LIVE_EXTINF_INVALID", "EXTINF 频道名称为空。", lineNumber);

  const durationEnd = descriptor.search(/\s/u);
  const duration = durationEnd < 0 ? descriptor : descriptor.slice(0, durationEnd);
  if (!/^-?(?:\d+(?:\.\d+)?|\d*\.\d+)$/u.test(duration)) {
    throw new LiveParserError("LIVE_EXTINF_INVALID", "EXTINF 时长字段无效。", lineNumber);
  }
  const attributes = parseAttributes(durationEnd < 0 ? "" : descriptor.slice(durationEnd).trim());
  const tvgId = attributes["tvg-id"]?.trim() || null;
  const tvgName = attributes["tvg-name"]?.trim() || null;
  const tvgLogo = safeMetadataUrl(attributes["tvg-logo"]);
  const group = attributes["group-title"]?.trim() || null;
  const catchup = attributes["catchup-source"]?.trim()
    || attributes.catchup?.trim()
    || null;
  return {
    channel: {
      externalId: tvgId,
      name,
      normalizedName: normalizeChannelName(name),
      group,
      logo: tvgLogo,
      tvgId,
      tvgName,
      tvgLogo,
      tvgChno: attributes["tvg-chno"]?.trim() || null,
      catchup,
      attributes,
    },
  };
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const keyStart = index;
    while (index < value.length && !/[\s=]/u.test(value[index] ?? "")) index += 1;
    const key = value.slice(keyStart, index).trim().toLowerCase();
    if (!key) {
      index += 1;
      continue;
    }
    while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
    let parsedValue = "true";
    if (value[index] === "=") {
      index += 1;
      while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
      if (value[index] === '"') {
        index += 1;
        const valueStart = index;
        while (index < value.length && value[index] !== '"') index += 1;
        parsedValue = value.slice(valueStart, index);
        if (value[index] === '"') index += 1;
      } else {
        const valueStart = index;
        while (index < value.length && !/\s/u.test(value[index] ?? "")) index += 1;
        parsedValue = value.slice(valueStart, index);
      }
    }
    attributes[key] = parsedValue;
  }
  return attributes;
}

function parseVlcOption(line: string): { name: string; value: string } | null {
  const separator = line.indexOf("=", "#EXTVLCOPT:".length);
  if (separator < 0) return null;
  const key = line.slice("#EXTVLCOPT:".length, separator).trim().toLowerCase();
  const value = line.slice(separator + 1).trim();
  const names: Record<string, string> = {
    "http-referrer": "referer",
    "http-user-agent": "user-agent",
  };
  const name = names[key];
  if (!name || !value || /[\r\n]/u.test(value) || /(?:token|password|secret|authorization|cookie|api[_-]?key)=/iu.test(value)) {
    return null;
  }
  return { name, value };
}

function resolveStream(
  value: string,
  baseUrl: string | undefined,
  line: number,
  headers: Record<string, string>,
): ParsedLiveStream | null {
  let url: URL;
  try {
    if (!baseUrl && !/^[a-z][a-z\d+.-]*:/iu.test(value)) {
      throw new LiveParserError("LIVE_RELATIVE_URL_BASE_REQUIRED", "相对播放地址缺少明确 base。", line);
    }
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") return null;
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (/[?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|password|secret)=/iu.test(url.search)) {
      return null;
    }
  }
  return {
    url: url.toString(),
    headers: { ...headers },
    priority: 0,
    label: null,
    protocol: protocolForUrl(url),
  };
}

function protocolForUrl(url: URL): string {
  if (url.protocol === "file:") return "FILE";
  if (/\.m3u8$/iu.test(url.pathname)) return "HLS";
  if (/\.mp4$/iu.test(url.pathname)) return "MP4";
  return "HTTP";
}

function parseGenreLine(value: string): string | null {
  const marker = ",#genre#";
  const lower = value.toLocaleLowerCase();
  if (!lower.endsWith(marker)) return null;
  return value.slice(0, value.length - marker.length).trim();
}

function splitTxtUrls(value: string): readonly string[] {
  return value.split("#").map((item) => item.trim()).filter(Boolean);
}

function findUnquotedComma(value: string, start: number): number {
  let quoted = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) return index;
  }
  return -1;
}

function safeMetadataUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function issue(line: number, code: string, message: string, raw: string | null): LiveImportIssue {
  return {
    line,
    code,
    message,
    raw: raw === null ? null : redactSensitiveText(raw).slice(0, 240),
  };
}

function codeOf(error: unknown, fallback: string): string {
  return error instanceof LiveParserError ? error.code : fallback;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof LiveParserError ? error.message : fallback;
}
