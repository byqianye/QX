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

  it("maps a real Android Spider login response to AUTH_REQUIRED", () => {
    const result = normalizePlayerResult({
      parse: 0,
      url: "",
      msg: "未登录UC, 请去配置中心设置",
    });

    expect(result).toMatchObject({
      parse: 0,
      url: "",
      status: "AUTH_REQUIRED",
      message: "未登录UC, 请去配置中心设置",
    });
  });

  it("parses JSON encoded headers and fills the unified QX context", () => {
    const result = normalizePlayerResult({
      parse: 0,
      url: "https://media.example.invalid/video.mp4",
      header: JSON.stringify({
        Referer: "https://source.example.invalid/",
        "User-Agent": "QX-test",
        Cookie: "sid=redacted",
      }),
    }, {
      sourceKey: "csp_Jianpian",
      sourceName: "Jianpian",
      episodeId: "episode-1",
    });

    expect(result).toMatchObject({
      parse: 0,
      jx: 0,
      sourceKey: "csp_Jianpian",
      sourceName: "Jianpian",
      episodeId: "episode-1",
      headers: {
        Referer: "https://source.example.invalid/",
        "User-Agent": "QX-test",
        Cookie: "sid=redacted",
      },
    });
  });

  it("accepts the legacy Android Spider link field as the playable URL", () => {
    const result = normalizePlayerResult({
      parse: 0,
      link: "https://media.example.invalid/jianpian.m3u8",
    });

    expect(result).toMatchObject({
      parse: 0,
      url: "https://media.example.invalid/jianpian.m3u8",
      status: "DIRECT",
    });
  });
});
