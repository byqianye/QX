import type { RendererEnvelope } from "./state.js";

export class RendererApi {
  public async getState(): Promise<RendererEnvelope> {
    return this.request("/api/state");
  }

  public async post(path: string, body: Record<string, unknown> = {}): Promise<RendererEnvelope> {
    return this.request(path, body);
  }

  private async request(path: string, body?: Record<string, unknown>): Promise<RendererEnvelope> {
    try {
      const response = await fetch(path, body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
      const value: unknown = await response.json();
      if (!isRecord(value)) {
        throw new Error(`Renderer request returned invalid JSON: ${path}`);
      }
      return {
        ...(isRecord(value.import) ? { import: value.import } : {}),
        ...(isRecord(value.state) ? { state: value.state } : {}),
        ...(isRecord(value.persistence) ? { persistence: value.persistence } : {}),
        ...(isRecord(value.live) ? { live: value.live } : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
      } as unknown as RendererEnvelope;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Renderer request")) throw error;
      throw new Error(`Renderer request failed: ${path}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
