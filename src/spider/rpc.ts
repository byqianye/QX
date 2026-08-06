import { randomUUID } from "node:crypto";

export const spiderMethods = [
  "init",
  "home",
  "homeVod",
  "category",
  "detail",
  "search",
  "player",
  "live",
  "localProxy",
  "destroy",
] as const;

export type SpiderMethod = (typeof spiderMethods)[number];
export type SpiderEngine = "java" | "quickjs" | "python" | "http" | "unknown";

export interface SpiderRequest {
  id: string;
  method: SpiderMethod;
  params: Record<string, unknown>;
}

export interface SpiderResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export function routeSpiderApi(api: string): SpiderEngine {
  const normalized = api.trim().toLowerCase();
  if (normalized.startsWith("csp_")) return "java";
  if (normalized.startsWith("js:") || looksLikeFile(normalized, ".js")) return "quickjs";
  if (normalized.startsWith("py:") || looksLikeFile(normalized, ".py")) return "python";
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return "http";
  return "unknown";
}

export function createSpiderRequest(
  method: SpiderMethod,
  params: Record<string, unknown>,
  id: string = randomUUID(),
): SpiderRequest {
  if (!spiderMethods.includes(method)) {
    throw new Error(`Unsupported spider method: ${String(method)}`);
  }
  return { id, method, params };
}

export function parseSpiderLine(line: string): SpiderRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Spider RPC line is not valid JSON", { cause: error });
  }

  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    throw new Error("Spider RPC request must contain string id and method");
  }
  if (!spiderMethods.includes(value.method as SpiderMethod)) {
    throw new Error(`Unsupported spider method: ${value.method}`);
  }
  if (!isRecord(value.params)) {
    throw new Error("Spider RPC request must contain an object params field");
  }

  return {
    id: value.id,
    method: value.method as SpiderMethod,
    params: value.params,
  };
}

export function parseSpiderResponseLine(line: string): SpiderResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Spider RPC response line is not valid JSON", { cause: error });
  }

  if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    throw new Error("Spider RPC response must contain string id and boolean ok");
  }

  const response: SpiderResponse = { id: value.id, ok: value.ok };
  if (value.ok) {
    if (Object.prototype.hasOwnProperty.call(value, "result")) response.result = value.result;
    return response;
  }

  if (
    !isRecord(value.error) ||
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string"
  ) {
    throw new Error("Spider RPC error response must contain code and message");
  }
  response.error = { code: value.error.code, message: value.error.message };
  return response;
}

function looksLikeFile(value: string, extension: string): boolean {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  return withoutQuery.endsWith(extension);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
