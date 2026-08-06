import type { RendererState } from "./state.js";

export type PlaybackDebugPhase =
  | "session"
  | "resolve"
  | "parse"
  | "rules"
  | "sniff"
  | "proxy"
  | "backend"
  | "buffer"
  | "error"
  | "fallback"
  | string;

export interface PlaybackEvent {
  timestamp: string;
  sessionId: string;
  phase: PlaybackDebugPhase;
  type: string;
  source: string;
  durationMs?: number;
  safeDetails: Record<string, string>;
}

export interface PlaybackEventInput {
  timestamp?: string;
  sessionId: string;
  phase: PlaybackDebugPhase;
  type: string;
  source: string;
  durationMs?: number;
  safeDetails?: Record<string, unknown>;
}

export interface PlaybackDebugSnapshot {
  source: string;
  engine: string;
  site: string;
  playbackSession: string;
  line: string;
  episode: string;
  playerContent: string;
  parse: string;
  rules: string;
  sniff: string;
  localProxy: string;
  backend: string;
  startupMs: number | null;
  buffering: string;
  error: string;
  fallback: string;
  capability: string;
  events: readonly PlaybackEvent[];
}

export interface PlaybackDebugTimelineOptions {
  maxEvents?: number;
  now?: () => Date;
}

interface DebugSignature {
  pending: string | null;
  sessionId: string;
  sourcePresent: boolean;
  sourceHasHeaders: boolean;
  sourceParse: number | null;
  parseStatus: string;
  parserId: string;
  playerStatus: string;
  errorCode: string;
  backend: string;
  rulesApplied: boolean;
  sniffUsed: boolean;
  attemptCount: number;
  healthEventSequence: number;
  fallbackStatus: string;
  fallbackAttempts: number;
}

const DEFAULT_MAX_EVENTS = 200;
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|proxy.?url|user.?dir|path|stack|url|vod.?id|playback.?id|session.?id|detail.?id|^id$/i;
const SENSITIVE_VALUE = /(?:authorization|cookie|token|api[-_]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const URL_VALUE = /\b(?:https?|file):\/\/[^\s"'<>]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\r\n\s]+/g;
const HOST_VALUE = /(?:^|\s)(?:localhost|127\.0\.0\.1|\[[0-9a-f:]+\]|[a-z0-9-]+\.[a-z]{2,})(?::\d+)?(?:\b|\/)/i;

export class PlaybackDebugTimeline {
  private readonly maxEvents: number;
  private readonly now: () => Date;
  private readonly eventsValue: PlaybackEvent[] = [];
  private readonly pendingStarts = new Map<string, number>();
  private previousSignature: DebugSignature | null = null;
  private startupMsValue: number | null = null;
  private bufferingCount = 0;
  private bufferingDurationMs = 0;
  private fallbackUsed = false;
  private backendValue = "未报告";
  private errorValue = "";

  private observeEvent(event: PlaybackEvent): void {
    if (event.phase === "buffer") {
      if (event.type.endsWith("start")) this.bufferingCount += 1;
      if (event.type.endsWith("end")) this.bufferingDurationMs += event.durationMs ?? 0;
    }
    if (event.phase === "fallback") this.fallbackUsed = true;
  }

  public constructor(options: PlaybackDebugTimelineOptions = {}) {
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    this.now = options.now ?? (() => new Date());
  }

  public record(input: PlaybackEventInput): PlaybackEvent {
    const event: PlaybackEvent = {
      timestamp: safeTimestamp(input.timestamp ?? this.now().toISOString()),
      sessionId: safeIdentifier(input.sessionId, "session"),
      phase: safePhase(input.phase),
      type: safeToken(input.type, "event"),
      source: safeEventSource(input.source),
      ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
        ? { durationMs: Math.round(input.durationMs) }
        : {}),
      safeDetails: sanitizeDetails(input.safeDetails ?? {}),
    };
    this.eventsValue.push(event);
    while (this.eventsValue.length > this.maxEvents) this.eventsValue.shift();
    this.observeEvent(event);
    return cloneEvent(event);
  }

  public recordState(state: RendererState, pending: string | null, atMs = this.now().getTime()): void {
    const current = signatureFor(state, pending);
    const previous = this.previousSignature;
    const sessionId = current.sessionId;

    if (!previous) {
      this.record({
        sessionId,
        phase: "session",
        type: "state.snapshot",
        source: "renderer",
        safeDetails: { status: state.spider.status, page: state.browse.page },
      });
      if (current.sourcePresent) this.record({ sessionId, phase: "resolve", type: "playerContent.available", source: "playerContent" });
      if (current.parseStatus !== "idle") {
        this.record({ sessionId, phase: "parse", type: `parse.${current.parseStatus}`, source: "parse", safeDetails: { parser: current.parserId } });
      }
      if (current.rulesApplied) this.record({ sessionId, phase: "rules", type: "rules.applied", source: "rules" });
      if (current.sourcePresent) {
        this.record({
          sessionId,
          phase: "proxy",
          type: current.sourceHasHeaders ? "localProxy.required" : "localProxy.bypassed",
          source: "localProxy",
        });
      }
      if (current.sniffUsed) this.record({ sessionId, phase: "sniff", type: "sniff.used", source: "sniff" });
      if (current.sniffUsed) this.fallbackUsed = true;
      if (current.backend !== "未报告") {
        this.backendValue = current.backend;
        this.record({ sessionId, phase: "backend", type: "backend.selected", source: "backend" });
      }
      if (current.playerStatus !== "idle") {
        this.record({ sessionId, phase: "backend", type: `backend.${current.playerStatus}`, source: "backend" });
      }
      if (current.errorCode) this.record({ sessionId, phase: "error", type: `error.${current.errorCode}`, source: "error" });
    }

    if (pending && pending !== previous?.pending) {
      const operation = safeToken(pending, "operation");
      this.pendingStarts.set(operation, atMs);
      this.record({ sessionId, phase: operation === "player" ? "resolve" : "session", type: `${operation}.start`, source: operation });
    } else if (!pending && previous?.pending) {
      const operation = safeToken(previous.pending, "operation");
      const startedAt = this.pendingStarts.get(operation);
      this.pendingStarts.delete(operation);
      if (operation === "player" && this.startupMsValue === null && startedAt !== undefined && state.playback.player.status === "playing") {
        this.startupMsValue = Math.max(0, atMs - startedAt);
      }
      this.record({
        sessionId,
        phase: operation === "player" ? "resolve" : "session",
        type: `${operation}.complete`,
        source: operation,
        ...(startedAt !== undefined ? { durationMs: Math.max(0, atMs - startedAt) } : {}),
      });
    }

    if (previous && current.sessionId !== previous.sessionId) {
      this.record({ sessionId, phase: "session", type: "session.changed", source: "session" });
    }
    if (previous && current.sourcePresent !== previous.sourcePresent) {
      this.record({
        sessionId,
        phase: "resolve",
        type: current.sourcePresent ? "playerContent.available" : "playerContent.cleared",
        source: "playerContent",
      });
    }
    if (previous && (current.parseStatus !== previous.parseStatus || current.parserId !== previous.parserId)) {
      this.record({ sessionId, phase: "parse", type: `parse.${current.parseStatus}`, source: "parse", safeDetails: { parser: current.parserId } });
    }
    if (current.sourcePresent && (!previous || current.rulesApplied !== previous.rulesApplied) && current.rulesApplied) {
      this.record({ sessionId, phase: "rules", type: "rules.applied", source: "rules" });
    }
    if (current.sourcePresent && (!previous || current.sourceHasHeaders !== previous.sourceHasHeaders)) {
      this.record({
        sessionId,
        phase: "proxy",
        type: current.sourceHasHeaders ? "localProxy.required" : "localProxy.bypassed",
        source: "localProxy",
      });
    }
    if (current.sniffUsed && (!previous || !previous.sniffUsed)) {
      this.fallbackUsed = true;
      this.record({ sessionId, phase: "sniff", type: "sniff.used", source: "sniff" });
    }
    if (current.backend !== "未报告" && (!previous || current.backend !== previous.backend)) {
      this.backendValue = current.backend;
      this.record({ sessionId, phase: "backend", type: "backend.selected", source: "backend" });
    }
    if (previous && current.playerStatus !== previous.playerStatus && current.playerStatus !== "idle") {
      this.record({ sessionId, phase: "backend", type: `backend.${current.playerStatus}`, source: "backend" });
      if (current.playerStatus === "playing" && this.startupMsValue === null) {
        const startedAt = this.pendingStarts.get("player");
        if (startedAt !== undefined) this.startupMsValue = Math.max(0, atMs - startedAt);
      }
    }
    if (current.attemptCount > Math.max(1, previous?.attemptCount ?? 0)) {
      this.fallbackUsed = true;
      this.record({ sessionId, phase: "fallback", type: "fallback.parser", source: "fallback" });
    }
    const healthEvents = state.playback.health.events.filter((event) => event.sequence > (previous?.healthEventSequence ?? 0));
    for (const event of healthEvents) {
      this.record({
        sessionId,
        phase: "health",
        type: `health.${event.type}`,
        source: "health",
        safeDetails: event.safeDetails,
      });
    }
    if (current.fallbackStatus !== "idle" && current.fallbackStatus !== "disabled") this.fallbackUsed = true;
    if (current.fallbackStatus !== "idle"
      && current.fallbackStatus !== "disabled"
      && (!previous
        || current.fallbackStatus !== previous.fallbackStatus
        || current.fallbackAttempts !== previous.fallbackAttempts)) {
      this.fallbackUsed = true;
      this.record({
        sessionId,
        phase: "fallback",
        type: `fallback.${current.fallbackStatus}`,
        source: "fallback",
        safeDetails: {
          attempts: current.fallbackAttempts,
          next: state.playback.fallback.next?.label ?? "无",
        },
      });
    }
    if (current.errorCode && current.errorCode !== previous?.errorCode) {
      this.errorValue = safeError(state);
      this.record({ sessionId, phase: "error", type: `error.${current.errorCode}`, source: "error" });
    }

    this.previousSignature = current;
    if (this.startupMsValue === null && current.playerStatus === "playing") {
      const startedAt = this.pendingStarts.get("player");
      if (startedAt !== undefined) this.startupMsValue = Math.max(0, atMs - startedAt);
    }
  }

  public snapshot(state: RendererState): PlaybackDebugSnapshot {
    const signature = signatureFor(state, this.previousSignature?.pending ?? null);
    const playerSource = state.playback.player.source;
    const parse = state.playback.player.parse;
    const session = state.playback.session;
    const selectedLine = state.detail.playbackCatalog?.lines.find((line) => line.index === state.detail.playbackSelection?.lineIndex);
    const selectedEpisode = selectedLine?.episodes.find((episode) => episode.index === state.detail.playbackSelection?.episodeIndex);
    const error = this.errorValue || safeError(state);

    return {
      source: safeLabel(state.spider.source, "未连接"),
      engine: safeLabel(state.spider.api, "未报告"),
      site: safeLabel(state.import.selectedSiteKey ?? state.import.selectedApi, "未选择"),
      playbackSession: safeIdentifier(session?.id ?? signature.sessionId, "session"),
      line: safeLabel(session?.lineName ?? selectedLine?.name, "未选择"),
      episode: safeLabel(session?.episodeName ?? selectedEpisode?.name, "未选择"),
      playerContent: playerSource ? "已返回媒体地址" : "未返回媒体地址",
      parse: parse ? `${parse.status}${parse.parserId ? ` · ${safeLabel(parse.parserId, "未报告")}` : ""}` : "未进入解析",
      rules: playerSource?.parse === 0 ? "已应用" : "未报告",
      sniff: this.eventsValue.some((event) => event.type === "sniff.used") ? "已使用" : "未使用",
      localProxy: playerSource
        ? Object.keys(playerSource.headers).length > 0 ? "已要求" : "未要求"
        : "未报告",
      backend: this.backendValue !== "未报告" ? this.backendValue : signature.backend,
      startupMs: this.startupMsValue,
      buffering: `${this.bufferingCount} 次 · ${this.bufferingDurationMs} ms`,
      error,
      fallback: this.fallbackUsed ? "已发生" : "未发生",
      capability: `${state.detail.canPlay ? "可播放" : "不可播放"} · ${state.spider.sidecarRunning ? "引擎在线" : "引擎未启动"}`,
      events: this.eventsValue.map(cloneEvent),
    };
  }
}

export function formatPlaybackDebugJson(snapshot: PlaybackDebugSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function formatPlaybackDebugText(snapshot: PlaybackDebugSnapshot): string {
  const lines = [
    "QX 影视播放调试",
    `Source: ${snapshot.source}`,
    `Engine: ${snapshot.engine}`,
    `Site: ${snapshot.site}`,
    `Playback Session: ${snapshot.playbackSession}`,
    `线路: ${snapshot.line}`,
    `剧集: ${snapshot.episode}`,
    `playerContent: ${snapshot.playerContent}`,
    `parse: ${snapshot.parse}`,
    `Rules: ${snapshot.rules}`,
    `sniff: ${snapshot.sniff}`,
    `LocalProxy: ${snapshot.localProxy}`,
    `后端: ${snapshot.backend}`,
    `起播时间: ${snapshot.startupMs === null ? "未报告" : `${snapshot.startupMs} ms`}`,
    `缓冲: ${snapshot.buffering}`,
    `错误: ${snapshot.error || "无"}`,
    `回退: ${snapshot.fallback}`,
    `capability: ${snapshot.capability}`,
    "",
    "Timeline:",
    ...snapshot.events.map((event) => {
      const duration = event.durationMs === undefined ? "" : ` (${event.durationMs} ms)`;
      const details = Object.entries(event.safeDetails).map(([key, value]) => `${key}=${value}`).join(", ");
      return `${event.timestamp} [${event.phase}] ${event.type} source=${event.source}${duration}${details ? ` ${details}` : ""}`;
    }),
  ];
  return lines.join("\n");
}

function signatureFor(state: RendererState, pending: string | null): DebugSignature {
  const source = state.playback.player.source;
  const parse = state.playback.player.parse;
  const sessionId = state.playback.session?.id ?? "unknown";
  return {
    pending,
    sessionId,
    sourcePresent: source !== null,
    sourceHasHeaders: source !== null && Object.keys(source.headers).length > 0,
    sourceParse: source?.parse ?? null,
    parseStatus: parse?.status ?? "idle",
    parserId: parse?.parserId ?? "",
    playerStatus: state.playback.player.status,
    errorCode: state.error.error?.code ?? state.playback.player.error?.code ?? "",
    backend: inferBackend(state),
    rulesApplied: source?.parse === 0,
    sniffUsed: parse?.parserId === "isolated-sniffer",
    attemptCount: parse?.attempts.length ?? 0,
    healthEventSequence: state.playback.health.events.at(-1)?.sequence ?? 0,
    fallbackStatus: state.playback.fallback.status,
    fallbackAttempts: state.playback.fallback.attempts,
  };
}

function inferBackend(state: RendererState): string {
  const code = state.playback.player.error?.code ?? state.error.error?.code ?? "";
  if (code.startsWith("MPV_")) return "mpv";
  if (code.startsWith("HLS_")) return "hls.js";
  if (code.startsWith("HTML_VIDEO_")) return "HTMLVideo";
  const url = state.playback.player.source?.url ?? "";
  return /\.m3u8(?:$|[?#])/i.test(url) ? "HTMLVideo/HLS" : state.playback.player.source ? "HTMLVideo" : "未报告";
}

function safeError(state: RendererState): string {
  const error = state.error.error ?? state.playback.player.error;
  if (!error) return "";
  const message = sanitizeText(error.message);
  return message ? `${safeToken(error.code, "ERROR")}: ${message}` : safeToken(error.code, "ERROR");
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .slice(0, 12)
      .map(([key, value]) => [safeToken(key, "detail"), sanitizeText(String(value))] as const)
      .filter((entry): entry is readonly [string, string] => entry[1].length > 0),
  );
}

function sanitizeText(value: string): string {
  return value
    .replace(SENSITIVE_VALUE, "[已脱敏]")
    .replace(URL_VALUE, "[地址已脱敏]")
    .replace(WINDOWS_PATH, "[本机路径已脱敏]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 180);
}

function safeLabel(value: string | null | undefined, fallback: string): string {
  const text = value?.trim() ?? "";
  URL_VALUE.lastIndex = 0;
  WINDOWS_PATH.lastIndex = 0;
  if (!text) return fallback;
  const hasUrl = URL_VALUE.test(text);
  URL_VALUE.lastIndex = 0;
  const hasPath = WINDOWS_PATH.test(text) || /^\/{1,2}|^[A-Za-z]:\\/.test(text);
  WINDOWS_PATH.lastIndex = 0;
  if (hasUrl || hasPath || HOST_VALUE.test(text)) return "[已脱敏]";
  return sanitizeText(text) || fallback;
}

function safeEventSource(value: string): string {
  const text = value.trim();
  URL_VALUE.lastIndex = 0;
  WINDOWS_PATH.lastIndex = 0;
  if (URL_VALUE.test(text) || WINDOWS_PATH.test(text) || HOST_VALUE.test(text) || /^\/{1,2}|^[A-Za-z]:\\/.test(text)) {
    URL_VALUE.lastIndex = 0;
    WINDOWS_PATH.lastIndex = 0;
    return "[已脱敏]";
  }
  URL_VALUE.lastIndex = 0;
  WINDOWS_PATH.lastIndex = 0;
  return safeToken(text, "unknown");
}

function safeIdentifier(value: string, prefix: string): string {
  const text = value.trim();
  if (!text || text === "unknown") return `${prefix}-未建立`;
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function safeToken(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 64);
  return normalized || fallback;
}

function safePhase(value: string): string {
  return safeToken(value, "event");
}

function safeTimestamp(value: string): string {
  return Number.isNaN(Date.parse(value)) ? new Date(0).toISOString() : new Date(value).toISOString();
}

function cloneEvent(event: PlaybackEvent): PlaybackEvent {
  return {
    ...event,
    safeDetails: { ...event.safeDetails },
  };
}
