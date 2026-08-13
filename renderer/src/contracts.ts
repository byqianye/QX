export const BACKEND_RPC_VERSION = "qx.backend.v1" as const;
export const BACKEND_EVENT_VERSION = "qx.event.v1" as const;

export type BackendErrorCategory =
  | "InvalidConfig"
  | "UnsupportedRuntime"
  | "SourceUnavailable"
  | "ComponentMissing"
  | "ComponentUntrusted"
  | "UnsupportedDrm"
  | "PlaybackFailed";

export interface RequestMeta {
  version: typeof BACKEND_RPC_VERSION;
  requestId: string;
  sessionId: string;
  sequence: number;
}

export interface BackendRequest<TPayload = Record<string, unknown>> extends RequestMeta {
  payload: TPayload;
}

export interface BackendResponse<TPayload> extends RequestMeta {
  ok: true;
  payload: TPayload;
}

export interface BackendError {
  category: BackendErrorCategory;
  reasonCode: string;
  retryable: boolean;
  diagnosticId: string;
  safeDetails: Record<string, string>;
}

export interface BackendFailure extends RequestMeta {
  ok: false;
  error: BackendError;
}

export interface BackendEvent<TPayload = Record<string, unknown>> extends Omit<RequestMeta, "version"> {
  version: typeof BACKEND_EVENT_VERSION;
  event: string;
  payload: TPayload;
}

export interface AppSnapshot {
  appName: "QX影视";
  backend: "tauri";
  rpcVersion: typeof BACKEND_RPC_VERSION;
  dataDirectory: string;
  databasePath: string;
}

export interface ConfigCatalogPayload {
  source: string;
  sourceKind: "url" | "file" | "json";
  raw: string;
}

export interface ConfigCatalogSnapshot {
  schemaVersion: "v1";
  source: string;
  sourceKind: ConfigCatalogPayload["sourceKind"];
  versionHash: string;
  siteCount: number;
  usedCache: boolean;
  validVersionCount: number;
}

const BACKEND_ERROR_CATEGORIES = new Set<BackendErrorCategory>([
  "InvalidConfig",
  "UnsupportedRuntime",
  "SourceUnavailable",
  "ComponentMissing",
  "ComponentUntrusted",
  "UnsupportedDrm",
  "PlaybackFailed",
]);

export function createBackendRequest<TPayload>(
  payload: TPayload,
  requestId: string,
  sessionId: string,
  sequence: number,
): BackendRequest<TPayload> {
  return {
    version: BACKEND_RPC_VERSION,
    requestId,
    sessionId,
    sequence,
    payload,
  };
}

export function isBackendResponse<TPayload>(value: unknown): value is BackendResponse<TPayload> {
  if (!isRecord(value)) return false;
  return value.ok === true
    && value.version === BACKEND_RPC_VERSION
    && typeof value.requestId === "string"
    && typeof value.sessionId === "string"
    && typeof value.sequence === "number"
    && "payload" in value;
}

export function isBackendFailure(value: unknown): value is BackendFailure {
  if (!isRecord(value)) return false;
  return value.ok === false
    && value.version === BACKEND_RPC_VERSION
    && typeof value.requestId === "string"
    && typeof value.sessionId === "string"
    && typeof value.sequence === "number"
    && isBackendError(value.error);
}

function isBackendError(value: unknown): value is BackendError {
  if (!isRecord(value) || typeof value.category !== "string") return false;
  return BACKEND_ERROR_CATEGORIES.has(value.category as BackendErrorCategory)
    && typeof value.reasonCode === "string"
    && typeof value.retryable === "boolean"
    && typeof value.diagnosticId === "string"
    && isRecord(value.safeDetails)
    && Object.values(value.safeDetails).every((detail) => typeof detail === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
