import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateSnifferCandidate,
  IsolatedSniffer,
  type IsolatedSnifferPlatform,
  type IsolatedSnifferSession,
  type SnifferNavigationEvent,
  type SnifferPolicy,
  type SnifferRequestEvent,
  type SnifferResponseEvent,
  type SnifferViolation,
} from "../src/electron/isolated-sniffer.js";

describe("isolated Electron sniffer policy", () => {
  const sniffers: IsolatedSniffer[] = [];

  afterEach(async () => {
    while (sniffers.length > 0) await sniffers.pop()?.close();
  });

  it("scores media and rejects images, scripts, JSON APIs, and failed responses", () => {
    const origins = new Set(["https://media.example.invalid"]);
    expect(evaluateSnifferCandidate({
      requestId: "playlist",
      url: "https://media.example.invalid/master.m3u8",
      statusCode: 200,
      contentType: "application/vnd.apple.mpegurl",
      contentLength: 64,
      resourceType: "xhr",
      isMasterPlaylist: true,
    }, origins)).toMatchObject({ accepted: true, kind: "playlist" });
    expect(evaluateSnifferCandidate({
      requestId: "image",
      url: "https://media.example.invalid/poster.jpg",
      statusCode: 200,
      contentType: "image/jpeg",
      resourceType: "image",
    }, origins).accepted).toBe(false);
    expect(evaluateSnifferCandidate({
      requestId: "api",
      url: "https://media.example.invalid/api/player",
      statusCode: 200,
      contentType: "application/json",
      resourceType: "xhr",
    }, origins).accepted).toBe(false);
    expect(evaluateSnifferCandidate({
      requestId: "failed",
      url: "https://media.example.invalid/fixture.mp4",
      statusCode: 404,
      contentType: "video/mp4",
    }, origins).accepted).toBe(false);
    expect(evaluateSnifferCandidate({
      requestId: "media-source",
      url: "https://media.example.invalid/segment-without-extension",
      statusCode: 200,
      contentType: "application/octet-stream",
      resourceType: "media",
      explicitPlayerRequest: true,
      contentLength: 128,
    }, origins)).toMatchObject({ accepted: true, kind: "segment" });
    expect(evaluateSnifferCandidate({
      requestId: "outside",
      url: "https://outside.example.invalid/fixture.mp4",
      statusCode: 200,
      contentType: "video/mp4",
    }, origins)).toMatchObject({ accepted: false, reason: "origin blocked" });
  });

  it("uses a temporary secure policy, captures the delayed media, and drops Cookie", async () => {
    const fixture = new FakeSession((session) => {
      session.emitRequest({
        requestId: "image",
        url: "https://media.example.invalid/poster.jpg",
        resourceType: "image",
      });
      session.emitResponse({
        requestId: "image",
        url: "https://media.example.invalid/poster.jpg",
        resourceType: "image",
        statusCode: 200,
        contentType: "image/jpeg",
      });
      setTimeout(() => {
        session.emitRequest({
          requestId: "playlist",
          url: "https://media.example.invalid/watch/master.m3u8",
          resourceType: "xhr",
          pageUrl: "https://media.example.invalid/player",
          requestHeaders: {
            Referer: "https://media.example.invalid/player",
            Cookie: "session=must-not-leak",
            Authorization: "Bearer must-not-leak",
          },
        });
        session.emitResponse({
          requestId: "playlist",
          url: "https://media.example.invalid/watch/master.m3u8",
          resourceType: "xhr",
          pageUrl: "https://media.example.invalid/player",
          statusCode: 200,
          responseHeaders: {
            "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
            "content-length": "128",
          },
          requestHeaders: {
            Referer: "https://media.example.invalid/player",
            Cookie: "session=must-not-leak",
            Authorization: "Bearer must-not-leak",
          },
          isMasterPlaylist: true,
        });
      }, 10);
    });
    const platform = new FakePlatform(fixture);
    const sniffer = new IsolatedSniffer(platform);
    sniffers.push(sniffer);

    const result = await sniffer.sniff({
      sourceId: "fixture-source",
      playbackSessionId: "session-1",
      initialUrl: "https://media.example.invalid/player",
      allowedOrigins: ["https://media.example.invalid"],
      headers: {
        Referer: "https://media.example.invalid/player",
        Cookie: "source-cookie-must-not-be-forwarded",
      },
    });

    expect(result).toMatchObject({
      parse: 0,
      url: "https://media.example.invalid/watch/master.m3u8",
      contentType: "application/vnd.apple.mpegurl",
    });
    expect(result.headers).toEqual({ Referer: "https://media.example.invalid/player" });
    expect(result.diagnostics).toMatchObject({
      redacted: true,
      sourceId: "fixture-source",
      playbackSessionId: "session-1",
      selectedKind: "playlist",
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("must-not-leak");
    expect(platform.policy).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowDownloads: false,
      allowPopups: false,
    });
    expect(platform.policy?.partition).toMatch(/^temp:qx-sniffer-/);
    expect(platform.policy?.partition).not.toBe("persist:default");
    expect(fixture.closeCount).toBe(1);
    expect(sniffer.activeSessionCount).toBe(0);
  });

  it("rejects blocked origins, popups, and unsupported protocols", async () => {
    const fixture = new FakeSession((session) => {
      session.emitViolation({ kind: "popup", url: "https://outside.example.invalid/new" });
    });
    const sniffer = new IsolatedSniffer(new FakePlatform(fixture));
    sniffers.push(sniffer);

    await expect(sniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/player",
      allowedOrigins: ["https://media.example.invalid"],
    })).rejects.toMatchObject({ code: "SNIFF_POLICY_BLOCKED" });
    expect(fixture.closeCount).toBe(1);
    expect(sniffer.activeSessionCount).toBe(0);

    const blocked = new FakeSession((session) => {
      session.emitRequest({
        requestId: "outside",
        url: "https://outside.example.invalid/track.js",
        resourceType: "script",
      });
    });
    const blockedSniffer = new IsolatedSniffer(new FakePlatform(blocked));
    sniffers.push(blockedSniffer);
    await expect(blockedSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/player",
    })).rejects.toMatchObject({ code: "SNIFF_ORIGIN_BLOCKED" });

    const protocol = new FakeSession((session) => {
      session.emitViolation({ kind: "protocol", url: "file:///secret.mp4" });
    });
    const protocolSniffer = new IsolatedSniffer(new FakePlatform(protocol));
    sniffers.push(protocolSniffer);
    await expect(protocolSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/player",
    })).rejects.toMatchObject({ code: "SNIFF_PROTOCOL_BLOCKED" });
  });

  it("times out, supports AbortSignal cancellation, and closes all sessions", async () => {
    const timeoutSession = new FakeSession();
    const timeoutSniffer = new IsolatedSniffer(new FakePlatform(timeoutSession));
    sniffers.push(timeoutSniffer);
    await expect(timeoutSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/infinite",
      maxTotalMs: 25,
      maxIdleMs: 10,
    })).rejects.toMatchObject({ code: "SNIFF_TIMEOUT" });
    expect(timeoutSession.closeCount).toBe(1);

    const controller = new AbortController();
    const cancelledSession = new FakeSession();
    const cancelledSniffer = new IsolatedSniffer(new FakePlatform(cancelledSession));
    sniffers.push(cancelledSniffer);
    const pending = cancelledSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/infinite",
      signal: controller.signal,
      maxTotalMs: 1_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "SNIFF_CANCELLED" });
    expect(cancelledSession.closeCount).toBe(1);
    expect(cancelledSniffer.activeSessionCount).toBe(0);

    const closedSession = new FakeSession();
    const closedSniffer = new IsolatedSniffer(new FakePlatform(closedSession));
    const closePending = closedSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/infinite",
      maxTotalMs: 1_000,
    });
    await closedSniffer.close();
    await expect(closePending).rejects.toMatchObject({ code: "SNIFF_CANCELLED" });
    expect(closedSession.closeCount).toBe(1);
    expect(closedSniffer.activeSessionCount).toBe(0);

    const redirectSession = new FakeSession((session) => {
      session.emitNavigation({ url: "https://media.example.invalid/redirect-1", isMainFrame: true });
      session.emitNavigation({ url: "https://media.example.invalid/redirect-2", isMainFrame: true });
    });
    const redirectSniffer = new IsolatedSniffer(new FakePlatform(redirectSession));
    sniffers.push(redirectSniffer);
    await expect(redirectSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/infinite",
      maxRedirects: 1,
      maxTotalMs: 1_000,
    })).rejects.toMatchObject({ code: "SNIFF_REDIRECT_LIMIT" });

    const resourcesSession = new FakeSession((session) => {
      session.emitRequest({ requestId: "one", url: "https://media.example.invalid/one" });
      session.emitRequest({ requestId: "two", url: "https://media.example.invalid/two" });
    });
    const resourcesSniffer = new IsolatedSniffer(new FakePlatform(resourcesSession));
    sniffers.push(resourcesSniffer);
    await expect(resourcesSniffer.sniff({
      sourceId: "fixture-source",
      initialUrl: "https://media.example.invalid/infinite",
      maxResources: 1,
      maxTotalMs: 1_000,
    })).rejects.toMatchObject({ code: "SNIFF_RESOURCE_LIMIT" });
  });
});

class FakePlatform implements IsolatedSnifferPlatform {
  public policy: SnifferPolicy | undefined;

  public constructor(private readonly session: FakeSession) {}

  public async createSession(policy: SnifferPolicy): Promise<IsolatedSnifferSession> {
    this.policy = policy;
    return this.session;
  }
}

class FakeSession implements IsolatedSnifferSession {
  public closeCount = 0;
  private readonly requestListeners = new Set<(event: SnifferRequestEvent) => void>();
  private readonly responseListeners = new Set<(event: SnifferResponseEvent) => void>();
  private readonly navigateListeners = new Set<(event: SnifferNavigationEvent) => void>();
  private readonly violationListeners = new Set<(event: SnifferViolation) => void>();

  public constructor(private readonly onLoad?: (session: FakeSession) => void) {}

  public async load(_url: string, _headers?: Readonly<Record<string, string>>): Promise<void> {
    this.onLoad?.(this);
  }

  public onRequest(listener: (event: SnifferRequestEvent) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  public onResponse(listener: (event: SnifferResponseEvent) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  public onNavigate(listener: (event: SnifferNavigationEvent) => void): () => void {
    this.navigateListeners.add(listener);
    return () => this.navigateListeners.delete(listener);
  }

  public onViolation(listener: (event: SnifferViolation) => void): () => void {
    this.violationListeners.add(listener);
    return () => this.violationListeners.delete(listener);
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }

  public emitRequest(event: SnifferRequestEvent): void {
    for (const listener of this.requestListeners) listener(event);
  }

  public emitResponse(event: SnifferResponseEvent): void {
    for (const listener of this.responseListeners) listener(event);
  }

  public emitNavigation(event: SnifferNavigationEvent): void {
    for (const listener of this.navigateListeners) listener(event);
  }

  public emitViolation(event: SnifferViolation): void {
    for (const listener of this.violationListeners) listener(event);
  }
}
