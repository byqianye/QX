import type { AppError, AppErrorSource, RendererError } from "./state.js";

const SENSITIVE_KEY = /authorization|cookie|token|api[-_]?key|password|secret|path|url|query|vod.?id/i;
const REDACTED = "[已脱敏]";

const TITLES: Record<string, string> = {
  IMPORT_FETCH_ERROR: "配置读取失败",
  IMPORT_READ_ERROR: "配置文件读取失败",
  IMPORT_INVALID_CONFIG: "配置解析失败",
  IMPORT_TRUST_ERROR: "信任确认失败",
  UNSUPPORTED_SPIDER_ENGINE: "来源暂不支持",
  SPIDER_TIMEOUT: "Spider 响应超时",
  SPIDER_NOT_CONNECTED: "Spider 尚未连接",
  SPIDER_SITE_NOT_FOUND: "Spider 站点不存在",
  SPIDER_RPC_ERROR: "Spider 返回错误",
  PLAYBACK_UNAVAILABLE: "播放源不可用",
  PLAYBACK_PROXY_REQUIRED: "播放需要受控代理",
  PLAYBACK_FORMAT_INVALID: "播放信息格式无效",
  PLAYBACK_PROXY_TIMEOUT: "播放代理超时",
  PARSE_UNAVAILABLE: "解析器不可用",
  PARSE_TIMEOUT: "解析器超时",
  PARSE_CANCELLED: "解析已取消",
  PARSE_CYCLE_DETECTED: "解析链检测到循环",
  PARSE_RESPONSE_TOO_LARGE: "解析响应过大",
  PARSE_ORIGIN_BLOCKED: "解析地址被拦截",
  PARSE_PROTOCOL_BLOCKED: "解析协议不受支持",
  HLS_ERROR: "HLS 播放失败",
  HTML_VIDEO_ERROR: "媒体播放失败",
  HTML_VIDEO_PLAY_ERROR: "媒体播放失败",
  MPV_UNAVAILABLE: "mpv backend unavailable",
  MPV_TIMEOUT: "mpv playback timeout",
  MPV_PROCESS_EXITED: "mpv process exited",
  MPV_IPC_ERROR: "mpv IPC error",
  MPV_PROXY_REQUIRED: "mpv requires the LocalProxy URL",
  MPV_SUBTITLE_FORMAT_UNSUPPORTED: "mpv 只接受已转换的字幕格式",
  STATE_PERSISTENCE_CORRUPT: "桌面状态已恢复",
  STATE_PERSISTENCE_WRITE_FAILED: "桌面状态未保存",
  RENDERER_REQUEST_ERROR: "界面请求失败",
};

export function toAppError(
  input: RendererError | null | undefined,
  fallbackSource?: AppErrorSource,
): AppError | null {
  if (!input || typeof input.code !== "string" || typeof input.message !== "string") return null;
  const code = normalizeCode(input.code);
  const source = isAppErrorSource(input.source) ? input.source : fallbackSource ?? sourceForCode(code);
  const safeDetails = sanitizeDetails(input.safeDetails);
  return {
    code,
    title: sanitizeText(typeof input.title === "string" ? input.title : TITLES[code] ?? titleForSource(source)),
    message: sanitizeText(input.message) || "发生了未命名错误。",
    source,
    retryable: input.retryable ?? defaultRetryable(code),
    diagnosticId: isDiagnosticId(input.diagnosticId) ? input.diagnosticId : createDiagnosticId(),
    timestamp: isTimestamp(input.timestamp) ? input.timestamp : new Date().toISOString(),
    safeDetails,
    ...(typeof input.causeCode === "string" && input.causeCode.trim()
      ? { causeCode: normalizeCode(input.causeCode) }
      : {}),
  };
}

export function formatDiagnostic(error: AppError): string {
  const details = Object.entries(error.safeDetails)
    .map(([key, value]) => `${key}：${value}`)
    .join("\n");
  return [
    "QX 影视诊断",
    `标题：${error.title}`,
    `错误码：${error.code}`,
    `诊断 ID：${error.diagnosticId}`,
    `来源：${error.source}`,
    `时间：${error.timestamp}`,
    `说明：${error.message}`,
    error.causeCode ? `原因码：${error.causeCode}` : "",
    details,
  ].filter(Boolean).join("\n");
}

export function sourceForCode(code: string): AppErrorSource {
  if (code.startsWith("IMPORT_") || code === "UNSUPPORTED_SPIDER_ENGINE") return "config";
  if (code.includes("TRUST")) return "trust";
  if (code.startsWith("STATE_PERSISTENCE_")) return "persistence";
  if (code.startsWith("JELLYFIN_")) return "source";
  if (code.startsWith("JVM_SPIDER_")) return "spider";
  if (code.startsWith("JVM_ARTIFACT") || code.startsWith("JVM_") || code.startsWith("JAVA_") || code.startsWith("JDK_") || code.startsWith("JRE_")) return "java";
  if (code.startsWith("ELECTRON_") || code.startsWith("UI_") || code.startsWith("APP_") || code.startsWith("E2E_")) return "electron";
  if (code.startsWith("CLEANUP_") || code.startsWith("RESOURCE_CLEANUP")) return "cleanup";
  if (code.startsWith("PLAYBACK_PROXY_")) return "proxy";
  if (code.startsWith("PARSE_")) return "player";
  if (code.startsWith("PLAYBACK_") || code.startsWith("MEDIA_") || code.startsWith("VIDEO_") || code.startsWith("HLS_") || code.startsWith("MPV_")) return "player";
  if (code.startsWith("SPIDER_") || code.startsWith("JVM_SPIDER_") || code.includes("RPC")) return "spider";
  return "renderer";
}

function titleForSource(source: AppErrorSource): string {
  return {
    config: "配置操作失败",
    trust: "信任确认失败",
    spider: "Spider 操作失败",
    rpc: "通信请求失败",
    search: "搜索失败",
    detail: "详情读取失败",
    player: "播放器操作失败",
    proxy: "播放代理失败",
    video: "媒体播放失败",
    hls: "HLS 播放失败",
    java: "Java 运行时不可用",
    electron: "桌面窗口操作失败",
    persistence: "桌面状态操作失败",
    cleanup: "资源清理失败",
    source: "媒体来源操作失败",
    renderer: "操作失败",
  }[source];
}

function defaultRetryable(code: string): boolean {
  if (code === "PLAYBACK_UNAVAILABLE"
    || code === "PLAYBACK_PROXY_REQUIRED"
    || code === "PLAYBACK_FORMAT_INVALID"
    || code === "PLAYBACK_NOT_LOADED"
    || code === "MPV_UNAVAILABLE"
    || code === "MPV_PROXY_REQUIRED"
    || code === "MPV_SUBTITLE_FORMAT_UNSUPPORTED"
    || code === "IMPORT_INVALID_CONFIG"
    || code === "IMPORT_READ_ERROR"
    || code === "IMPORT_INPUT_ERROR"
    || code === "UNSUPPORTED_SPIDER_ENGINE"
    || code.endsWith("_NOT_FOUND")
    || code.includes("INVALID")
    || code.includes("FORBIDDEN")
    || code.includes("BLOCKED")) return false;
  return code === "RENDERER_REQUEST_ERROR"
    || code.startsWith("IMPORT_FETCH")
    || code.startsWith("SPIDER_")
    || code.startsWith("PLAYBACK_PROXY_TIMEOUT")
    || code.startsWith("PARSE_TIMEOUT")
    || code.startsWith("PARSE_ERROR")
    || code.startsWith("PLAYBACK_UPSTREAM")
    || code.startsWith("MEDIA_")
    || code.startsWith("VIDEO_")
    || code.startsWith("HLS_")
    || code.startsWith("MPV_TIMEOUT")
    || code.startsWith("MPV_PROCESS_EXITED")
    || code.startsWith("MPV_IPC_ERROR")
    || code.startsWith("JELLYFIN_REQUEST")
    || code.startsWith("JELLYFIN_CONNECTION");
}

function sanitizeDetails(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .slice(0, 12)
      .map(([key, entry]) => [sanitizeText(key), sanitizeText(String(entry))]),
  );
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b(?:authorization|cookie|token|api[-_]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi, `${REDACTED}`)
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[地址已脱敏]")
    .replace(/[A-Za-z]:\\[^\r\n\s]+/g, "[本机路径已脱敏]")
    .replace(/(?:^|[?&\s])(?:token|api[-_]?key|vod[_-]?id)=[^\s&]+/gi, REDACTED)
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeCode(code: string): string {
  const normalized = code.trim().replace(/[^A-Za-z0-9_.-]/g, "_").toUpperCase();
  return normalized || "UNKNOWN_ERROR";
}

function createDiagnosticId(): string {
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDiagnosticId(value: string | undefined): value is string {
  return typeof value === "string" && /^diag-[a-z0-9-]{8,80}$/i.test(value);
}

function isTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isAppErrorSource(value: string | undefined): value is AppErrorSource {
  return value === "config"
    || value === "trust"
    || value === "spider"
    || value === "rpc"
    || value === "search"
    || value === "detail"
    || value === "player"
    || value === "proxy"
    || value === "video"
    || value === "hls"
    || value === "java"
    || value === "electron"
    || value === "persistence"
    || value === "cleanup"
    || value === "source"
    || value === "renderer";
}
