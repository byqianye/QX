import { describe, expect, it } from "vitest";

import {
  ParseChainError,
  ParseChainResolver,
  type ParseRequest,
  type ParserCandidate,
} from "../src/desktop/parse-chain.js";

const baseRequest = (parserCandidates: readonly ParserCandidate[]): ParseRequest => ({
  sourceId: "fixture-source",
  flag: "default",
  originalUrl: "https://source.example.invalid/play",
  parserCandidates,
  headers: {},
  timeout: 100,
  playbackSessionId: "playback-fixture",
  allowedOrigins: ["https://media.example.invalid", "https://parser.example.invalid"],
});

describe("parse=1 chain", () => {
  it("does not fetch parse=0 and resolves parser candidates by priority with fallback", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/slow.json")) throw new Error("parser timeout");
      return new Response(JSON.stringify({
        url: "https://media.example.invalid/final.m3u8",
        headers: { Referer: "https://source.example.invalid/" },
      }), { headers: { "content-type": "application/json" } });
    };
    const resolver = new ParseChainResolver({ fetchImpl });

    await expect(resolver.resolve({
      ...baseRequest([]),
      originalUrl: "https://media.example.invalid/direct.mp4",
      parserCandidates: [],
      parse: 0,
    })).resolves.toMatchObject({ parse: 0, url: "https://media.example.invalid/direct.mp4", attempts: [] });

    const result = await resolver.resolve(baseRequest([
      candidate("slow", "json", "https://parser.example.invalid/slow.json", 1),
      candidate("json", "json", "https://parser.example.invalid/final.json", 2),
      candidate("never", "direct", "https://media.example.invalid/never.mp4", 3),
    ]));

    expect(result).toMatchObject({
      parse: 0,
      url: "https://media.example.invalid/final.m3u8",
      headers: { Referer: "https://source.example.invalid/" },
      parserId: "json",
    });
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["error", "succeeded"]);
    expect(calls).toEqual([
      "https://parser.example.invalid/slow.json",
      "https://parser.example.invalid/final.json",
    ]);
    resolver.close();
  });

  it("supports redirect and explicit HTML-declared media fields", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/redirect")) {
        return new Response(null, { status: 302, headers: { location: "https://media.example.invalid/redirected.mp4" } });
      }
      return new Response('<html><video data-media-url="https://media.example.invalid/declared.m3u8"></video></html>', {
        headers: { "content-type": "text/html" },
      });
    };
    const resolver = new ParseChainResolver({ fetchImpl });

    await expect(resolver.resolve(baseRequest([
      candidate("redirect", "redirect", "https://parser.example.invalid/redirect", 1),
    ]))).resolves.toMatchObject({ url: "https://media.example.invalid/redirected.mp4", parserId: "redirect" });

    await expect(resolver.resolve(baseRequest([
      candidate("html", "html-declared", "https://parser.example.invalid/page", 1),
    ]))).resolves.toMatchObject({ url: "https://media.example.invalid/declared.m3u8", parserId: "html" });
    resolver.close();
  });

  it("rechecks the origin after a redirect", async () => {
    const resolver = new ParseChainResolver({
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://outside.example.invalid/media.m3u8" },
      }),
    });

    await expect(resolver.resolve(baseRequest([
      candidate("cross-origin", "redirect", "https://parser.example.invalid/redirect", 1),
    ]))).rejects.toMatchObject({ code: "PARSE_ORIGIN_BLOCKED" });
    resolver.close();
  });

  it("records an isolated timeout, then stops after the first success", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/timeout")) {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return new Response(JSON.stringify({ url: "https://media.example.invalid/timeout-fallback.m3u8" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const resolver = new ParseChainResolver({ fetchImpl });

    const result = await resolver.resolve(baseRequest([
      candidate("timeout", "json", "https://parser.example.invalid/timeout", 1, 5),
      candidate("fallback", "json", "https://parser.example.invalid/fallback", 2, 100),
    ]));

    expect(result.url).toBe("https://media.example.invalid/timeout-fallback.m3u8");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["timeout", "succeeded"]);
    expect(calls).toEqual([
      "https://parser.example.invalid/timeout",
      "https://parser.example.invalid/fallback",
    ]);
    resolver.close();
  });

  it("supports source-provided results and reports recursive depth failures safely", async () => {
    const sourceResolver = new ParseChainResolver({
      sourceProvided: async () => ({
        parse: 0,
        url: "https://media.example.invalid/source-provided.m3u8",
        headers: { Referer: "https://source.example.invalid/" },
      }),
    });
    await expect(sourceResolver.resolve(baseRequest([
      candidate("source", "source-provided", "", 1),
    ]))).resolves.toMatchObject({
      parserId: "source",
      url: "https://media.example.invalid/source-provided.m3u8",
      headers: { Referer: "https://source.example.invalid/" },
    });
    sourceResolver.close();

    const sourceTimeoutResolver = new ParseChainResolver({
      sourceProvided: async (_candidate, request) => {
        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        throw new Error("unreachable");
      },
    });
    await expect(sourceTimeoutResolver.resolve(baseRequest([
      candidate("source-timeout", "source-provided", "", 1, 5),
    ]))).rejects.toMatchObject({ code: "PARSE_TIMEOUT" });
    expect(sourceTimeoutResolver.activeRequestCount).toBe(0);
    sourceTimeoutResolver.close();

    let count = 0;
    const recursiveResolver = new ParseChainResolver({
      maxDepth: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        parse: 1,
        url: `https://media.example.invalid/recursive-${++count}.m3u8`,
      }), { headers: { "content-type": "application/json" } }),
    });
    await expect(recursiveResolver.resolve(baseRequest([
      candidate("recursive", "json", "", 1),
    ]))).rejects.toMatchObject({ code: "PARSE_MAX_DEPTH" });
    recursiveResolver.close();
  });

  it("rejects protocol violations, oversized responses, cycles, and cancellation", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/large")) return new Response("0123456789", { headers: { "content-length": "10" } });
      if (url.endsWith("/cycle")) return new Response(JSON.stringify({ parse: 1, url: "https://parser.example.invalid/cycle" }));
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      throw new Error("unreachable");
    };
    const resolver = new ParseChainResolver({ fetchImpl, maxResponseBytes: 100, maxDepth: 1 });

    await expect(resolver.resolve(baseRequest([
      candidate("file", "direct", "file:///secret.mp4", 1),
    ]))).rejects.toMatchObject({ code: "PARSE_PROTOCOL_BLOCKED" });
    const largeResolver = new ParseChainResolver({ fetchImpl, maxResponseBytes: 5, maxDepth: 1 });
    await expect(largeResolver.resolve(baseRequest([
      candidate("large", "json", "https://parser.example.invalid/large", 1),
    ]))).rejects.toMatchObject({ code: "PARSE_RESPONSE_TOO_LARGE" });
    largeResolver.close();
    await expect(resolver.resolve(baseRequest([
      candidate("cycle", "json", "https://parser.example.invalid/cycle", 1),
    ]))).rejects.toMatchObject({ code: "PARSE_CYCLE_DETECTED" });

    const pending = resolver.resolve({
      ...baseRequest([candidate("wait", "json", "https://parser.example.invalid/wait", 1)]),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "PARSE_CANCELLED" });
    expect(resolver.activeRequestCount).toBe(0);
    resolver.close();

    const closeResolver = new ParseChainResolver({ fetchImpl });
    const closePending = closeResolver.resolve(baseRequest([
      candidate("close", "json", "https://parser.example.invalid/wait", 1),
    ]));
    closeResolver.close();
    await expect(closePending).rejects.toMatchObject({ code: "PARSE_CANCELLED" });
    expect(closeResolver.activeRequestCount).toBe(0);
  });
});

function candidate(
  id: string,
  type: ParserCandidate["type"],
  endpoint: string,
  priority: number,
  timeout = 20,
): ParserCandidate {
  return {
    id,
    name: id,
    type,
    ...(endpoint ? { endpoint } : {}),
    enabled: true,
    priority,
    timeout,
  };
}
