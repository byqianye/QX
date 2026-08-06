import { describe, expect, it } from "vitest";

import { formatDiagnostic, toAppError } from "../renderer/src/error.js";

describe("unified app diagnostics", () => {
  it.each([
    ["IMPORT_FETCH_ERROR", "config", true],
    ["IMPORT_INVALID_CONFIG", "config", false],
    ["SPIDER_TIMEOUT", "spider", true],
    ["PLAYBACK_UNAVAILABLE", "player", false],
    ["PLAYBACK_PROXY_REQUIRED", "proxy", false],
    ["PLAYBACK_PROXY_TIMEOUT", "proxy", true],
    ["PLAYBACK_UPSTREAM_ERROR", "player", true],
    ["JAVA_RUNTIME_NOT_FOUND", "java", false],
    ["UI_SERVER_START_ERROR", "electron", false],
    ["STATE_PERSISTENCE_WRITE_FAILED", "persistence", false],
    ["CLEANUP_ERROR", "cleanup", false],
  ])("maps %s to a stable source and retry policy", (code, source, retryable) => {
    const error = toAppError({ code, message: "操作失败" });
    expect(error).toMatchObject({ code, source, retryable });
    expect(error?.title).toBeTruthy();
    expect(error?.diagnosticId).toMatch(/^diag-/);
    expect(error?.timestamp).toBeTruthy();
  });

  it("redacts sensitive values in the user message and copied diagnostic", () => {
    const error = toAppError({
      code: "JELLYFIN_REQUEST_FAILED",
      message: "GET https://private.example/api/items?token=secret failed; Authorization: Bearer abc; C:\\Users\\qiany\\private.json",
      safeDetails: { operation: "detail", url: "https://private.example/secret", token: "secret" },
      causeCode: "UPSTREAM_500",
    });
    const diagnostic = formatDiagnostic(error!);

    expect(error).toMatchObject({ source: "source", causeCode: "UPSTREAM_500" });
    expect(error?.message).not.toContain("private.example");
    expect(error?.message).not.toContain("secret");
    expect(diagnostic).toContain("JELLYFIN_REQUEST_FAILED");
    expect(diagnostic).toContain("原因码：UPSTREAM_500");
    expect(diagnostic).not.toContain("private.example");
    expect(diagnostic).not.toContain("Bearer abc");
    expect(diagnostic).not.toContain("C:\\Users\\qiany");
  });
});
