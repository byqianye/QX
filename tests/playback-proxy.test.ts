import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PlaybackProxyServer } from "../src/desktop/playback-proxy.js";

let upstream: Server;
let origin: string;
let otherOrigin: string;
const requests: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
const proxies: PlaybackProxyServer[] = [];

describe("PlaybackProxyServer", () => {
  beforeAll(async () => {
    upstream = createServer((request, response) => {
      void handleUpstream(request, response);
    });
    await listen(upstream);
    const address = upstream.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    const other = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      response.end("#EXTM3U\n#EXT-X-ENDLIST\n");
    });
    await listen(other);
    const otherAddress = other.address() as AddressInfo;
    otherOrigin = `http://127.0.0.1:${otherAddress.port}`;
    other.on("close", () => undefined);
    (upstream as Server & { other?: Server }).other = other;
  });

  afterEach(async () => {
    while (proxies.length > 0) await proxies.pop()?.close();
    requests.splice(0);
  });

  afterAll(async () => {
    const other = (upstream as Server & { other?: Server }).other;
    await close(other);
    await close(upstream);
  });

  it("requires upstream headers and rewrites HLS child, key and map URIs", async () => {
    const proxy = createProxy();
    const session = await proxy.createSession(source(`${origin}/hls/main.m3u8`));

    const main = await fetch(session.url);
    const mainBody = await main.text();
    expect(main.status).toBe(200);
    expect(mainBody).toContain(`${proxy.url}__qx_playback/`);
    expect(mainBody).not.toContain(origin);
    expect(mainBody).toContain('URI="http');

    const [keyUrl, mapUrl, childUrl] = playlistUris(mainBody);
    expect(childUrl).toBeTruthy();
    expect(keyUrl).toBeTruthy();
    expect(mapUrl).toBeTruthy();

    const child = await fetch(childUrl as string);
    const childBody = await child.text();
    expect(child.status).toBe(200);
    expect(childBody).toContain(`${proxy.url}__qx_playback/`);
    expect(await fetch(keyUrl as string)).toMatchObject({ status: 200 });
    expect(await fetch(mapUrl as string)).toMatchObject({ status: 200 });
    const segmentUrl = childBody.split("\n").find((line) => line.startsWith(`${proxy.url}__qx_playback/`));
    expect(segmentUrl).toBeTruthy();
    expect(await fetch(segmentUrl as string)).toMatchObject({ status: 200 });

    expect(requests.filter((request) => request.path.startsWith("/hls") || request.path.startsWith("/segments") || request.path.startsWith("/keys")))
      .toHaveLength(5);
    for (const request of requests) {
      expect(request.headers.referer).toBe("https://source.example.invalid/");
      expect(request.headers["user-agent"]).toBe("G22-fixture");
      expect(request.headers.authorization).toBe("Bearer secret");
      expect(request.headers.host).toContain("127.0.0.1");
    }
  });

  it("passes MP4 Range and safe response headers through the proxy", async () => {
    const proxy = createProxy();
    const session = await proxy.createSession(source(`${origin}/video.mp4`));

    const response = await fetch(session.url, { headers: { Range: "bytes=2-4" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("cde");
    expect(requests.at(-1)?.headers.range).toBe("bytes=2-4");
  });

  it("follows same-origin redirects and rejects cross-origin redirects", async () => {
    const proxy = createProxy();
    const redirect = await proxy.createSession(source(`${origin}/redirect.m3u8`));
    expect(await fetch(redirect.url)).toMatchObject({ status: 200 });

    const crossOrigin = await proxy.createSession(source(`${origin}/cross-origin-redirect.m3u8`));
    const response = await fetch(crossOrigin.url);
    expect(response.status).toBe(403);
  });

  it("does not allow renderer query parameters or unknown resource ids", async () => {
    const proxy = createProxy();
    const session = await proxy.createSession(source(`${origin}/video.mp4`));
    const query = await fetch(`${session.url}?url=${encodeURIComponent("http://169.254.169.254/")}`);
    expect(query.status).toBe(400);

    const unknown = await fetch(session.url.replace(/[^/]+$/, "unknown-resource"));
    expect(unknown.status).toBe(404);
  });

  it("blocks unsafe origins and forbidden source headers", async () => {
    expect(() => new PlaybackProxyServer({ host: "0.0.0.0" })).toThrow("127.0.0.1");
    const proxy = new PlaybackProxyServer({});
    proxies.push(proxy);
    await expect(proxy.createSession({ parse: 0, url: `${origin}/video.mp4`, headers: {} }))
      .rejects.toMatchObject({ code: "PLAYBACK_PRIVATE_ADDRESS_BLOCKED" });
    await expect(proxy.createSession({ parse: 0, url: "file:///secret.mp4", headers: {} }))
      .rejects.toMatchObject({ code: "PLAYBACK_PROTOCOL_UNSUPPORTED" });
    await expect(proxy.createSession({
      parse: 0,
      url: `${origin}/video.mp4`,
      headers: { Host: "evil.example", Cookie: "session=secret" },
    })).rejects.toMatchObject({ code: "PLAYBACK_HEADER_FORBIDDEN" });
  });

  it("expires and revokes tokens, then releases the proxy port", async () => {
    let now = Date.now();
    const proxy = new PlaybackProxyServer({
      allowedOrigins: [origin],
      now: () => now,
      sessionTtlMs: 100,
    });
    proxies.push(proxy);
    const session = await proxy.createSession(source(`${origin}/video.mp4`));
    now += 101;
    expect(await fetch(session.url)).toMatchObject({ status: 410 });

    const active = await proxy.createSession(source(`${origin}/video.mp4`));
    await active.close();
    expect(await fetch(active.url)).toMatchObject({ status: 410 });
    const url = proxy.url;
    await proxy.close();
    await expect(fetch(url)).rejects.toThrow();
    proxies.splice(proxies.indexOf(proxy), 1);
  });

  it("enforces playlist size, timeout and concurrency limits", async () => {
    const proxy = new PlaybackProxyServer({
      allowedOrigins: [origin],
      maxPlaylistBytes: 32,
      maxConcurrentRequests: 1,
      requestTimeoutMs: 30,
    });
    proxies.push(proxy);
    const large = await proxy.createSession(source(`${origin}/large.m3u8`));
    expect(await fetch(large.url)).toMatchObject({ status: 413 });

    const slow = await proxy.createSession(source(`${origin}/slow.m3u8`));
    const pending = fetch(slow.url);
    const concurrent = await fetch(slow.url);
    expect(concurrent.status).toBe(429);
    expect(await pending).toMatchObject({ status: 504 });
  });

  it("enforces connection and first-byte timeouts separately", async () => {
    const connectionProxy = new PlaybackProxyServer({
      allowedOrigins: [origin],
      connectionTimeoutMs: 30,
      totalRequestTimeoutMs: 2_000,
    });
    proxies.push(connectionProxy);
    const connectionSession = await connectionProxy.createSession(source(`${origin}/slow.m3u8`));
    expect(await fetch(connectionSession.url)).toMatchObject({ status: 504 });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const firstByteProxy = new PlaybackProxyServer({
      allowedOrigins: [origin],
      firstByteTimeoutMs: 30,
      totalRequestTimeoutMs: 2_000,
      fetchImpl: async () => new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            clearTimeout(timer);
          },
          start(controller) {
            timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("#EXTM3U\n"));
              controller.close();
            }, 100);
          },
        }),
        { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } },
      ),
    });
    proxies.push(firstByteProxy);
    const firstByteSession = await firstByteProxy.createSession(source(`${origin}/delayed-body.m3u8`));
    expect(await fetch(firstByteSession.url)).toMatchObject({ status: 504 });
  });
});

function createProxy(): PlaybackProxyServer {
  const proxy = new PlaybackProxyServer({
    allowedOrigins: [origin],
    requestTimeoutMs: 2_000,
  });
  proxies.push(proxy);
  return proxy;
}

function source(url: string): { parse: number; url: string; headers: Record<string, string> } {
  return {
    parse: 0,
    url,
    headers: {
      Referer: "https://source.example.invalid/",
      "User-Agent": "G22-fixture",
      Authorization: "Bearer secret",
    },
  };
}

function playlistUris(body: string): string[] {
  return [...body.matchAll(/URI="([^"]+)"/g), ...body.split("\n").filter((line) => line.startsWith("http"))]
    .map((match) => typeof match === "string" ? match : match[1] ?? match[0]);
}

async function handleUpstream(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin);
  requests.push({ path: url.pathname, headers: request.headers });
  if (url.pathname === "/cross-origin-redirect.m3u8") {
    response.writeHead(302, { location: `${otherOrigin}/main.m3u8` });
    response.end();
    return;
  }
  if (url.pathname === "/redirect.m3u8") {
    response.writeHead(302, { location: "/hls/main.m3u8" });
    response.end();
    return;
  }
  if (!authorized(request)) {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("forbidden");
    return;
  }
  if (url.pathname === "/hls/main.m3u8") {
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    response.end([
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:1",
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin"',
      '#EXT-X-MAP:URI="../segments/init.mp4"',
      "#EXTINF:1,",
      "child/child.m3u8",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"));
    return;
  }
  if (url.pathname === "/hls/child/child.m3u8") {
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    response.end([
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:1",
      "#EXTINF:1,",
      `${origin}/segments/segment.ts`,
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"));
    return;
  }
  if (url.pathname === "/large.m3u8") {
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    response.end("#EXTM3U\n" + "x".repeat(100));
    return;
  }
  if (url.pathname === "/slow.m3u8") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      response.end("#EXTM3U\n");
    }, 100);
    return;
  }
  if (url.pathname === "/video.mp4") {
    const body = Buffer.from("abcdefghij");
    const range = request.headers.range;
    if (range === "bytes=2-4") {
      response.writeHead(206, {
        "content-type": "video/mp4",
        "content-length": 3,
        "content-range": "bytes 2-4/10",
        "accept-ranges": "bytes",
      });
      response.end(body.subarray(2, 5));
      return;
    }
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": body.length,
      "accept-ranges": "bytes",
    });
    response.end(body);
    return;
  }
  if (url.pathname === "/keys/key.bin") {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(16, 1));
    return;
  }
  if (url.pathname === "/segments/init.mp4") {
    response.writeHead(200, { "content-type": "video/mp4" });
    response.end("init");
    return;
  }
  if (url.pathname === "/segments/segment.ts") {
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end("segment");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.referer === "https://source.example.invalid/"
    && request.headers["user-agent"] === "G22-fixture"
    && request.headers.authorization === "Bearer secret";
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
