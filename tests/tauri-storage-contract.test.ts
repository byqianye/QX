import { describe, expect, it } from "vitest";

import {
  BACKEND_RPC_VERSION,
  createBackendRequest,
  isBackendResponse,
  type ConfigCatalogSnapshot,
} from "../renderer/src/contracts.js";

describe("Tauri storage contract", () => {
  it("accepts a v1 config catalog response without exposing raw credentials", () => {
    const value = {
      version: BACKEND_RPC_VERSION,
      requestId: "req-1",
      sessionId: "session-1",
      sequence: 1,
      ok: true,
      payload: {
        schemaVersion: "v1",
        source: "inline:fixture",
        sourceKind: "json",
        versionHash: "abc123",
        siteCount: 1,
        usedCache: false,
        validVersionCount: 1,
      } satisfies ConfigCatalogSnapshot,
    };

    expect(isBackendResponse<ConfigCatalogSnapshot>(value)).toBe(true);
    expect(JSON.stringify(value)).not.toContain("Authorization");
    expect(createBackendRequest({ source: "inline:fixture", sourceKind: "json", raw: "{}" }, "req-1", "session-1", 1))
      .toMatchObject({ version: BACKEND_RPC_VERSION, requestId: "req-1", sequence: 1 });
  });
});
