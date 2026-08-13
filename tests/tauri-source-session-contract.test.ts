import { describe, expect, it } from "vitest";

import {
  BACKEND_RPC_VERSION,
  createBackendRequest,
  type SourceSessionPayload,
  type SourceSessionResult,
  isBackendResponse,
} from "../renderer/src/contracts.js";

describe("Tauri SourceSession contract", () => {
  it("keeps CMS lifecycle fields versioned and capability-scoped", () => {
    const payload: SourceSessionPayload = {
      action: "open",
      sessionId: "session-1",
      sourceId: "config-1",
      siteKey: "cms",
      api: "https://example.test/api.php",
      siteType: 4,
      ext: "fixture",
      timeoutMs: 5_000,
      headers: { Referer: "https://example.test/" },
    };
    const response: SourceSessionResult = {
      session: {
        sessionId: "session-1",
        sourceId: "config-1",
        siteKey: "cms",
        api: payload.api ?? "",
        siteType: 4,
        state: "ready",
        capabilities: {
          home: true,
          category: true,
          search: true,
          detail: true,
          playback: true,
          localProxy: false,
          filters: true,
          pagination: true,
          engine: "http",
        },
      },
      cancelled: false,
    };
    const envelope = {
      ...createBackendRequest(payload, "request-1", "renderer-1", 1),
      ok: true as const,
      payload: response,
    };
    expect(envelope.version).toBe(BACKEND_RPC_VERSION);
    expect(isBackendResponse<SourceSessionResult>(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("Authorization");
  });
});
