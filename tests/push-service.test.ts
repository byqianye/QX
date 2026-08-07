import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PushService,
  PushServiceError,
  isBlockedAddress,
  parsePushUri,
  validatePushRedirectChain,
  validatePushUrl,
} from "../src/push/push-service.js";
import type {
  PushPlaybackSessionSnapshot,
  PushRequest,
} from "../src/push/push-types.js";
import { SettingsRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";

class FakePlayback {
  active: PushPlaybackSessionSnapshot | null = null;
  readonly played: PushRequest[] = [];
  private nextId = 1;

  public getActiveSession(): PushPlaybackSessionSnapshot | null {
    return this.active ? { ...this.active } : null;
  }

  public async play(request: PushRequest): Promise<PushPlaybackSessionSnapshot> {
    this.played.push(request);
    this.active = {
      id: `session-${this.nextId++}`,
      kind: request.type === "live-channel" ? "live" : "vod",
      title: request.title ?? null,
      state: "active",
    };
    return { ...this.active };
  }
}

class DelayedPlayback extends FakePlayback {
  inFlight = 0;
  maxInFlight = 0;

  public override async play(request: PushRequest): Promise<PushPlaybackSessionSnapshot> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await super.play(request);
    } finally {
      this.inFlight -= 1;
    }
  }
}

class ErrorPlayback extends FakePlayback {
  public override async play(_request: PushRequest): Promise<PushPlaybackSessionSnapshot> {
    throw new Error("secret path C:\\private\\movie.mp4 https://secret.example.test/token");
  }
}

const publicResolver = async (hostname: string): Promise<readonly string[]> => {
  if (hostname === "media.example.test" || hostname === "other.example.test") return ["93.184.216.34"];
  return ["127.0.0.1"];
};

function urlRequest(url = "https://media.example.test/movie.mp4"): PushRequest {
  return { type: "url", url, requestedBy: "trusted-local" };
}

describe("push service", () => {
  const services: PushService[] = [];
  const layers: SqliteDataLayer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (services.length > 0) await services.pop()?.close();
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses typed push:// variants without executing them", () => {
    expect(parsePushUri("push://url?url=https%3A%2F%2Fmedia.example.test%2Fa.mp4&title=Movie")).toEqual({
      type: "url",
      url: "https://media.example.test/a.mp4",
      title: "Movie",
      requestedBy: "localhost",
    });
    expect(parsePushUri("push://source-item/source-a/content-1?flag=main")).toMatchObject({
      type: "source-item",
      sourceReference: { sourceId: "source-a", contentId: "content-1", flag: "main" },
    });
    expect(parsePushUri("push://local-file/item-1")).toMatchObject({
      type: "local-file",
      localFileReference: { itemId: "item-1" },
    });
    expect(parsePushUri("push://live-channel/channel-1/stream-2")).toMatchObject({
      type: "live-channel",
      sourceReference: { channelId: "channel-1", streamId: "stream-2" },
    });
    expect(() => parsePushUri("https://media.example.test/a.mp4")).toThrowError(
      expect.objectContaining({ code: "PUSH_URI_INVALID" }),
    );
  });

  it("rejects unsupported schemes, credentials, private DNS, and untrusted origins", async () => {
    await expect(validatePushUrl("file:///C:/movie.mp4", { resolveAddresses: publicResolver })).rejects.toMatchObject({
      code: "PUSH_URL_SCHEME_BLOCKED",
    });
    await expect(validatePushUrl("https://user:secret@media.example.test/movie.mp4", { resolveAddresses: publicResolver })).rejects.toMatchObject({
      code: "PUSH_URL_CREDENTIALS_BLOCKED",
    });
    await expect(validatePushUrl("https://private.example.test/movie.mp4", { resolveAddresses: publicResolver })).rejects.toMatchObject({
      code: "PUSH_PRIVATE_ADDRESS_BLOCKED",
    });
    await expect(validatePushUrl("https://media.example.test/movie.mp4", {
      allowedOrigins: ["https://trusted.example.test"],
      resolveAddresses: publicResolver,
    })).rejects.toMatchObject({ code: "PUSH_ORIGIN_BLOCKED" });
  });

  it("checks redirect count, same-origin redirects, and DNS on every hop", async () => {
    await expect(validatePushRedirectChain([
      "https://media.example.test/one",
      "https://media.example.test/two",
    ], { resolveAddresses: publicResolver })).resolves.toMatchObject({
      href: "https://media.example.test/two",
    });
    await expect(validatePushRedirectChain([
      "https://media.example.test/one",
      "https://other.example.test/two",
    ], { resolveAddresses: publicResolver })).rejects.toMatchObject({
      code: "PUSH_REDIRECT_ORIGIN_BLOCKED",
    });
    await expect(validatePushRedirectChain([
      "https://media.example.test/1",
      "https://media.example.test/2",
      "https://media.example.test/3",
      "https://media.example.test/4",
      "https://media.example.test/5",
      "https://media.example.test/6",
      "https://media.example.test/7",
    ], { resolveAddresses: publicResolver })).rejects.toMatchObject({ code: "PUSH_REDIRECT_LIMIT" });
  });

  it("uses a header allowlist and rejects injection or credential headers", async () => {
    const playback = new FakePlayback();
    const service = new PushService({
      playback,
      confirmationPolicy: "allow-trusted-local",
      resolveAddresses: publicResolver,
    });
    services.push(service);
    await expect(service.submit({
      ...urlRequest(),
      headers: { Referer: "https://media.example.test/", "User-Agent": "QX test" },
    })).resolves.toMatchObject({ kind: "accepted" });
    await expect(service.submit({
      ...urlRequest(),
      headers: { Cookie: "session=secret" },
    })).rejects.toMatchObject({ code: "PUSH_HEADER_FORBIDDEN" });
    await expect(service.submit({
      ...urlRequest(),
      headers: { Referer: "https://media.example.test/\r\nX-Injected: yes" },
    })).rejects.toMatchObject({ code: "PUSH_HEADER_INJECTION" });
  });

  it("dispatches every typed request through the one playback port", async () => {
    const playback = new FakePlayback();
    const service = new PushService({
      playback,
      confirmationPolicy: "allow-trusted-local",
      resolveAddresses: publicResolver,
    });
    services.push(service);
    await service.submit({
      type: "source-item",
      sourceReference: { sourceId: "source-a", contentId: "content-1", flag: "main" },
      requestedBy: "trusted-local",
    });
    await service.submit({
      type: "local-file",
      localFileReference: { itemId: "local-1" },
      requestedBy: "trusted-local",
    });
    await service.submit({
      type: "live-channel",
      sourceReference: { channelId: "channel-1", streamId: "stream-1" },
      requestedBy: "trusted-local",
    });
    await service.submit({
      type: "fixture",
      fixtureId: "fixture-1",
      requestedBy: "trusted-local",
    });
    expect(playback.played.map((request) => request.type)).toEqual([
      "source-item",
      "local-file",
      "live-channel",
      "fixture",
    ]);
  });

  it("persists enable, port, confirmation, and conflict settings in SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-push-settings-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "push.db"));
    layers.push(layer);
    const settings = new SettingsRepository(layer);
    const first = new PushService({ playback: new FakePlayback(), settings });
    services.push(first);
    await first.configure({ enabled: false, port: 43_123, confirmationPolicy: "allow-trusted-local", conflictMode: "queue" });
    const restarted = new PushService({ playback: new FakePlayback(), settings });
    services.push(restarted);
    expect(restarted.uiState()).toMatchObject({
      enabled: false,
      configuredPort: 43_123,
      confirmationPolicy: "allow-trusted-local",
      conflictMode: "queue",
      listening: false,
    });
  });

  it("requires explicit confirmation, then enforces replace, queue, reject, and cancel", async () => {
    const playback = new FakePlayback();
    const service = new PushService({ playback, resolveAddresses: publicResolver });
    services.push(service);

    const pending = await service.submit({ type: "url", url: "https://media.example.test/a", requestedBy: "localhost" });
    expect(pending.kind).toBe("confirmation-required");
    if (pending.kind !== "confirmation-required") throw new Error("expected confirmation");
    expect(pending.preview.targetHost).toBe("media.example.test");
    expect((await service.confirm(pending.preview.id, "play")).kind).toBe("accepted");
    expect(playback.played).toHaveLength(1);

    const queuedService = new PushService({ playback, conflictMode: "queue", resolveAddresses: publicResolver });
    services.push(queuedService);
    const queuedPending = await queuedService.submit({ type: "url", url: "https://media.example.test/b", requestedBy: "localhost" });
    if (queuedPending.kind !== "confirmation-required") throw new Error("expected confirmation");
    expect((await queuedService.confirm(queuedPending.preview.id, "play")).kind).toBe("queued");
    expect(queuedService.uiState().recent[0]?.status).toBe("queued");
    expect(queuedService.cancel(queuedPending.preview.id).status).toBe("cancelled");

    const rejectService = new PushService({ playback, conflictMode: "reject", resolveAddresses: publicResolver });
    services.push(rejectService);
    const rejected = await rejectService.submit(urlRequest("https://media.example.test/c"));
    expect(rejected.kind).toBe("confirmation-required");
    if (rejected.kind !== "confirmation-required") throw new Error("expected confirmation");
    await expect(rejectService.confirm(rejected.preview.id, "play")).rejects.toMatchObject({ code: "PUSH_CONFLICT" });
  });

  it("binds the endpoint to localhost, returns confirmation, and shuts down cleanly", async () => {
    const playback = new FakePlayback();
    const service = new PushService({ playback, resolveAddresses: publicResolver });
    services.push(service);
    await service.start();
    const endpoint = service.url;
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/push$/);
    const response = await fetch(endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "push://url?url=https%3A%2F%2Fmedia.example.test%2Fendpoint.mp4" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: "confirmation-required" });
    await service.close();
    await expect(fetch(endpoint!)).rejects.toBeTruthy();
  });

  it("only allows trusted-local confirmation bypass for an allowlisted Origin", async () => {
    const playback = new FakePlayback();
    const service = new PushService({
      playback,
      confirmationPolicy: "allow-trusted-local",
      trustedLocalOrigins: ["http://trusted-app.test"],
      resolveAddresses: publicResolver,
    });
    services.push(service);
    await service.start();
    const endpoint = service.url!;

    const trusted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://trusted-app.test" },
      body: JSON.stringify({ uri: "push://url?url=https%3A%2F%2Fmedia.example.test%2Ftrusted.mp4" }),
    });
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toMatchObject({ kind: "accepted", recent: { requestedBy: "trusted-local" } });

    const untrusted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "url",
        url: "https://media.example.test/untrusted.mp4",
        requestedBy: "trusted-local",
      }),
    });
    expect(untrusted.status).toBe(202);
    expect(await untrusted.json()).toMatchObject({ kind: "confirmation-required", preview: { requestedBy: "localhost" } });
  });

  it("serializes concurrent playback transitions and drains a queued item after completion", async () => {
    const playback = new DelayedPlayback();
    const service = new PushService({
      playback,
      confirmationPolicy: "allow-trusted-local",
      conflictMode: "queue",
      resolveAddresses: publicResolver,
    });
    services.push(service);
    const requests = await Promise.all([
      service.submit(urlRequest("https://media.example.test/one")),
      service.submit(urlRequest("https://media.example.test/two")),
    ]);
    expect(requests.map((result) => result.kind)).toEqual(["accepted", "queued"]);
    expect(playback.maxInFlight).toBe(1);
    playback.active = null;
    await service.drainQueue();
    expect(service.uiState().recent.some((item) => item.status === "accepted" && item.title === "Push 请求")).toBe(true);
  });

  it("revokes pending work on close, rejects mapped IPv4 private addresses, and redacts adapter errors", async () => {
    expect(isBlockedAddress("::ffff:192.168.1.20")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.1.20")).toBe(true);
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);

    const playback = new ErrorPlayback();
    const service = new PushService({
      playback,
      confirmationPolicy: "allow-trusted-local",
      resolveAddresses: publicResolver,
    });
    services.push(service);
    const pending = await service.submit({ type: "url", url: "https://media.example.test/error", requestedBy: "localhost" });
    if (pending.kind !== "confirmation-required") throw new Error("expected confirmation");
    await service.close();
    expect(service.uiState().recent[0]).toMatchObject({ status: "cancelled" });
    await expect(service.confirm(pending.preview.id, "play")).rejects.toMatchObject({ code: "PUSH_CONFIRMATION_NOT_FOUND" });

    const errorService = new PushService({
      playback,
      confirmationPolicy: "allow-trusted-local",
      resolveAddresses: publicResolver,
    });
    services.push(errorService);
    await expect(errorService.submit(urlRequest())).rejects.toMatchObject({ code: "PUSH_PLAYBACK_FAILED" });
    expect(errorService.uiState().recent[0]?.error?.message).toBe("Push 播放失败。");
  });

  it("rejects a redirect resolver result beyond the configured limit", async () => {
    const service = new PushService({
      playback: new FakePlayback(),
      resolveAddresses: publicResolver,
      resolveRedirectChain: async () => [
        "https://media.example.test/1",
        "https://media.example.test/2",
        "https://media.example.test/3",
        "https://media.example.test/4",
        "https://media.example.test/5",
        "https://media.example.test/6",
      ],
    });
    services.push(service);
    await expect(service.submit({ type: "url", url: "https://media.example.test/start", requestedBy: "localhost" })).rejects.toMatchObject({
      code: "PUSH_REDIRECT_LIMIT",
    });
  });
});
