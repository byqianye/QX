import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_CONTROL_ROUTES,
  type WebControlBackend,
  type WebControlSnapshot,
} from "../src/web-control/web-control-types.js";
import { WebControlService } from "../src/web-control/web-control-service.js";

describe("WebControlService", () => {
  const services: WebControlService[] = [];

  afterEach(async () => {
    while (services.length > 0) await services.pop()?.close();
  });

  it("serves a local CSP UI and the allowlisted API surface", async () => {
    const calls: string[] = [];
    const service = await startService(calls);
    const base = service.url as string;
    const root = await fetch(base);
    const html = await root.text();
    const token = csrfToken(html);

    expect(root.ok).toBe(true);
    expect(root.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(html).toContain("/app.js");
    expect(html).toContain("安全状态");
    expect(html).not.toContain("cdnjs.cloudflare.com");

    const now = await getJson(base, "/api/now-playing");
    const search = await getJson(base, "/api/search?q=fixture");
    const detail = await getJson(base, "/api/detail?id=movie-1");
    const live = await getJson(base, "/api/live-channels");
    const downloads = await getJson(base, "/api/downloads");
    const cast = await getJson(base, "/api/cast-devices");
    const safe = await getJson(base, "/api/safe-status");

    expect(now.nowPlaying.title).toBe("Fixture Movie");
    expect(search.search.items[0].id).toBe("movie-1");
    expect(detail.detail.episodes).toHaveLength(1);
    expect(live.live.channels[0].id).toBe("channel-1");
    expect(downloads.downloads.tasks[0].filename).toBe("fixture.mp4");
    expect(cast.cast.devices[0]).not.toHaveProperty("location");
    expect(safe.status).toMatchObject({ host: "127.0.0.1", listening: true, lanControl: "requires-g68" });
    expect(JSON.stringify({ now, search, detail, live, downloads, cast, safe })).not.toContain("C:\\private");
    expect(JSON.stringify({ now, search, detail, live, downloads, cast, safe })).not.toContain("Cookie");
    expect(calls).toEqual([]);
  });

  it("requires same-origin CSRF for every state-changing endpoint", async () => {
    const calls: string[] = [];
    const service = await startService(calls);
    const base = service.url as string;
    const origin = new URL(base).origin;
    const token = csrfToken(await (await fetch(base)).text());

    const missingOrigin = await fetch(new URL("/api/stop", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const badOrigin = await fetch(new URL("/api/stop", base), {
      method: "POST",
      headers: { Origin: "http://evil.example", "content-type": "application/json", "x-csrf-token": token },
      body: "{}",
    });
    const badToken = await fetch(new URL("/api/stop", base), {
      method: "POST",
      headers: { Origin: origin, "content-type": "application/json", "x-csrf-token": "wrong" },
      body: "{}",
    });
    const valid = await postJson(base, "/api/stop", {}, token);

    expect(missingOrigin.status).toBe(403);
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(badToken.status).toBe(403);
    expect(valid.response.ok).toBe(true);
    expect(calls).toContain("stop");
  });

  it("rejects invalid JSON, oversized bodies, and fields outside the endpoint schema", async () => {
    const service = await startService([], { maxBodyBytes: 128 });
    const base = service.url as string;
    const token = csrfToken(await (await fetch(base)).text());
    const headers = {
      Origin: new URL(base).origin,
      "content-type": "application/json",
      "x-csrf-token": token,
    };
    const invalid = await fetch(new URL("/api/seek", base), { method: "POST", headers, body: "{" });
    const oversized = await fetch(new URL("/api/seek", base), {
      method: "POST",
      headers,
      body: JSON.stringify({ position: 1, padding: "x".repeat(256) }),
    });
    const arbitrary = await fetch(new URL("/api/play", base), {
      method: "POST",
      headers,
      body: JSON.stringify({ flag: "default", id: "movie-1", sql: "select * from secrets" }),
    });
    const unknown = await fetch(new URL("/api/raw-sql", base), { headers: { Origin: new URL(base).origin } });

    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(arbitrary.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(await invalid.json()).toMatchObject({ error: { code: "WEB_JSON_INVALID" } });
    expect(await oversized.json()).toMatchObject({ error: { code: "WEB_BODY_TOO_LARGE" } });
    expect(JSON.stringify(await arbitrary.json())).not.toContain("select *");
  });

  it("routes every supported action through the backend and keeps push/cast inputs opaque", async () => {
    const calls: string[] = [];
    const service = await startService(calls);
    const base = service.url as string;
    const token = csrfToken(await (await fetch(base)).text());

    await postJson(base, "/api/play", { flag: "default", id: "movie-1", vipFlags: [] }, token);
    await postJson(base, "/api/pause", {}, token);
    await postJson(base, "/api/seek", { position: 12 }, token);
    await postJson(base, "/api/volume", { volume: 0.4, muted: true }, token);
    await postJson(base, "/api/play-episode", { lineIndex: 0, episodeIndex: 0 }, token);
    await postJson(base, "/api/live-channel", { channelId: "channel-1", streamId: "stream-1" }, token);
    const pushed = await postJson(base, "/api/push", { url: "https://media.example.test/fixture.mp4", title: "Fixture" }, token);
    await postJson(base, "/api/cast", { deviceId: "device-1" }, token);
    await postJson(base, "/api/stop", {}, token);

    expect(calls).toEqual([
      "play:default:movie-1",
      "pause",
      "seek:12",
      "volume:0.4:true",
      "episode:0:0",
      "live:channel-1:stream-1",
      "push:https://media.example.test/fixture.mp4:Fixture",
      "cast:device-1",
      "stop",
    ]);
    expect(pushed.value.push).toMatchObject({ kind: "accepted", status: "accepted" });
  });

  it("supports a bounded WebSocket state stream and rejects the connection limit", async () => {
    const service = await startService([], { maxConnections: 1, maxMessageBytes: 2_048, idleTimeoutMs: 2_000 });
    const base = service.url as string;
    const first = await openWebSocket(base);
    expect(first.response).toContain("101 Switching Protocols");
    expect(first.frame).toContain('"type":"state"');

    const second = await openRawHttp(base, [
      `GET /ws HTTP/1.1`,
      `Host: ${new URL(base).host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Origin: ${new URL(base).origin}`,
      "",
      "",
    ].join("\r\n"));
    expect(second).toContain("503 Service Unavailable");

    first.socket.write(maskedFrame("x".repeat(3_000)));
    await waitForSocketClose(first.socket);
    first.socket.destroy();
  });

  it("closes the listener and websocket clients during shutdown", async () => {
    const service = await startService([]);
    const base = service.url as string;
    const first = await openWebSocket(base);
    await service.close();
    expect(service.listening).toBe(false);
    await expect(fetch(base)).rejects.toThrow();
    first.socket.destroy();
  });

  it("publishes an explicit route contract without raw process, SQL, path, or secret surfaces", () => {
    expect(WEB_CONTROL_ROUTES).toHaveLength(16);
    expect(WEB_CONTROL_ROUTES.every((route) => route.path.startsWith("/api/") && !route.path.includes("sql"))).toBe(true);
    expect(JSON.stringify(WEB_CONTROL_ROUTES)).not.toMatch(/spawn|shell|sqlite|filePath|token/i);
  });

  async function startService(calls: string[], options: { maxBodyBytes?: number; maxConnections?: number; maxMessageBytes?: number; idleTimeoutMs?: number } = {}): Promise<WebControlService> {
    const service = new WebControlService({ backend: fakeBackend(calls), port: 0, ...options });
    services.push(service);
    await service.start();
    return service;
  }
});

function fakeBackend(calls: string[]): WebControlBackend {
  const snapshot = (): WebControlSnapshot => ({
    nowPlaying: {
      status: "playing",
      title: "Fixture Movie",
      episode: "Episode 1",
      currentTime: 10,
      duration: 100,
      volume: 1,
      muted: false,
      live: false,
      error: null,
    },
    search: { query: "", items: [] },
    live: {
      channels: [{ id: "channel-1", name: "Fixture Channel", group: "News", sourceName: "Fixture", streams: [{ id: "stream-1", label: "Main", protocol: "HLS", status: "ready" }] }],
      activeChannelId: null,
      activeStreamId: null,
      state: null,
    },
    downloads: {
      tasks: [{ id: "download-1", title: "Fixture", filename: "fixture.mp4", status: "completed", totalBytes: 10, completedBytes: 10, speed: 0, error: null }],
      backend: "fake",
      available: true,
      error: null,
    },
    cast: {
      discoveryStatus: "ready",
      devices: [{ deviceId: "device-1", friendlyName: "Fixture TV", model: "Model", manufacturer: "Maker", capabilities: { play: true, pause: true, stop: true, seek: true } }],
      session: null,
      error: null,
    },
    status: {
      uiReady: true,
      capabilities: { search: true, playback: true, live: true, push: true, downloads: true, cast: true },
      lanControl: "requires-g68",
    },
  });
  return {
    snapshot,
    play: async ({ flag, id }) => { calls.push(`play:${flag}:${id}`); },
    pause: async () => { calls.push("pause"); },
    stop: async () => { calls.push("stop"); },
    seek: async (position) => { calls.push(`seek:${position}`); },
    volume: async (volume, muted) => { calls.push(`volume:${volume}:${muted ?? false}`); },
    search: async (query) => ({ query, items: [{ id: "movie-1", title: "Fixture Movie", year: "2026", remark: "HD" }] }),
    detail: async (id) => ({ id, title: "Fixture Movie", year: "2026", overview: "Safe overview", episodes: [{ lineIndex: 0, episodeIndex: 0, lineName: "Main", name: "Episode 1" }] }),
    playEpisode: async ({ lineIndex, episodeIndex }) => { calls.push(`episode:${lineIndex}:${episodeIndex}`); },
    liveChannels: () => snapshot().live,
    playLive: async ({ channelId, streamId }) => { calls.push(`live:${channelId}:${streamId}`); },
    push: async ({ url, title }) => { calls.push(`push:${url}:${title}`); return { kind: "accepted", id: "push-1", title: title ?? null, status: "accepted" }; },
    downloads: () => snapshot().downloads,
    castDevices: () => snapshot().cast,
    cast: async (deviceId) => { calls.push(`cast:${deviceId}`); },
    safeStatus: () => snapshot().status,
  };
}

function csrfToken(html: string): string {
  const token = /<meta name="qx-csrf-token" content="([^"]+)"/u.exec(html)?.[1];
  if (!token) throw new Error("CSRF token not found");
  return token;
}

async function getJson(base: string, path: string): Promise<any> {
  const response = await fetch(new URL(path, base));
  return response.json();
}

async function postJson(base: string, path: string, value: Record<string, unknown>, token: string): Promise<{ response: Response; value: any }> {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      Origin: new URL(base).origin,
      "content-type": "application/json",
      "x-csrf-token": token,
    },
    body: JSON.stringify(value),
  });
  return { response, value: await response.json() };
}

async function openWebSocket(base: string): Promise<{ socket: Socket; response: string; frame: string }> {
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(base).port) });
  const request = [
    "GET /ws HTTP/1.1",
    `Host: ${new URL(base).host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    `Origin: ${new URL(base).origin}`,
    "",
    "",
  ].join("\r\n");
  socket.write(request);
  let buffer = Buffer.alloc(0);
  const response = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket handshake timed out")), 2_000);
    const onHandshake = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;
      clearTimeout(timer);
      socket.off("data", onHandshake);
      const handshake = buffer.subarray(0, marker + 4).toString("utf8");
      buffer = buffer.subarray(marker + 4);
      resolve(handshake);
    };
    socket.on("data", onHandshake);
    socket.once("error", reject);
  });
  const frame = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket state frame timed out")), 2_000);
    const read = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = decodeServerFrame(buffer);
      if (!parsed) return;
      clearTimeout(timer);
      socket.off("data", read);
      resolve(parsed.payload.toString("utf8"));
    };
    socket.on("data", read);
    const parsed = decodeServerFrame(buffer);
    if (parsed) {
      clearTimeout(timer);
      socket.off("data", read);
      resolve(parsed.payload.toString("utf8"));
    }
  });
  return { socket, response, frame };
}

async function openRawHttp(base: string, request: string): Promise<string> {
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(base).port) });
  socket.write(request);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("HTTP probe timed out")); }, 2_000);
    socket.on("data", (chunk) => { value += chunk.toString("utf8"); if (value.includes("\r\n\r\n")) { clearTimeout(timer); socket.destroy(); resolve(value); } });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function maskedFrame(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const result = Buffer.alloc(2 + 8 + 4 + payload.length);
  result[0] = 0x81;
  result[1] = 0x80 | 127;
  result.writeUInt32BE(0, 2);
  result.writeUInt32BE(payload.length, 6);
  mask.copy(result, 10);
  for (let index = 0; index < payload.length; index += 1) result[14 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return result.subarray(0, 14 + payload.length);
}

function decodeServerFrame(buffer: Buffer): { payload: Buffer } | null {
  if (buffer.length < 2) return null;
  const length = buffer[1] ?? 0;
  if (length < 126) {
    if (buffer.length < 2 + length) return null;
    return { payload: buffer.subarray(2, 2 + length) };
  }
  if (length === 126) {
    if (buffer.length < 4) return null;
    const size = buffer.readUInt16BE(2);
    if (buffer.length < 4 + size) return null;
    return { payload: buffer.subarray(4, 4 + size) };
  }
  if (buffer.length < 10) return null;
  const size = buffer.readUInt32BE(6);
  if (buffer.length < 10 + size) return null;
  return { payload: buffer.subarray(10, 10 + size) };
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 2_000);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
}
