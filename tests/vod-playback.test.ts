import { describe, expect, it } from "vitest";

import { PlaybackFormatError, parseVodPlayback } from "../src/desktop/vod-playback.js";

describe("CatVod playback fields", () => {
  it("parses Unicode lines, episodes, query parameters and percent-encoded reserved characters", () => {
    const catalog = parseVodPlayback({
      vod_play_from: "线路 一 $$$ 线路二",
      vod_play_url: [
        "第一 集$https://media.example/one?id=1%24a#第二 集$https://media.example/two?q=空 格",
        "单集$https://media.example/other",
      ].join("$$$"),
    });

    expect(catalog).toMatchObject({
      lines: [
        {
          name: "线路 一 ",
          episodes: [
            { name: "第一 集", id: "https://media.example/one?id=1%24a" },
            { name: "第二 集", id: "https://media.example/two?q=空 格" },
          ],
        },
        {
          name: " 线路二",
          episodes: [{ name: "单集", id: "https://media.example/other" }],
        },
      ],
    });
  });

  it("keeps duplicate episode names, supplies missing names and preserves empty lines", () => {
    const catalog = parseVodPlayback({
      vod_play_from: "线路一 $$$",
      vod_play_url: "$https://media.example/one#同名$https://media.example/two#同名$https://media.example/three $$$",
    });
    if (!catalog) throw new Error("expected playback catalog");

    expect(catalog.lines).toHaveLength(2);
    expect(catalog.lines[0]?.episodes[0]).toMatchObject({
      name: "第 1 集",
      id: "https://media.example/one",
    });
    expect(catalog.lines[0]?.episodes.map((episode) => episode.name)).toEqual([
      "第 1 集",
      "同名",
      "同名",
    ]);
    expect(catalog.lines[1]?.episodes).toEqual([]);
  });

  it("returns no catalog when detail has no playback fields", () => {
    expect(parseVodPlayback({ vod_name: "Metadata only" })).toBeNull();
  });

  it("rejects malformed fields instead of guessing a playback id", () => {
    expect(() => parseVodPlayback({ vod_play_from: "线路一", vod_play_url: "第一集$" }))
      .toThrowError(PlaybackFormatError);
    expect(() => parseVodPlayback({ vod_play_from: "线路一", vod_play_url: "第一集$id$ambiguous" }))
      .toThrowError(PlaybackFormatError);
    expect(() => parseVodPlayback({
      vod_play_from: "线路一",
      vod_play_url: "第一集$https://media.example/video#fragment",
    })).toThrowError(PlaybackFormatError);
    expect(() => parseVodPlayback({ vod_play_from: "线路一", vod_play_url: "裸 ID" }))
      .toThrowError(PlaybackFormatError);
    expect(() => parseVodPlayback({ vod_play_from: 1, vod_play_url: "第一集$id" }))
      .toThrowError(PlaybackFormatError);
  });
});
