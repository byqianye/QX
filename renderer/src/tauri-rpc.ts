import {
  BACKEND_RPC_VERSION,
  createBackendRequest,
  isBackendFailure,
  isBackendResponse,
  type AppSnapshot,
  type ConfigCatalogPayload,
  type ConfigCatalogSnapshot,
  type SourceSessionPayload,
  type SourceSessionResult,
  type RuntimeCapabilityPayload,
  type RuntimeCapabilitySnapshot,
  type PlaybackProxyPayload,
  type PlaybackProxySnapshot,
  type BusinessDataPayload,
  type BusinessDataSnapshot,
  type ComponentManagerPayload,
  type ComponentManagerSnapshot,
} from "./contracts.js";

let sequence = 0;
const sessionId = crypto.randomUUID();

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function requestAppSnapshot(): Promise<AppSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest({}, crypto.randomUUID(), sessionId, ++sequence);
  let response: unknown;
  try {
    response = await invoke("backend_app_snapshot", { request });
  } catch (error: unknown) {
    if (isBackendFailure(error)) {
      throw new Error(`${error.error.category}: ${error.error.reasonCode}`);
    }
    throw error;
  }
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<AppSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function ingestConfigCatalog(payload: ConfigCatalogPayload): Promise<ConfigCatalogSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  let response: unknown;
  try {
    response = await invoke("backend_config_catalog", { request });
  } catch (error: unknown) {
    if (isBackendFailure(error)) {
      throw new Error(`${error.error.category}: ${error.error.reasonCode}`);
    }
    throw error;
  }
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<ConfigCatalogSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestSourceSession(payload: SourceSessionPayload): Promise<SourceSessionResult> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  let response: unknown;
  try {
    response = await invoke("backend_source_session", { request });
  } catch (error: unknown) {
    if (isBackendFailure(error)) {
      throw new Error(`${error.error.category}: ${error.error.reasonCode}`);
    }
    throw error;
  }
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<SourceSessionResult>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestRuntimeCapability(payload: RuntimeCapabilityPayload): Promise<RuntimeCapabilitySnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_runtime_capability", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<RuntimeCapabilitySnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestPlaybackProxy(payload: PlaybackProxyPayload): Promise<PlaybackProxySnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_playback_proxy", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<PlaybackProxySnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestBusinessData(payload: BusinessDataPayload): Promise<BusinessDataSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_business_data", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<BusinessDataSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestComponentManager(payload: ComponentManagerPayload): Promise<ComponentManagerSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_component_manager", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<ComponentManagerSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}
