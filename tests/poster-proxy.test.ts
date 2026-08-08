import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { POSTER_ROUTE_PREFIX, PosterProxy, parsePosterReference } from "../src/desktop/poster-proxy.js";

describe("poster proxy", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) continue;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("parses TVBox poster header suffixes without exposing arbitrary headers", () => {
    expect(parsePosterReference(
      "https://img.example.test/poster.jpg@Referer=https://api.example.test/@User-Agent=fixture",
    )).toEqual({
      url: "https://img.example.test/poster.jpg",
      headers: {
        Referer: "https://api.example.test/",
        "User-Agent": "fixture",
      },
    });
    expect(parsePosterReference("file:///secret.jpg")).toBeNull();
  });

  it("serves registered posters through the local route with upstream headers", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        Referer: "https://api.example.test/",
        "User-Agent": "fixture",
      });
      return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
    });
    const proxy = new PosterProxy({ fetchImpl });
    const item = proxy.decorateItem({
      vod_id: "poster-1",
      vod_pic: "https://img.example.test/poster.jpg@Referer=https://api.example.test/@User-Agent=fixture",
    });
    const path = item.vod_pic as string;
    expect(path).toMatch(/^\/api\/poster\/[a-f0-9]{40}$/);

    const server = createServer((request, response) => {
      void proxy.handle(new URL(request.url ?? "/", "http://127.0.0.1").pathname, response);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(proxy.diagnostics(path.slice(POSTER_ROUTE_PREFIX.length))).toMatchObject({
      sourceKey: "unknown",
      originalUrl: "https://img.example.test/poster.jpg@Referer=https://api.example.test/@User-Agent=fixture",
      resolvedUrl: "https://img.example.test/poster.jpg",
      proxyHit: true,
      httpStatus: 200,
      fallbackReason: null,
    });
  });

  it("records a safe fallback reason when the upstream poster fails", async () => {
    const proxy = new PosterProxy({
      fetchImpl: vi.fn(async () => new Response("upstream failure", { status: 503 })),
    });
    const item = proxy.decorateItem({
      vod_id: "poster-failed",
      vod_pic: "https://img.example.test/poster.jpg@Cookie=secret-cookie",
    }, "csp_Douban");
    const path = item.vod_pic as string;
    const server = createServer((request, response) => {
      void proxy.handle(new URL(request.url ?? "/", "http://127.0.0.1").pathname, response);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    expect(response.status).toBe(502);
    const diagnostics = proxy.diagnostics(path.slice(POSTER_ROUTE_PREFIX.length));
    expect(diagnostics).toMatchObject({
      sourceKey: "csp_Douban",
      originalUrl: "https://img.example.test/poster.jpg@Cookie=<redacted>",
      proxyHit: true,
      httpStatus: 503,
      fallbackReason: "POSTER_HTTP_ERROR",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret-cookie");
  });
});
