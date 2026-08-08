import { describe, expect, it } from "vitest";

import { normalizePlayerResult } from "../src/source/normalizers.js";

describe("player result normalization", () => {
  it("preserves FongMi playback metadata while normalizing the playable URL", () => {
    const result = normalizePlayerResult({
      parse: 1,
      url: "https://media.example.invalid/input",
      playUrl: "https://media.example.invalid/original.m3u8",
      header: { Referer: "https://source.example.invalid/" },
      jx: 1,
      format: "hls",
      flag: "线路一",
      jxFrom: "解析器A",
    });

    expect(result).toMatchObject({
      parse: 1,
      url: "https://media.example.invalid/input",
      playUrl: "https://media.example.invalid/original.m3u8",
      jx: 1,
      format: "hls",
      flag: "线路一",
      jxFrom: "解析器A",
      headers: { Referer: "https://source.example.invalid/" },
    });
  });
});
