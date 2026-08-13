import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface ProductionLoggerOptions {
  directory: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
}

export class ProductionLogger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  public constructor(options: ProductionLoggerOptions) {
    this.filePath = join(options.directory, options.fileName ?? "main.log");
    this.maxBytes = Math.max(1_024, Math.floor(options.maxBytes ?? 1_024 * 1_024));
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 3));
  }

  public info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("INFO", event, fields);
  }

  public error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.write("ERROR", event, {
      ...fields,
      error: serializeError(error),
    });
  }

  private write(level: "INFO" | "ERROR", event: string, fields: Record<string, unknown>): void {
    try {
      mkdirSync(join(this.filePath, ".."), { recursive: true });
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        level,
        event,
        ...sanitizeRecord(fields),
      })}\n`;
      rotateIfNeeded(this.filePath, line.length, this.maxBytes, this.maxFiles);
      appendFileSync(this.filePath, line, "utf8");
    } catch {
      // Logging must never make application startup or shutdown fail.
    }
  }
}

function rotateIfNeeded(path: string, incomingBytes: number, maxBytes: number, maxFiles: number): void {
  if (!existsSync(path) || statSync(path).size + incomingBytes <= maxBytes) return;
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const older = `${path}.${index}`;
    const newer = `${path}.${index + 1}`;
    if (existsSync(older)) renameSync(older, newer);
  }
  renameSync(path, `${path}.1`);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitize(value);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

function sanitize(value: unknown, key = ""): unknown {
  if (/(?:cookie|token|authorization|password|secret|credential|api[_-]?key)/iu.test(key)) return "<redacted>";
  if (typeof value === "string") {
    return value
      .replace(/((?:cookie|token|authorization|password|secret|api[_-]?key)=)[^&\s]+/giu, "$1<redacted>")
      .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => redactUrl(url));
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]));
  }
  return value;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/[redacted]`;
  } catch {
    return "[redacted-url]";
  }
}
