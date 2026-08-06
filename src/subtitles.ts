export type SubtitleFormat = "vtt" | "srt" | "ass" | "ssa";

export type SubtitleEncoding =
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le"
  | "utf-16be"
  | "gb18030"
  | "gbk"
  | "big5"
  | "unknown";

export type SubtitleTrackSource = "source" | "jellyfin" | "local" | "local-proxy" | "fixture";

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  format: SubtitleFormat;
  url?: string;
  localPath?: string;
  headers?: Record<string, string>;
  default: boolean;
  forced: boolean;
  source?: SubtitleTrackSource;
}

export interface SubtitleCue {
  id?: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ParsedSubtitle {
  format: SubtitleFormat;
  encoding: SubtitleEncoding;
  cues: SubtitleCue[];
  warnings: string[];
}

export interface SubtitleParseOptions {
  format?: SubtitleFormat;
  encoding?: SubtitleEncoding;
}

export interface SubtitleWebVttOptions {
  position?: "bottom" | "top";
}

export interface SubtitleEncodingDetection {
  encoding: SubtitleEncoding;
  bom: boolean;
  confident: boolean;
}

export class SubtitleParseError extends Error {
  public readonly code:
    | "SUBTITLE_FORMAT_UNKNOWN"
    | "SUBTITLE_FORMAT_UNSUPPORTED"
    | "SUBTITLE_ENCODING_UNKNOWN"
    | "SUBTITLE_TIMELINE_INVALID"
    | "SUBTITLE_PROXY_REQUIRED"
    | "SUBTITLE_LOAD_FAILED";

  public constructor(
    code: SubtitleParseError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SubtitleParseError";
    this.code = code;
  }
}

const FORMAT_BY_EXTENSION: Record<string, SubtitleFormat> = {
  ass: "ass",
  ssa: "ssa",
  srt: "srt",
  vtt: "vtt",
  webvtt: "vtt",
};

const ENCODING_LABELS: readonly SubtitleEncoding[] = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "gb18030",
  "gbk",
  "big5",
];

export function normalizeSubtitleFormat(value: unknown): SubtitleFormat | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/^text\//, "");
  if (normalized === "webvtt") return "vtt";
  if (normalized === "text/vtt") return "vtt";
  return normalized === "vtt" || normalized === "srt" || normalized === "ass" || normalized === "ssa"
    ? normalized
    : null;
}

export function subtitleFormatFromName(name: string): SubtitleFormat | null {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name.trim())?.[1]?.toLowerCase();
  return extension ? FORMAT_BY_EXTENSION[extension] ?? null : null;
}

export function detectSubtitleFormat(
  input: string | Uint8Array,
  nameHint?: string,
): SubtitleFormat | null {
  const hint = nameHint ? subtitleFormatFromName(nameHint) : null;
  if (hint) return hint;
  const text = typeof input === "string" ? input : tryDecodeForFormat(input);
  if (!text) return null;
  if (/^\uFEFF?WEBVTT(?:\s|$)/i.test(text.trimStart())) return "vtt";
  if (/^\s*\[(?:Script Info|V4 Styles|V4\+ Styles|V4\+ Styles|Events)\]/im.test(text)
    || /^\s*Dialogue\s*:/im.test(text)) {
    return "ass";
  }
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(text)) return "srt";
  if (/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s+-->/.test(text)) return "vtt";
  return null;
}

export function detectSubtitleEncoding(input: Uint8Array): SubtitleEncodingDetection {
  if (startsWith(input, [0xef, 0xbb, 0xbf])) {
    return { encoding: "utf-8-bom", bom: true, confident: true };
  }
  if (startsWith(input, [0xff, 0xfe])) {
    return { encoding: "utf-16le", bom: true, confident: true };
  }
  if (startsWith(input, [0xfe, 0xff])) {
    return { encoding: "utf-16be", bom: true, confident: true };
  }

  if (canDecode(input, "utf-8", true)) {
    return { encoding: "utf-8", bom: false, confident: true };
  }

  const chineseCandidates = ENCODING_LABELS.filter((encoding) => encoding === "gb18030" || encoding === "gbk" || encoding === "big5")
    .map((encoding) => ({ encoding, text: decodeWithTextDecoder(input, encoding, false) }))
    .filter((candidate) => candidate.text !== null)
    .map((candidate) => ({ ...candidate, score: chineseTextScore(candidate.text ?? "") }))
    .sort((left, right) => right.score - left.score);
  const best = chineseCandidates[0];
  if (best && best.score > 0 && !best.text?.includes("�")) {
    return { encoding: best.encoding, bom: false, confident: false };
  }
  return { encoding: "unknown", bom: false, confident: false };
}

export function decodeSubtitle(
  input: string | Uint8Array,
  requestedEncoding?: SubtitleEncoding,
): { text: string; encoding: SubtitleEncoding } {
  if (typeof input === "string") {
    return { text: stripBom(input), encoding: requestedEncoding ?? "utf-8" };
  }
  const detection = detectSubtitleEncoding(input);
  const encoding = requestedEncoding && requestedEncoding !== "unknown"
    ? requestedEncoding
    : detection.encoding;
  if (encoding === "unknown") {
    throw new SubtitleParseError(
      "SUBTITLE_ENCODING_UNKNOWN",
      "字幕编码无法可靠识别，请选择编码后重试。",
    );
  }
  const decoderEncoding = encoding === "utf-8-bom" ? "utf-8" : encoding;
  const text = decodeWithTextDecoder(input, decoderEncoding, true);
  if (text === null) {
    throw new SubtitleParseError(
      "SUBTITLE_ENCODING_UNKNOWN",
      "字幕编码无法解码，请选择其他编码。",
    );
  }
  return { text: stripBom(text), encoding };
}

export function parseSubtitle(
  input: string | Uint8Array,
  options: SubtitleParseOptions = {},
): ParsedSubtitle {
  const decoded = decodeSubtitle(input, options.encoding);
  const format = options.format ?? detectSubtitleFormat(decoded.text);
  if (!format) {
    throw new SubtitleParseError("SUBTITLE_FORMAT_UNKNOWN", "无法识别字幕格式。支持 WebVTT、SRT 和基础 ASS/SSA。");
  }
  if (format === "vtt") return parseWebVtt(decoded.text, decoded.encoding);
  if (format === "srt") return parseSrt(decoded.text, decoded.encoding);
  if (format === "ass" || format === "ssa") return parseAss(decoded.text, decoded.encoding, format);
  throw new SubtitleParseError("SUBTITLE_FORMAT_UNSUPPORTED", "当前字幕格式暂不支持。");
}

export function parseWebVtt(text: string, encoding: SubtitleEncoding = "utf-8"): ParsedSubtitle {
  const lines = normalizedLines(text);
  if (!/^WEBVTT(?:\s|$)/i.test(lines[0] ?? "")) {
    throw new SubtitleParseError("SUBTITLE_FORMAT_UNSUPPORTED", "不是有效的 WebVTT 字幕。");
  }
  const cues: SubtitleCue[] = [];
  let index = 1;
  while (index < lines.length) {
    while (index < lines.length && lines[index]?.trim() === "") index += 1;
    if (index >= lines.length) break;
    const line = lines[index]?.trim() ?? "";
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) {
      index += 1;
      while (index < lines.length && lines[index]?.trim() !== "") index += 1;
      continue;
    }
    const cueId = line.includes("-->") ? undefined : line;
    if (cueId) index += 1;
    const timing = lines[index]?.trim() ?? "";
    if (!timing.includes("-->")) {
      throw new SubtitleParseError("SUBTITLE_TIMELINE_INVALID", "WebVTT 字幕时间轴无效。");
    }
    const { startMs, endMs } = parseTimingLine(timing, "vtt");
    index += 1;
    const cueLines: string[] = [];
    while (index < lines.length && lines[index]?.trim() !== "") {
      cueLines.push(lines[index] ?? "");
      index += 1;
    }
    const cue: SubtitleCue = {
      ...(cueId ? { id: cueId } : {}),
      startMs,
      endMs,
      text: sanitizeSubtitleText(cueLines.join("\n")),
    };
    cues.push(cue);
  }
  return { format: "vtt", encoding, cues, warnings: [] };
}

export function parseSrt(text: string, encoding: SubtitleEncoding = "utf-8"): ParsedSubtitle {
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    while (lines[0]?.trim() === "") lines.shift();
    if (lines.length === 0 || lines.every((line) => line.trim() === "")) continue;
    let timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const id = timingIndex > 0 ? lines.slice(0, timingIndex).join(" ").trim() : undefined;
    const { startMs, endMs } = parseTimingLine(lines[timingIndex] ?? "", "srt");
    const cueText = lines.slice(timingIndex + 1).join("\n").trimEnd();
    cues.push({
      ...(id ? { id } : {}),
      startMs,
      endMs,
      text: sanitizeSubtitleText(cueText),
    });
  }
  return { format: "srt", encoding, cues, warnings: [] };
}

export function parseAss(
  text: string,
  encoding: SubtitleEncoding = "utf-8",
  format: "ass" | "ssa" = "ass",
): ParsedSubtitle {
  const lines = normalizedLines(text);
  const cues: SubtitleCue[] = [];
  let textFieldIndex = 9;
  for (const line of lines) {
    if (/^\s*Format\s*:/i.test(line)) {
      const fields = line.slice(line.indexOf(":") + 1).split(",").map((field) => field.trim().toLowerCase());
      const detectedTextIndex = fields.indexOf("text");
      if (detectedTextIndex >= 0) textFieldIndex = detectedTextIndex;
      continue;
    }
    const dialogue = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line)?.[1];
    if (dialogue === undefined) continue;
    const fields = splitAssFields(dialogue, textFieldIndex);
    const start = fields[1] ?? "";
    const end = fields[2] ?? "";
    const rawText = fields[textFieldIndex] ?? fields.slice(textFieldIndex).join(",");
    const { startMs, endMs } = parseTimingLine(`${start} --> ${end}`, "ass");
    cues.push({
      startMs,
      endMs,
      text: sanitizeSubtitleText(rawText.replace(/\\N|\\n/g, "\n").replace(/\\h/g, " ").replace(/\{[^}]*\}/g, "")),
    });
  }
  return {
    format,
    encoding,
    cues,
    warnings: ["ASS/SSA 特效和脚本不会执行，仅转换基础 Dialogue 时间轴。"],
  };
}

export function subtitleToWebVtt(parsed: ParsedSubtitle, options: SubtitleWebVttOptions = {}): string {
  const cueSetting = options.position === "top" ? " line:10%" : "";
  const body = parsed.cues.map((cue, index) => [
    cue.id ?? String(index + 1),
    `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}${cueSetting}`,
    cue.text,
  ].join("\n")).join("\n\n");
  return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
}

export function normalizeSubtitleTracks(value: unknown): SubtitleTrack[] {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tracks)
      ? value.tracks
      : [];
  const tracks: SubtitleTrack[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const track = normalizeSubtitleTrack(candidate, tracks.length);
    if (!track || ids.has(track.id)) continue;
    ids.add(track.id);
    tracks.push(track);
    if (tracks.length >= 32) break;
  }
  return tracks;
}

export function normalizeSubtitleTrack(value: unknown, index = 0): SubtitleTrack | null {
  if (!isRecord(value)) return null;
  const url = typeof value.url === "string" && /^(?:https?|blob|data):/i.test(value.url)
    ? value.url
    : undefined;
  const localPath = typeof value.localPath === "string" && value.localPath.length > 0
    ? value.localPath
    : undefined;
  const format = normalizeSubtitleFormat(value.format)
    ?? (url ? subtitleFormatFromName(url) : null)
    ?? (localPath ? subtitleFormatFromName(localPath) : null);
  if (!format || (!url && !localPath)) return null;
  const id = typeof value.id === "string" && value.id.trim().length > 0
    ? value.id.trim()
    : `subtitle-${index + 1}`;
  const label = typeof value.label === "string" && value.label.trim().length > 0
    ? value.label.trim()
    : id;
  const language = typeof value.language === "string" && value.language.trim().length > 0
    ? value.language.trim()
    : "und";
  const headers = isRecord(value.headers)
    ? Object.fromEntries(Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const source = value.source === "source"
    || value.source === "jellyfin"
    || value.source === "local"
    || value.source === "local-proxy"
    || value.source === "fixture"
    ? value.source
    : undefined;
  return {
    id,
    label,
    language,
    format,
    ...(url ? { url } : {}),
    ...(localPath ? { localPath } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    default: value.default === true,
    forced: value.forced === true,
    ...(source ? { source } : {}),
  };
}

export function isRemoteSubtitleTrack(track: SubtitleTrack): track is SubtitleTrack & { url: string } {
  return typeof track.url === "string" && /^https?:/i.test(track.url);
}

export function isLocalProxySubtitleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname === "127.0.0.1"
      && url.pathname.startsWith("/__qx_playback/");
  } catch {
    return false;
  }
}

export function sanitizeSubtitleText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface SubtitleObjectUrlApi {
  createObjectURL(value: Blob): string;
  revokeObjectURL(value: string): void;
}

export class SubtitleObjectUrlRegistry {
  private readonly urls = new Map<string, string>();

  private readonly api: SubtitleObjectUrlApi;

  public constructor(api: SubtitleObjectUrlApi = defaultObjectUrlApi()) {
    this.api = api;
  }

  public create(id: string, value: Blob): string {
    this.revoke(id);
    const url = this.api.createObjectURL(value);
    this.urls.set(id, url);
    return url;
  }

  public revoke(id: string): void {
    const url = this.urls.get(id);
    this.urls.delete(id);
    if (!url) return;
    this.api.revokeObjectURL(url);
  }

  public revokeAll(): void {
    for (const id of [...this.urls.keys()]) this.revoke(id);
  }

  public get size(): number {
    return this.urls.size;
  }
}

function parseTimingLine(line: string, format: "vtt" | "srt" | "ass"): { startMs: number; endMs: number } {
  const match = /^\s*(.*?)\s+-->\s+(.*?)(?:\s+.*)?$/.exec(line);
  if (!match) {
    throw new SubtitleParseError("SUBTITLE_TIMELINE_INVALID", "字幕时间轴格式无效。");
  }
  const startMs = format === "ass" ? parseAssTimestamp(match[1] ?? "") : parseStandardTimestamp(match[1] ?? "", format);
  const endMs = format === "ass" ? parseAssTimestamp(match[2] ?? "") : parseStandardTimestamp(match[2] ?? "", format);
  if (startMs === null || endMs === null || endMs <= startMs) {
    throw new SubtitleParseError("SUBTITLE_TIMELINE_INVALID", "字幕结束时间必须晚于开始时间。");
  }
  return { startMs, endMs };
}

function parseStandardTimestamp(value: string, format: "vtt" | "srt"): number | null {
  const match = /^(\d{1,3}):(\d{2})(?::(\d{2}))?[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const hoursOrMinutes = Number(match[1]);
  const minutesOrSeconds = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  const fraction = Number((match[4] ?? "").padEnd(3, "0"));
  const hours = match[3] === undefined ? 0 : hoursOrMinutes;
  const minutes = match[3] === undefined ? hoursOrMinutes : minutesOrSeconds;
  if (format === "vtt" && match[3] === undefined) {
    return minutes >= 60 || seconds >= 60 ? null : (minutes * 60 + Number(match[2])) * 1000 + fraction;
  }
  if (minutes >= 60 || seconds >= 60 || fraction >= 1000) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction;
}

function parseAssTimestamp(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const centiseconds = Number((match[4] ?? "").padEnd(2, "0"));
  if (minutes >= 60 || seconds >= 60 || centiseconds >= 100) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + centiseconds * 10;
}

function formatVttTimestamp(value: number): string {
  const milliseconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function splitAssFields(value: string, textIndex: number): string[] {
  const fields: string[] = [];
  let remainder = value;
  for (let index = 0; index < textIndex; index += 1) {
    const comma = remainder.indexOf(",");
    if (comma < 0) {
      fields.push(remainder);
      remainder = "";
      continue;
    }
    fields.push(remainder.slice(0, comma));
    remainder = remainder.slice(comma + 1);
  }
  fields.push(remainder);
  return fields;
}

function normalizedLines(value: string): string[] {
  return stripBom(value).replace(/\r\n?/g, "\n").split("\n");
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function tryDecodeForFormat(input: Uint8Array): string | null {
  try {
    return decodeSubtitle(input).text;
  } catch {
    return null;
  }
}

function canDecode(input: Uint8Array, encoding: SubtitleEncoding, fatal: boolean): boolean {
  return decodeWithTextDecoder(input, encoding, fatal) !== null;
}

function decodeWithTextDecoder(
  input: Uint8Array,
  encoding: SubtitleEncoding,
  fatal: boolean,
): string | null {
  try {
    const decoder = new TextDecoder(encoding, { fatal });
    return decoder.decode(input);
  } catch {
    return null;
  }
}

function chineseTextScore(value: string): number {
  return [...value].filter((character) => /[\u3400-\u9fff]/u.test(character)).length;
}

function startsWith(value: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}

function defaultObjectUrlApi(): SubtitleObjectUrlApi {
  const value = globalThis.URL;
  if (typeof value?.createObjectURL !== "function" || typeof value.revokeObjectURL !== "function") {
    return {
      createObjectURL: () => "",
      revokeObjectURL: () => undefined,
    };
  }
  return {
    createObjectURL: (blob) => value.createObjectURL(blob),
    revokeObjectURL: (url) => value.revokeObjectURL(url),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
