import type { RendererEnvelope } from "./state.js";
import { isTauriRuntime } from "./tauri-rpc.js";
import { TauriRendererApi } from "./tauri-renderer-api.js";
import type { RendererRequestOptions } from "./request-task.js";

export class RendererApi {
  private readonly tauri = isTauriRuntime() ? new TauriRendererApi() : null;
  private readonly inFlight = new Map<string, Promise<RendererEnvelope>>();

  public async getState(options: RendererRequestOptions = {}): Promise<RendererEnvelope> {
    if (this.tauri) return this.tauri.getState(options);
    return this.deduplicate("/api/state", undefined, () => this.request("/api/state"));
  }

  public async post(path: string, body: Record<string, unknown> = {}, options: RendererRequestOptions = {}): Promise<RendererEnvelope> {
    if (this.tauri) return this.tauri.post(path, body, options);
    if (options.signal) return this.request(path, body, options.signal);
    const key = `${path}\n${JSON.stringify(body)}`;
    return this.deduplicate(key, body, () => this.request(path, body));
  }

  private deduplicate(
    key: string,
    _body: Record<string, unknown> | undefined,
    call: () => Promise<RendererEnvelope>,
  ): Promise<RendererEnvelope> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = call().finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async request(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<RendererEnvelope> {
    try {
      const response = await fetch(path, body === undefined
        ? { signal: signal ?? null }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: signal ?? null,
          });
      const value: unknown = await response.json();
      if (!isRecord(value)) {
        throw new Error(`Renderer request returned invalid JSON: ${path}`);
      }
      return {
        ...(isRecord(value.import) ? { import: value.import } : {}),
        ...(isRecord(value.state) ? { state: value.state } : {}),
        ...(isRecord(value.persistence) ? { persistence: value.persistence } : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
      } as unknown as RendererEnvelope;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Error && error.message.startsWith("Renderer request")) throw error;
      throw new Error(`Renderer request failed: ${path}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
