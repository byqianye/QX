const SENSITIVE_KEY_PATTERN = /(?:cookie|authorization|x-emby-token|token|password|secret|credential|api[_-]?key|localproxy|playback[_-]?url|sniff[_-]?url|mpv[_-]?ipc|ipc[_-]?(?:address|endpoint|url))/i;
const SENSITIVE_QUERY_PATTERN = /([?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|password|secret)=)[^&#\s]*/gi;
const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const HEADER_VALUE_PATTERN = /\b(?:Cookie|Authorization|X-Emby-Token)\s*[:=]\s*[^;,\r\n]+/gi;
const PLAYBACK_PROXY_PATH_PATTERN = /(__qx_playback\/)[^/?#\s]+/gi;

export function sanitizePersistedValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePersistedValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, sanitizePersistedValue(entryValue, entryKey)]),
    );
  }
  return undefined;
}

export function serializePersistedJson(value: unknown, key?: string): string {
  const json = JSON.stringify(sanitizePersistedValue(value, key));
  if (json === undefined) throw new Error("JSON value is undefined");
  return json;
}

export function sanitizePersistedJsonText(value: string): string {
  try {
    return serializePersistedJson(JSON.parse(value));
  } catch {
    return redactSensitiveText(value);
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_QUERY_PATTERN, "$1[redacted]")
    .replace(AUTHORIZATION_PATTERN, "$1 [redacted]")
    .replace(HEADER_VALUE_PATTERN, (match) => `${match.split(/[:=]/, 1)[0]}: [redacted]`)
    .replace(PLAYBACK_PROXY_PATH_PATTERN, "$1[redacted]");
}
