import { describe, expect, it } from "vitest";

import { mergeVodDisplayFields } from "../src/desktop/vod-merge.js";

describe("mergeVodDisplayFields", () => {
  it("preserves a non-empty list poster when detail poster is empty", () => {
    const merged = mergeVodDisplayFields(
      {
        vod_id: "movie-1",
        vod_name: "列表标题",
        vod_pic: "https://img.example/list.jpg",
        vod_play_from: "伪造线路",
        vod_play_url: "第一集$fake",
      },
      {
        vod_id: "movie-1",
        vod_name: "",
        vod_pic: "",
        vod_year: "2026",
      },
    );

    expect(merged).toMatchObject({
      vod_name: "列表标题",
      vod_pic: "https://img.example/list.jpg",
      vod_year: "2026",
    });
    expect(merged).not.toHaveProperty("vod_play_from");
    expect(merged).not.toHaveProperty("vod_play_url");
  });

  it("prefers a non-empty detail poster", () => {
    const merged = mergeVodDisplayFields(
      { vod_name: "列表标题", vod_pic: "https://img.example/list.jpg" },
      { vod_name: "详情标题", vod_pic: "https://img.example/detail.jpg" },
    );

    expect(merged).toMatchObject({
      vod_name: "详情标题",
      vod_pic: "https://img.example/detail.jpg",
    });
  });

  it("leaves an empty poster for the renderer fallback", () => {
    const merged = mergeVodDisplayFields(
      { vod_id: "movie-1", vod_name: "列表标题", vod_pic: "" },
      { vod_id: "movie-1", vod_name: "详情标题", vod_pic: null },
    );

    expect(merged).not.toHaveProperty("vod_pic");
  });
});
