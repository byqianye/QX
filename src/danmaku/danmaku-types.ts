export type DanmakuType = "scroll" | "top" | "bottom" | "reverse";
export type DanmakuFormat = "auto" | "json" | "xml" | "items";
export type DanmakuTimelineKind = "vod";

export const DANMAKU_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const DANMAKU_MAX_ITEMS = 100_000;
export const DANMAKU_MAX_TEXT_LENGTH = 500;
export const DANMAKU_MAX_REGEX_LENGTH = 128;

export interface DanmakuItem {
  id: string;
  timeMs: number;
  text: string;
  type: DanmakuType;
  color?: string;
  fontSize?: number;
  source: string;
  userHash?: string;
  rawType?: string;
}

export type DanmakuUiItem = Omit<DanmakuItem, "userHash">;

export interface DanmakuSettings {
  enabled: boolean;
  opacity: number;
  fontSize: number;
  speed: number;
  density: number;
  displayArea: number;
  types: readonly DanmakuType[];
  sources: readonly string[];
  keyword: string;
  regex: string;
  maxActive: number;
  maxPerSecond: number;
  trackCount: number;
}

export interface DanmakuSettingsPatch {
  enabled?: boolean;
  opacity?: number;
  fontSize?: number;
  speed?: number;
  density?: number;
  displayArea?: number;
  types?: readonly DanmakuType[];
  sources?: readonly string[];
  keyword?: string;
  regex?: string;
  maxActive?: number;
  maxPerSecond?: number;
  trackCount?: number;
}

export interface DanmakuLoadInput {
  format?: DanmakuFormat;
  data: unknown;
  source?: string;
  timeline?: DanmakuTimelineKind;
}

export interface DanmakuUiState {
  status: "idle" | "loading" | "ready" | "error";
  settings: DanmakuSettings;
  source: string | null;
  timeline: DanmakuTimelineKind;
  playing: boolean;
  totalCount: number;
  sources: readonly string[];
  items: readonly DanmakuUiItem[];
  currentTimeMs: number;
  generation: number;
  error: { code: string; message: string } | null;
}

export interface DanmakuTimelineUpdate {
  currentTimeMs: number;
  generation: number;
  seeked: boolean;
  playbackRate: number;
  playing: boolean;
}

export type DanmakuErrorCode =
  | "DANMAKU_INVALID_PAYLOAD"
  | "DANMAKU_JSON_INVALID"
  | "DANMAKU_XML_INVALID"
  | "DANMAKU_XML_UNSAFE"
  | "DANMAKU_TOO_LARGE"
  | "DANMAKU_REGEX_TOO_LONG"
  | "DANMAKU_REGEX_UNSAFE"
  | "DANMAKU_REGEX_INVALID"
  | "DANMAKU_CANCELLED"
  | "DANMAKU_DESTROYED";

export interface DanmakuRenderItem extends DanmakuUiItem {
  track: number;
  elapsedMs: number;
  durationMs: number;
  direction: "normal" | "reverse";
}

export class DanmakuError extends Error {
  public readonly code: DanmakuErrorCode;

  public constructor(
    code: DanmakuErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DanmakuError";
    this.code = code;
  }
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: true,
  opacity: 0.86,
  fontSize: 24,
  speed: 1,
  density: 1,
  displayArea: 0.82,
  types: ["scroll", "top", "bottom", "reverse"],
  sources: [],
  keyword: "",
  regex: "",
  maxActive: 120,
  maxPerSecond: 60,
  trackCount: 12,
};

export const EMPTY_DANMAKU_UI_STATE: DanmakuUiState = {
  status: "idle",
  settings: {
    ...DEFAULT_DANMAKU_SETTINGS,
    types: [...DEFAULT_DANMAKU_SETTINGS.types],
    sources: [],
  },
  source: null,
  timeline: "vod",
  playing: false,
  totalCount: 0,
  sources: [],
  items: [],
  currentTimeMs: 0,
  generation: 0,
  error: null,
};

const DANMAKU_TYPES: readonly DanmakuType[] = ["scroll", "top", "bottom", "reverse"];
const SAFE_COLORS = new Set(["white", "black", "red", "yellow", "blue", "green", "cyan", "magenta"]);

export function normalizeDanmakuSettings(value: unknown): DanmakuSettings {
  const record = isRecord(value) ? value : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_DANMAKU_SETTINGS.enabled,
    opacity: clampNumber(record.opacity, 0, 1, DEFAULT_DANMAKU_SETTINGS.opacity),
    fontSize: clampNumber(record.fontSize, 12, 48, DEFAULT_DANMAKU_SETTINGS.fontSize),
    speed: clampNumber(record.speed, 0.25, 4, DEFAULT_DANMAKU_SETTINGS.speed),
    density: clampNumber(record.density, 0, 1, DEFAULT_DANMAKU_SETTINGS.density),
    displayArea: clampNumber(record.displayArea, 0.25, 1, DEFAULT_DANMAKU_SETTINGS.displayArea),
    types: normalizeTypes(record.types, DEFAULT_DANMAKU_SETTINGS.types),
    sources: normalizeSources(record.sources),
    keyword: normalizeFilterText(record.keyword, 128),
    regex: normalizeFilterText(record.regex, DANMAKU_MAX_REGEX_LENGTH),
    maxActive: clampInteger(record.maxActive, 1, 240, DEFAULT_DANMAKU_SETTINGS.maxActive),
    maxPerSecond: clampInteger(record.maxPerSecond, 1, 240, DEFAULT_DANMAKU_SETTINGS.maxPerSecond),
    trackCount: clampInteger(record.trackCount, 1, 64, DEFAULT_DANMAKU_SETTINGS.trackCount),
  };
}

export function mergeDanmakuSettings(
  current: DanmakuSettings,
  patch: DanmakuSettingsPatch,
): DanmakuSettings {
  return normalizeDanmakuSettings({ ...current, ...patch });
}

export function normalizeDanmakuItems(
  values: readonly unknown[],
  source = "user-provided",
): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  for (let index = 0; index < values.length && items.length < DANMAKU_MAX_ITEMS; index += 1) {
    const item = normalizeDanmakuItem(values[index], index, source);
    if (item) items.push(item);
  }
  return items.sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));
}

export function normalizeDanmakuItem(
  value: unknown,
  index = 0,
  defaultSource = "user-provided",
): DanmakuItem | null {
  if (!isRecord(value)) return null;
  const timeMs = timeMsFromRecord(value);
  if (timeMs === null || timeMs < 0) return null;
  const rawText = firstString(value.text, value.content, value.message, value.value);
  if (rawText === null) return null;
  const text = sanitizeDanmakuText(rawText);
  if (text.length === 0) return null;
  const source = normalizeSource(firstString(value.source, value.sourceId) ?? defaultSource);
  const type = normalizeDanmakuType(value.type ?? value.mode ?? value.position);
  const color = normalizeDanmakuColor(value.color ?? value.colour);
  const fontSize = optionalFontSize(value.fontSize ?? value.font_size ?? value.size);
  const userHash = normalizeUserHash(value.userHash ?? value.user_hash);
  const rawType = type.rawType;
  return {
    id: normalizeId(value.id, `${source}-${Math.floor(timeMs)}-${index}`),
    timeMs: Math.floor(timeMs),
    text,
    type: type.type,
    ...(color ? { color } : {}),
    ...(fontSize === undefined ? {} : { fontSize }),
    source,
    ...(userHash ? { userHash } : {}),
    ...(rawType ? { rawType } : {}),
  };
}

export function parseDanmakuPayload(
  data: unknown,
  format: DanmakuFormat = "auto",
  source = "user-provided",
): DanmakuItem[] {
  assertPayloadSize(data);
  if (format === "xml" || (format === "auto" && typeof data === "string" && looksLikeXml(data))) {
    return parseDanmakuXml(String(data), source);
  }
  if (format === "items" || Array.isArray(data)) {
    if (!Array.isArray(data)) throw new DanmakuError("DANMAKU_INVALID_PAYLOAD", "弹幕 items 必须是数组。");
    return normalizeDanmakuItems(data, source);
  }
  if (typeof data === "string") {
    try {
      return parseDanmakuJson(JSON.parse(data) as unknown, source);
    } catch (error) {
      if (error instanceof DanmakuError) throw error;
      throw new DanmakuError("DANMAKU_JSON_INVALID", "弹幕 JSON 无法解析。", { cause: error });
    }
  }
  return parseDanmakuJson(data, source);
}

export function parseDanmakuJson(value: unknown, source = "user-provided"): DanmakuItem[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : isRecord(value) && Array.isArray(value.danmaku)
        ? value.danmaku
        : null;
  if (!values) throw new DanmakuError("DANMAKU_JSON_INVALID", "弹幕 JSON 必须是数组或包含 items 的对象。");
  if (values.length > DANMAKU_MAX_ITEMS) throw new DanmakuError("DANMAKU_TOO_LARGE", "弹幕条目数量超过限制。");
  return normalizeDanmakuItems(values, source);
}

export function parseDanmakuXml(value: string, source = "user-provided"): DanmakuItem[] {
  if (/<\!\s*(?:DOCTYPE|ENTITY)\b/i.test(value) || /<\s*(?:script|style|svg)\b/i.test(value)) {
    throw new DanmakuError("DANMAKU_XML_UNSAFE", "弹幕 XML 包含不允许的外部实体或可执行内容。");
  }
  const matches = [
    ...matchXmlElements(value, "d"),
    ...matchXmlElements(value, "danmaku"),
    ...matchXmlElements(value, "item"),
  ];
  if (matches.length > DANMAKU_MAX_ITEMS) throw new DanmakuError("DANMAKU_TOO_LARGE", "弹幕条目数量超过限制。");
  const items: DanmakuItem[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const attributes = parseXmlAttributes(match.attributes);
    const p = typeof attributes.p === "string" ? attributes.p.split(",") : [];
    const timeMs = p.length > 0
      ? parseSecondsMs(p[0])
      : attributes.timeMs !== undefined
        ? finiteNumber(attributes.timeMs)
        : parseTimeValue(attributes.time);
    if (timeMs === null || timeMs < 0) continue;
    const text = sanitizeDanmakuText(decodeXmlEntities(match.text));
    if (!text) continue;
    const typeValue = attributes.type ?? p[1];
    const type = normalizeDanmakuType(typeValue);
    const color = normalizeDanmakuColor(attributes.color ?? colorFromBilibiliValue(p[3]));
    const fontSize = optionalFontSize(attributes.fontSize ?? attributes.font_size ?? p[2]);
    const itemSource = normalizeSource(attributes.source ?? source);
    const userHash = normalizeUserHash(attributes.userHash ?? attributes.user_hash ?? p[6]);
    const rawType = type.rawType;
    items.push({
      id: normalizeId(attributes.id, `${itemSource}-${Math.floor(timeMs)}-${index}`),
      timeMs: Math.floor(timeMs),
      text,
      type: type.type,
      ...(color ? { color } : {}),
      ...(fontSize === undefined ? {} : { fontSize }),
      source: itemSource,
      ...(userHash ? { userHash } : {}),
      ...(rawType ? { rawType } : {}),
    });
  }
  return items.sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));
}

export function sanitizeDanmakuText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<\s*\/?\s*[a-z][^>]*>/gi, "")
    .replace(/\s+$/g, "")
    .slice(0, DANMAKU_MAX_TEXT_LENGTH);
}

export function escapeDanmakuText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function normalizeDanmakuType(value: unknown): { type: DanmakuType; rawType?: string } {
  const raw = value === undefined || value === null ? "scroll" : String(value).trim().toLowerCase();
  const type = raw === "1" || raw === "scroll" || raw === "right-to-left" ? "scroll"
    : raw === "4" || raw === "bottom" ? "bottom"
      : raw === "5" || raw === "top" ? "top"
        : raw === "6" || raw === "reverse" || raw === "left-to-right" ? "reverse"
          : "scroll";
  return raw === type || raw === "1" || raw === "4" || raw === "5" || raw === "6"
    ? { type }
    : { type, rawType: raw };
}

export function filterDanmaku(
  items: readonly DanmakuItem[],
  settings: Pick<DanmakuSettings, "keyword" | "regex" | "types" | "sources">,
  maxEvaluated = 5_000,
): DanmakuItem[] {
  const regex = compileDanmakuRegex(settings.regex);
  const types = new Set(settings.types);
  const sources = new Set(settings.sources.map((source) => normalizeSource(source)));
  const keyword = settings.keyword.trim().toLocaleLowerCase();
  const result: DanmakuItem[] = [];
  let evaluated = 0;
  for (const item of items) {
    if (evaluated >= Math.max(1, Math.floor(maxEvaluated))) break;
    evaluated += 1;
    if (!types.has(item.type)) continue;
    if (sources.size > 0 && !sources.has(normalizeSource(item.source))) continue;
    if (keyword && !item.text.toLocaleLowerCase().includes(keyword)) continue;
    if (regex && !regex.test(item.text.slice(0, DANMAKU_MAX_TEXT_LENGTH))) continue;
    result.push(item);
  }
  return result;
}

export function compileDanmakuRegex(pattern: string): RegExp | null {
  const value = pattern.trim();
  if (!value) return null;
  if (value.length > DANMAKU_MAX_REGEX_LENGTH) {
    throw new DanmakuError("DANMAKU_REGEX_TOO_LONG", "弹幕正则长度超过限制。");
  }
  if (/(?:\([^)]*[+*][^)]*\)|\.\*)[+*]/.test(value) || /\([^)]*\+[^)]*\+/.test(value)) {
    throw new DanmakuError("DANMAKU_REGEX_UNSAFE", "弹幕正则包含高风险重复结构。");
  }
  try {
    return new RegExp(value, "iu");
  } catch (error) {
    throw new DanmakuError("DANMAKU_REGEX_INVALID", "弹幕正则格式无效。", { cause: error });
  }
}

export function durationForDanmaku(type: DanmakuType, speed: number): number {
  const normalizedSpeed = clampNumber(speed, 0.25, 4, 1);
  return Math.round((type === "top" || type === "bottom" ? 4_000 : 8_000) / normalizedSpeed);
}

export function buildDanmakuRenderItems(
  items: readonly DanmakuItem[],
  currentTimeMs: number,
  settings: DanmakuSettings,
): DanmakuRenderItem[] {
  if (!settings.enabled) return [];
  const current = Math.max(0, Number.isFinite(currentTimeMs) ? currentTimeMs : 0);
  const filtered = filterDanmaku(items, settings, Math.max(settings.maxActive * 8, 500));
  const perSecond = new Map<number, number>();
  const trackAvailableAt = Array.from({ length: settings.trackCount }, () => -Infinity);
  const result: DanmakuRenderItem[] = [];
  for (const item of filtered) {
    const elapsedMs = current - item.timeMs;
    const durationMs = durationForDanmaku(item.type, settings.speed);
    if (elapsedMs < 0 || elapsedMs > durationMs) continue;
    const bucket = Math.floor(item.timeMs / 1_000);
    const count = perSecond.get(bucket) ?? 0;
    if (count >= settings.maxPerSecond) continue;
    perSecond.set(bucket, count + 1);
    if (settings.density < 1 && stableSample(item.id) > settings.density) continue;
    const track = findTrack(trackAvailableAt, item.timeMs);
    if (track < 0) continue;
    trackAvailableAt[track] = item.timeMs + durationMs;
    result.push({
      ...toPublicDanmakuItem(item),
      track,
      elapsedMs,
      durationMs,
      direction: item.type === "reverse" ? "reverse" : "normal",
    });
    if (result.length >= settings.maxActive) break;
  }
  return result;
}

export function publicDanmakuItem(item: DanmakuItem): DanmakuUiItem {
  return toPublicDanmakuItem(item);
}

export function safeDanmakuSource(value: string): string {
  const source = value.trim();
  if (!source) return "user-provided";
  if (source.startsWith("fixture") || source.startsWith("inline:")) return source.slice(0, 64);
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/…`;
  } catch {
    // A source identifier is not necessarily a URL.
  }
  if (/[\\/]/.test(source)) return "local file";
  return source.slice(0, 64);
}

export class DanmakuTimeline {
  private currentTimeMs = 0;
  private generation = 0;
  private playbackRate = 1;
  private playing = false;
  private lastTimeMs: number | null = null;

  public sync(currentTimeMs: number, eventType?: string): DanmakuTimelineUpdate {
    const next = Math.max(0, Number.isFinite(currentTimeMs) ? currentTimeMs : 0);
    const seeked = eventType === "seek"
      || (this.lastTimeMs !== null && Math.abs(next - this.lastTimeMs) > 2_000);
    if (seeked) this.generation += 1;
    if (eventType === "user-pause" || eventType === "pause" || eventType === "completion" || eventType === "stopped") {
      this.playing = false;
    } else if (eventType === "play" || eventType === "playing" || eventType === "resume") {
      this.playing = true;
    }
    this.currentTimeMs = next;
    this.lastTimeMs = next;
    return this.snapshot(seeked);
  }

  public setPlaybackRate(value: number): DanmakuTimelineUpdate {
    this.playbackRate = clampNumber(value, 0.25, 4, 1);
    return this.snapshot(false);
  }

  public setPlaying(playing: boolean): DanmakuTimelineUpdate {
    this.playing = playing;
    return this.snapshot(false);
  }

  public reset(): DanmakuTimelineUpdate {
    this.currentTimeMs = 0;
    this.lastTimeMs = null;
    this.generation += 1;
    this.playing = false;
    return this.snapshot(true);
  }

  public snapshot(seeked = false): DanmakuTimelineUpdate {
    return {
      currentTimeMs: this.currentTimeMs,
      generation: this.generation,
      seeked,
      playbackRate: this.playbackRate,
      playing: this.playing,
    };
  }
}

function toPublicDanmakuItem(item: DanmakuItem): DanmakuUiItem {
  const { userHash: _userHash, ...safeItem } = item;
  return { ...safeItem, source: safeDanmakuSource(item.source) };
}

function matchXmlElements(value: string, name: string): Array<{ attributes: string; text: string }> {
  const expression = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "gi");
  const result: Array<{ attributes: string; text: string }> = [];
  for (const match of value.matchAll(expression)) {
    result.push({ attributes: match[1] ?? "", text: match[2] ?? "" });
  }
  return result;
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const expression = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of value.matchAll(expression)) {
    const key = match[1]?.trim();
    if (!key) continue;
    attributes[key] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const code = normalized.startsWith("#x") ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function colorFromBilibiliValue(value: string | undefined): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffff) return undefined;
  return `#${number.toString(16).padStart(6, "0")}`;
}

function timeMsFromRecord(value: Record<string, unknown>): number | null {
  const direct = finiteNumber(value.timeMs ?? value.timestampMs);
  if (direct !== null) return direct;
  return parseTimeValue(value.time ?? value.timestamp);
}

function parseTimeValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1_000;
  if (typeof value !== "string") return null;
  return parseSecondsMs(value);
}

function parseSecondsMs(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(trimmed);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = Number((match[4] ?? "").padEnd(3, "0"));
  if (minutes >= 60 || seconds >= 60) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + fraction;
}

function normalizeDanmakuColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (/^#[\da-f]{3}(?:[\da-f]{3}|[\da-f]{5})?$/i.test(normalized)) return normalized;
  return SAFE_COLORS.has(normalized) ? normalized : undefined;
}

function optionalFontSize(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === null ? undefined : clampNumber(number, 12, 48, 24);
}

function normalizeUserHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

function normalizeDanmakuTypeValue(value: unknown): string {
  return value === undefined || value === null ? "scroll" : String(value).trim().toLowerCase();
}

function normalizeSource(value: string): string {
  return value.trim().slice(0, 128) || "user-provided";
}

function normalizeTypes(value: unknown, fallback: readonly DanmakuType[]): readonly DanmakuType[] {
  if (!Array.isArray(value)) return [...fallback];
  const types = value.filter((item): item is DanmakuType => typeof item === "string" && DANMAKU_TYPES.includes(item as DanmakuType));
  return types.length > 0 ? [...new Set(types)] : [];
}

function normalizeSources(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map(normalizeSource))].slice(0, 32);
}

function normalizeFilterText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function assertPayloadSize(value: unknown): void {
  let size = 0;
  try {
    size = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
  } catch (error) {
    throw new DanmakuError("DANMAKU_INVALID_PAYLOAD", "弹幕内容无法读取。", { cause: error });
  }
  if (size > DANMAKU_MAX_PAYLOAD_BYTES) throw new DanmakuError("DANMAKU_TOO_LARGE", "弹幕内容超过大小限制。");
}

function looksLikeXml(value: string): boolean {
  return /^\s*</.test(value);
}

function normalizeId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 128)
    : fallback;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string") return value;
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.min(max, Math.max(min, number));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.floor(clampNumber(value, min, max, fallback));
}

function findTrack(availableAt: readonly number[], itemTimeMs: number): number {
  return availableAt.findIndex((available) => available <= itemTimeMs);
}

function stableSample(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 0xffffffff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
