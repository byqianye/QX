import { describe, expect, it } from "vitest";

import { mergeVodDisplayFields } from "../src/desktop/vod-merge.js";
import { AggregateSearchCoordinator } from "../src/search/aggregate-search.js";
import type { VodPage } from "../src/source/media-source.js";
import { normalizeVod } from "../src/source/normalizers.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function page(items: Array<Record<string, unknown>>): VodPage {
  return {
    page: 1,
    items: items.map((raw, index) => ({
      ...raw,
      id: String(raw.id ?? index),
      name: String(raw.name ?? raw.title ?? raw.id ?? index),
      raw,
    })),
    raw: { list: items },
  };
}

describe("media description cleanup", () => {
  it("decodes entities and strips source HTML before display", () => {
    const encoded = "<p><span style=\"color: rgb(51, 51, 51)\">简介内容&nbsp; &amp; 更多</span></p>";
    const normalized = normalizeVod({ vod_id: "movie-1", vod_name: "影片", vod_content: encoded });
    const merged = mergeVodDisplayFields(
      { vod_id: "movie-1", vod_name: "影片", vod_content: encoded },
      { vod_id: "movie-1", vod_name: "影片", vod_content: encoded },
    );

    expect(normalized.raw.vod_content).toBe("简介内容 & 更多");
    expect(merged?.vod_content).toBe("简介内容 & 更多");
  });
});

describe("aggregate search source priority", () => {
  it("keeps the current source ahead of faster secondary sources", async () => {
    const coordinator = new AggregateSearchCoordinator([
      {
        id: "current",
        search: async () => {
          await wait(20);
          return page([
            { id: "current-same", name: "Same title", year: "2026" },
            { id: "current-only", name: "Current only" },
          ]);
        },
      },
      {
        id: "secondary",
        search: async () => {
          await wait(1);
          return page([
            { id: "secondary-same", name: "Same title", year: "2026" },
            { id: "secondary-only", name: "Secondary only" },
          ]);
        },
      },
    ]);

    const result = await coordinator.search("same", { preferredSourceId: "current" });

    expect(result.groups.map((group) => group.name)).toEqual([
      "Same title",
      "Current only",
      "Secondary only",
    ]);
    expect(result.groups[0]?.sourceIds).toEqual(["current", "secondary"]);
    expect(result.groups[0]?.items[0]?.id).toBe("current-same");
  });
});
