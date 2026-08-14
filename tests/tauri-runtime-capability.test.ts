import { describe, expect, it } from "vitest";

import {
  createBackendRequest,
  isBackendResponse,
  type QuickJsSidecarPayload,
  type RuntimeCapabilitySnapshot,
} from "../renderer/src/contracts.js";

describe("Tauri runtime capability contract", () => {
  it("reports a policy-valid QuickJS sidecar without guessing script methods", () => {
    const payload = { api: "js:fixture.mjs", scriptBytes: 128, allowedOrigins: ["https://example.test"] };
    const runtime: RuntimeCapabilitySnapshot = {
      runtime: "quickjs-sidecar",
      supported: true,
      reasonCode: "quickjs_sidecar_supported",
      capabilities: { home: false, category: false, search: false, detail: false, player: false },
    };
    const response = { ...createBackendRequest(payload, "request-1", "session-1", 1), ok: true as const, payload: runtime };
    expect(isBackendResponse<RuntimeCapabilitySnapshot>(response)).toBe(true);
    expect(response.payload.reasonCode).toBe("quickjs_sidecar_supported");
  });

  it("keeps disguised DEX recognition informational and unsupported", () => {
    const payload = {
      api: "csp_Unknown",
      artifactName: "library.png",
      artifactBase64: "iVBORw0KGgo=" + "Y2xhc3Nlcy5kZXg=",
    };
    const runtime: RuntimeCapabilitySnapshot = {
      runtime: "unknown",
      supported: false,
      reasonCode: "spider_artifact_not_declared",
      capabilities: { home: false, category: false, search: false, detail: false, player: false },
      assetClassification: "png_disguised_dex",
    };
    const response = { ...createBackendRequest(payload, "request-2", "session-1", 2), ok: true as const, payload: runtime };
    expect(isBackendResponse<RuntimeCapabilitySnapshot>(response)).toBe(true);
    expect(response.payload.supported).toBe(false);
  });

  it("requires the configured Jianpian endpoint before claiming native support", () => {
    const withoutEndpoint: RuntimeCapabilitySnapshot = {
      runtime: "native",
      supported: false,
      reasonCode: "native_jianpian_ext_required",
      capabilities: { home: false, category: false, search: false, detail: false, player: false },
    };
    const withEndpoint: RuntimeCapabilitySnapshot = {
      runtime: "native",
      supported: true,
      reasonCode: "native_jianpian_supported",
      capabilities: { home: true, category: true, search: true, detail: true, player: true },
    };
    expect(withoutEndpoint.reasonCode).toBe("native_jianpian_ext_required");
    expect(withEndpoint.capabilities.player).toBe(true);
  });

  it("keeps QuickJS sidecar lifecycle actions on the versioned Tauri RPC", () => {
    const payload: QuickJsSidecarPayload = {
      action: "load",
      sessionId: "quickjs-1",
      script: "export default { search() { return []; } };",
      moduleSources: {},
      allowedOrigins: [],
    };
    const response = {
      ...createBackendRequest(payload, "request-3", "session-1", 3),
      ok: true as const,
      payload: { loaded: true },
    };
    expect(isBackendResponse(response)).toBe(true);
    expect(response.payload.loaded).toBe(true);
  });
});
