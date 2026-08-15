import {
  BACKEND_RPC_VERSION,
  createBackendRequest,
  isBackendFailure,
  isBackendResponse,
  type AppSnapshot,
  type ConfigCatalogPayload,
  type ConfigCatalogSnapshot,
  type ConfigCatalogMaintenancePayload,
  type ConfigCatalogHistorySnapshot,
  type SourceSessionPayload,
  type SourceSessionResult,
  type PlaybackSourceResolvePayload,
  type PlaybackFallbackPayload,
  type PlaybackFallbackSnapshot,
  type RuntimeCapabilityPayload,
  type RuntimeCapabilitySnapshot,
  type PlaybackProxyPayload,
  type PlaybackProxySnapshot,
  type PlaybackStartPayload,
  type PlaybackStartResult,
  type WebviewSnifferPayload,
  type WebviewSnifferSnapshot,
  type MpvPayload,
  type MpvSnapshot,
  type BusinessDataPayload,
  type BusinessDataSnapshot,
  type BusinessFeaturePayload,
  type BusinessFeatureSnapshot,
  type LivePayload,
  type LiveSnapshot,
  type EpgPayload,
  type EpgSnapshot,
  type CastPayload,
  type CastSnapshot,
  type PushPayload,
  type PushSnapshot,
  type DesktopServicePayload,
  type DesktopServiceSnapshot,
  type PlayerWindowPayload,
  type PlayerWindowSnapshot,
  type ComponentManagerPayload,
  type ComponentManagerSnapshot,
  type QuickJsSidecarPayload,
  type QuickJsSessionPayload,
  type QuickJsSessionResult,
} from "./contracts.js";
import type { PlaybackSourceResolution } from "../../src/desktop/playback-source-resolver.js";

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

export function requestConfigCatalogMaintenance(
  payload: Extract<ConfigCatalogMaintenancePayload, { action: "history" }>,
): Promise<ConfigCatalogHistorySnapshot>;
export function requestConfigCatalogMaintenance(
  payload: Extract<ConfigCatalogMaintenancePayload, { action: "activate" }>,
): Promise<ConfigCatalogSnapshot>;
export async function requestConfigCatalogMaintenance(
  payload: ConfigCatalogMaintenancePayload,
): Promise<ConfigCatalogHistorySnapshot | ConfigCatalogSnapshot> {
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
  if (!isBackendResponse<ConfigCatalogHistorySnapshot | ConfigCatalogSnapshot>(response)) {
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

export async function requestPlaybackSources(payload: PlaybackSourceResolvePayload): Promise<PlaybackSourceResolution> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  let response: unknown;
  try {
    response = await invoke("backend_playback_sources", { request });
  } catch (error: unknown) {
    if (isBackendFailure(error)) {
      throw new Error(`${error.error.category}: ${error.error.reasonCode}`);
    }
    throw error;
  }
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<PlaybackSourceResolution>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestPlaybackFallback(payload: PlaybackFallbackPayload): Promise<PlaybackFallbackSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_playback_fallback", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<PlaybackFallbackSnapshot>(response)) {
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

export async function requestQuickJsSidecar(payload: QuickJsSidecarPayload): Promise<unknown> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_quickjs_sidecar", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<unknown>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestQuickJsSession(payload: QuickJsSessionPayload): Promise<QuickJsSessionResult> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_quickjs_session", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<QuickJsSessionResult>(response)) {
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

export async function requestPlaybackStart(payload: PlaybackStartPayload): Promise<PlaybackStartResult> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_playback_start", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<PlaybackStartResult>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestWebviewSniffer(payload: WebviewSnifferPayload): Promise<WebviewSnifferSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_webview_sniffer", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<WebviewSnifferSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestMpv(payload: MpvPayload): Promise<MpvSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_mpv", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<MpvSnapshot>(response)) {
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

export async function requestBusinessFeature(payload: BusinessFeaturePayload): Promise<BusinessFeatureSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_business_features", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<BusinessFeatureSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestLive(payload: LivePayload): Promise<LiveSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_live", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<LiveSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestEpg(payload: EpgPayload): Promise<EpgSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response: unknown = await invoke("backend_epg", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<EpgSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestCast(payload: CastPayload): Promise<CastSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_cast", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<CastSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestPush(payload: PushPayload): Promise<PushSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response = await invoke("backend_push", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<PushSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}

export async function requestDesktopService(payload: DesktopServicePayload): Promise<DesktopServiceSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response: unknown = await invoke("backend_desktop_services", { request });
  if (isBackendFailure(response)) {
    throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  }
  if (!isBackendResponse<Record<string, unknown>>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return { schemaVersion: "v1", state: response.payload };
}

export async function requestPlayerWindow(payload: PlayerWindowPayload): Promise<PlayerWindowSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest(payload, crypto.randomUUID(), sessionId, ++sequence);
  const response: unknown = await invoke("backend_player_window", { request });
  if (isBackendFailure(response)) throw new Error(`${response.error.category}: ${response.error.reasonCode}`);
  if (!isBackendResponse<PlayerWindowSnapshot>(response)) throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
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
