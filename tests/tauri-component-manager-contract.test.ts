import { describe, expect, it } from "vitest";

import {
  createBackendRequest,
  isBackendResponse,
  type ComponentManagerSnapshot,
} from "../renderer/src/contracts.js";

describe("Tauri component manager contract", () => {
  it("represents verification and activation without exposing a process handle", () => {
    const payload = {
      action: "verify" as const,
      componentId: "quickjs",
      manifestJson: '{"version":1,"components":[]}',
      signatureBase64: "signature",
      publicKeyBase64: "public-key",
    };
    const snapshot: ComponentManagerSnapshot = {
      state: "verified",
      componentId: "quickjs",
      version: "1",
      verified: true,
    };
    const response = {
      ...createBackendRequest(payload, "request-1", "session-1", 1),
      ok: true as const,
      payload: snapshot,
    };
    expect(isBackendResponse<ComponentManagerSnapshot>(response)).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/ipc|processHandle|secret/i);
  });
});
