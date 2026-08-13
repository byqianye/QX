import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MediaResolver, detectMediaType, mediaTypeFromUrl } from "../src/desktop/media-resolver.js";
import { PlaybackProxyServer } from "../src/desktop/playback-proxy.js";
import type { QxPlayerResult } from "../src/source/media-source.js";

describe("MediaResolver", () => {
  let upstream: Server;
  let origin: string;

  beforeAll(async () => {
    upstream = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": "5",
      });
      response.end("video");
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  it("detects common media URL forms before probing", () => {
    expect(mediaTypeFromUrl("https://media.example.invalid/master.m3u8?token=1")).toBe("hls");
    expect(mediaTypeFromUrl("https://media.example.invalid/stream.mpd")).toBe("dash");
    expect(mediaTypeFromUrl("https://media.example.invalid/episode.mp4")).toBe("mp4");
    expect(mediaTypeFromUrl("https://media.example.invalid/live.flv")).toBe("flv");
  });

  it("uses content type when a direct URL has no useful extension", async () => {
    const type = await detectMediaType("https://media.example.invalid/video", {}, undefined, {
      fetchImpl: async () => new Response(null, { status: 200, headers: { "content-type": "video/mp4" } }),
    });
    expect(type).toBe("mp4");
  });

  it("resolves a direct QX result through a localhost MediaProxySession", async () => {
    const proxy = new PlaybackProxyServer({ allowedOrigins: [origin] });
    const resolver = new MediaResolver(proxy);
    const result: QxPlayerResult = {
      parse: 0,
      jx: 0,
      url: `${origin}/video`,
      headers: {},
      sourceKey: "csp_Jianpian",
      sourceName: "Jianpian",
      episodeId: "episode-1",
    };

    const resolved = await resolver.resolve(result, {
      playbackSessionId: "playback-1",
      sourceKey: result.sourceKey,
      sourceName: result.sourceName,
      episodeId: result.episodeId,
    });

    expect(resolved).toMatchObject({
      mediaType: "mp4",
      viaProxy: true,
      sourceKey: "csp_Jianpian",
      originalUrl: result.url,
      proxySession: {
        id: "playback-1",
        sourceKey: "csp_Jianpian",
        episodeId: "episode-1",
        originalUrl: result.url,
        headers: {},
      },
    });
    expect(new URL(resolved.url).hostname).toBe("127.0.0.1");
    expect(resolved.headers).toEqual({});
    expect(await fetch(resolved.url)).toMatchObject({ status: 200 });

    await resolved.proxySession?.close();
    await proxy.close();
  });

  it("does not bypass ParseManager results", async () => {
    const proxy = new PlaybackProxyServer({ allowedOrigins: [origin] });
    const resolver = new MediaResolver(proxy);
    await expect(resolver.resolve({
      parse: 1,
      jx: 0,
      url: `${origin}/video`,
      headers: {},
      sourceKey: "csp_Jianpian",
      sourceName: "Jianpian",
      episodeId: "episode-1",
    }, {
      playbackSessionId: "playback-2",
      sourceKey: "csp_Jianpian",
      sourceName: "Jianpian",
      episodeId: "episode-1",
    })).rejects.toMatchObject({ code: "MEDIA_PARSE_REQUIRED" });
    await proxy.close();
  });
});
