import { describe, expect, it } from "vitest";

import {
  PlaybackRuleEngine,
  type PlaybackRule,
} from "../src/desktop/playback-rules.js";

const context = {
  sourceId: "source-a",
  playbackSessionId: "session-a",
  url: "https://media.example.invalid/hls/main.m3u8",
};

describe("PlaybackRuleEngine", () => {
  it("applies ordered URL, query, path, host and header rules only to the matching source/session", () => {
    const engine = new PlaybackRuleEngine([
      rule("query", 1, { type: "query-parameter", name: "rule", value: "1" }),
      rule("path", 2, { type: "path-replace", from: "/hls", to: "/media" }),
      rule("host", 3, { type: "host-replace", host: "cdn.example.invalid" }),
      rule("headers", 4, { type: "header-merge", headers: { Referer: "https://source.example.invalid/" } }),
    ]);

    const result = engine.applySource({ url: context.url, headers: { "User-Agent": "fixture" } }, context);
    expect(result.url).toBe("https://cdn.example.invalid/media/main.m3u8?rule=1");
    expect(result.headers).toEqual({
      "User-Agent": "fixture",
      Referer: "https://source.example.invalid/",
    });
    expect(result.matchedRuleIds).toEqual(["query", "path", "host", "headers"]);
    expect(result.warnings).toContain("rule conflict in url");

    const isolated = engine.applySource(
      { url: context.url, headers: {} },
      { ...context, sourceId: "source-b" },
    );
    expect(isolated).toMatchObject({ url: context.url, headers: {}, matchedRuleIds: [] });
  });

  it("rewrites relative media URIs, key and map attributes, then filters explicit markers", () => {
    const engine = new PlaybackRuleEngine([
      rule("uri", 1, { type: "uri-rewrite", from: "/segments/", to: "/cdn/segments/" }, { pathPrefix: "/hls" }),
      rule("marker", 2, { type: "marker-filter", markers: ["#EXT-X-CUE-OUT"] }, { pathPrefix: "/hls" }),
    ]);
    const body = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin"',
      '#EXT-X-MAP:URI="../segments/init.mp4"',
      "#EXT-X-CUE-OUT:DURATION=1",
      "#EXTINF:1,",
      "../segments/segment.m4s",
      "#EXT-X-DISCONTINUITY",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");

    const result = engine.applyPlaylist(body, context.url, context);
    expect(result.body).toContain('#EXT-X-KEY:METHOD=AES-128,URI="https://media.example.invalid/keys/key.bin"');
    expect(result.body).toContain('#EXT-X-MAP:URI="https://media.example.invalid/cdn/segments/init.mp4"');
    expect(result.body).toContain("https://media.example.invalid/cdn/segments/segment.m4s");
    expect(result.body).not.toContain("#EXT-X-CUE-OUT");
    expect(result.removedNodes).toBe(1);
    expect(result.keptNodes).toBe(1);
    expect(result.matchedRuleIds).toEqual(["uri", "marker"]);
  });

  it("rejects an empty playlist and produces a redacted dry run", () => {
    const engine = new PlaybackRuleEngine([
      rule("remove", 1, { type: "line-filter", contains: "segment" }),
    ]);
    const body = "#EXTM3U\n#EXTINF:1,\nsegment.m4s\n";
    expect(() => engine.applyPlaylist(body, context.url, context)).toThrowError(
      expect.objectContaining({ code: "PLAYBACK_RULE_INVALID" }),
    );

    const dryRun = new PlaybackRuleEngine([
      rule("query", 1, { type: "query-parameter", name: "token", value: "secret" }),
    ]).dryRunSource(
      { url: "https://media.example.invalid/video.mp4?token=old", headers: {} },
      context,
    );
    expect(dryRun.originalUrl).toContain("?[redacted]");
    expect(dryRun.rewrittenUrl).toContain("?[redacted]");
    expect(dryRun.redactedDiff).not.toContain("secret");
  });
});

function rule(
  id: string,
  priority: number,
  action: PlaybackRule["action"],
  match: PlaybackRule["match"] = {},
): PlaybackRule {
  return {
    id,
    sourceId: "source-a",
    enabled: true,
    priority,
    match,
    action,
    scope: "source",
    safeDescription: `fixture ${id}`,
  };
}
