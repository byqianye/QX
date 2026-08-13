import { describe, expect, it } from "vitest";

import { createBackendRequest, isBackendResponse, type PlaybackProxySnapshot } from "../renderer/src/contracts.js";

describe("Tauri playback proxy contract", () => {
  it("returns a local proxy URL without echoing sensitive headers", () => {
    const payload = {
      action: "start" as const,
      sessionId: "playback-1",
      url: "https://media.example.test/video.m3u8",
      headers: { Referer: "https://source.example.test/", Cookie: "sid=secret" },
    };
    const proxy: PlaybackProxySnapshot = {
      sessionId: payload.sessionId,
      proxyUrl: "http://127.0.0.1:43123/__qx_playback/token",
      mediaType: "hls",
      state: "ready",
    };
    const response = { ...createBackendRequest(payload, "request-1", "session-1", 1), ok: true as const, payload: proxy };
    expect(isBackendResponse<PlaybackProxySnapshot>(response)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("secret");
  });
});
