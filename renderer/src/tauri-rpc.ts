import { BACKEND_RPC_VERSION, createBackendRequest, isBackendResponse, type AppSnapshot } from "./contracts.js";

let sequence = 0;
const sessionId = crypto.randomUUID();

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function requestAppSnapshot(): Promise<AppSnapshot> {
  if (!isTauriRuntime()) throw new Error("Tauri RPC is unavailable outside the Tauri runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  const request = createBackendRequest({}, crypto.randomUUID(), sessionId, ++sequence);
  const response: unknown = await invoke("backend_app_snapshot", { request });
  if (!isBackendResponse<AppSnapshot>(response)) {
    throw new Error(`Invalid Tauri response for ${BACKEND_RPC_VERSION}`);
  }
  return response.payload;
}
