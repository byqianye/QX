import { describe, expect, it } from "vitest";

import { createBackendRequest, isBackendResponse, type BusinessDataSnapshot } from "../renderer/src/contracts.js";

describe("Tauri business data contract", () => {
  it("keeps restart-restorable records free of credential fields", () => {
    const payload = {
      action: "upsert" as const,
      entity: "history",
      id: "history-1",
      sourceId: "source-1",
      value: { title: "Movie", position: 12 },
    };
    const snapshot: BusinessDataSnapshot = {
      schemaVersion: "v1",
      entity: "history",
      id: "history-1",
      found: true,
      value: payload.value,
    };
    const response = { ...createBackendRequest(payload, "request-1", "session-1", 1), ok: true as const, payload: snapshot };
    expect(isBackendResponse<BusinessDataSnapshot>(response)).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/Authorization|Cookie|token|temporaryUrl/i);
  });
});
