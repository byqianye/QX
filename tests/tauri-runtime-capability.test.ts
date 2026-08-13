import { describe, expect, it } from "vitest";

import { createBackendRequest, isBackendResponse, type RuntimeCapabilitySnapshot } from "../renderer/src/contracts.js";

describe("Tauri runtime capability contract", () => {
  it("preserves an unavailable reason instead of claiming a QuickJS runtime", () => {
    const payload = { api: "js:fixture.mjs", scriptBytes: 128, allowedOrigins: ["https://example.test"] };
    const runtime: RuntimeCapabilitySnapshot = {
      runtime: "quickjs-sidecar",
      supported: false,
      reasonCode: "quickjs_sidecar_not_installed",
      capabilities: { home: false, category: false, search: false, detail: false, player: false },
    };
    const response = { ...createBackendRequest(payload, "request-1", "session-1", 1), ok: true as const, payload: runtime };
    expect(isBackendResponse<RuntimeCapabilitySnapshot>(response)).toBe(true);
    expect(response.payload.reasonCode).toBe("quickjs_sidecar_not_installed");
  });
});
