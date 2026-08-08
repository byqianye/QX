import { describe, expect, it } from "vitest";

import {
  extractAndroidVodItems,
  firstAndroidPlaybackRequest,
  firstAndroidVodId,
  hasAndroidPlaybackFields,
  parseAndroidSpiderResult,
  validateAndroidDetail,
} from "../src/spider/android-spider-parsers.js";

describe("Android Spider result parsers", () => {
  it("parses the Host object, raw JSON, and list shapes", () => {
    const payload = { result: JSON.stringify({ list: [{ vod_id: "1", vod_name: "Demo" }] }) };
    expect(parseAndroidSpiderResult(payload)).toMatchObject({ list: [{ vod_id: "1" }] });
    expect(firstAndroidVodId(payload)).toBe("1");
    expect(extractAndroidVodItems({ list: [{ vod_id: "2" }] })).toHaveLength(1);
  });

  it("extracts playback lines and validates real detail fields", () => {
    const detail = {
      list: [{
        vod_id: "demo-1",
        vod_name: "Demo",
        vod_pic: "https://example.test/demo.jpg",
        vod_content: "A real detail",
        vod_play_from: "线路A$$$线路B",
        vod_play_url: "正片$https://example.test/play-1.m3u8#备用$https://example.test/play-2.m3u8$$$正片$https://example.test/play-3.m3u8",
      }],
    };
    expect(hasAndroidPlaybackFields(detail)).toBe(true);
    expect(firstAndroidPlaybackRequest(detail)).toEqual({ flag: "线路A", id: "https://example.test/play-1.m3u8" });
    expect(validateAndroidDetail(detail)).toEqual({ valid: true, missing: [] });
    expect(validateAndroidDetail({ list: [{ vod_id: "missing" }] })).toEqual({
      valid: false,
      missing: ["vod_name", "vod_pic", "vod_content"],
    });
  });
});
