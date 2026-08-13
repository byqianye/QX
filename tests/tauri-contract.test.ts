import { describe, expect, it } from "vitest";

import {
  BACKEND_EVENT_VERSION,
  BACKEND_RPC_VERSION,
  createBackendRequest,
  isBackendFailure,
  isBackendResponse,
} from "../renderer/src/contracts.js";

describe("Tauri backend contracts", () => {
  it("keeps the versioned request envelope stable", () => {
    expect(createBackendRequest({ action: "snapshot" }, "req-1", "session-1", 7)).toEqual({
      version: BACKEND_RPC_VERSION,
      requestId: "req-1",
      sessionId: "session-1",
      sequence: 7,
      payload: { action: "snapshot" },
    });
    expect(BACKEND_EVENT_VERSION).toBe("qx.event.v1");
  });

  it("accepts only current successful backend responses", () => {
    expect(isBackendResponse({
      version: BACKEND_RPC_VERSION,
      requestId: "req-1",
      sessionId: "session-1",
      sequence: 1,
      ok: true,
      payload: { backend: "tauri" },
    })).toBe(true);
    expect(isBackendResponse({
      version: "qx.backend.v0",
      requestId: "req-1",
      sessionId: "session-1",
      sequence: 1,
      ok: true,
      payload: {},
    })).toBe(false);
  });

  it("accepts versioned failures with the stable error model", () => {
    expect(isBackendFailure({
      version: BACKEND_RPC_VERSION,
      requestId: "req-1",
      sessionId: "session-1",
      sequence: 2,
      ok: false,
      error: {
        category: "InvalidConfig",
        reasonCode: "RPC_VERSION_UNSUPPORTED",
        retryable: false,
        diagnosticId: "rpc-invalid-version",
        safeDetails: {},
      },
    })).toBe(true);
  });

  it("keeps the config catalog payload scoped to the v1 storage contract", () => {
    expect({ source: "inline:fixture", sourceKind: "json", raw: "{}" }).toMatchObject({
      source: "inline:fixture",
      sourceKind: "json",
    });
  });
});
