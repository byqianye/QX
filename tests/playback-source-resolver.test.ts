import { describe, expect, it } from "vitest";

import { PlaybackSourceResolver, type PlaybackSourceSite } from "../src/desktop/playback-source-resolver.js";
import type { Vod } from "../src/source/media-source.js";

function vod(values: Record<string, unknown>): Vod {
  const id = String(values.vod_id ?? values.id ?? "candidate");
  const name = String(values.vod_name ?? values.name ?? id);
  return { ...values, id, name, raw: { ...values } };
}

describe("PlaybackSourceResolver", () => {
  it("filters the current and non-searchable sites and confirms playback via detail", async () => {
    const calls: string[] = [];
    const candidate = vod({
      vod_id: "play-1",
      vod_name: "欢迎来龙餐厅",
      vod_year: "2026",
      type_name: "剧情",
    });
    const sites: PlaybackSourceSite[] = [
      site("douban", false, false, async () => [candidate]),
      site("disabled", false, true, async () => [candidate]),
      site("playable", true, true, async (query) => {
        calls.push(`search:${query}`);
        return [candidate];
      }, async (id) => {
        calls.push(`detail:${id}`);
        return vod({
          vod_id: "play-1",
          vod_name: "欢迎来龙餐厅",
          vod_year: "2026",
          type_name: "剧情",
          vod_play_from: "主线",
          vod_play_url: "第一集$episode-1",
        });
      }),
    ];

    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "欢迎来龙餐厅", vod_year: "2026", type_name: "剧情" }),
      sites,
      { currentSiteKey: "douban" },
    );

    expect(calls).toEqual(["search:欢迎来龙餐厅", "detail:play-1"]);
    expect(result.searchedSites).toEqual(["playable"]);
    expect(result.failedSites).toEqual([]);
    expect(result.candidates).toMatchObject([{
      siteKey: "playable",
      score: 140,
      playable: true,
      hasPlayFrom: true,
      hasPlayUrl: true,
    }]);
  });

  it("does not treat a fuzzy title match as a playable source", async () => {
    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "欢迎来龙餐厅" }),
      [site("playable", true, true, async () => [vod({ vod_id: "other", vod_name: "欢迎来龙餐厅特别篇" })])],
    );

    expect(result.candidates).toEqual([]);
  });

  it("keeps one failing site from aborting other sites and caps workers at five", async () => {
    let active = 0;
    let maximum = 0;
    const sites = Array.from({ length: 7 }, (_, index) => site(
      `site-${index}`,
      true,
      true,
      async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 10 : 1));
        active -= 1;
        if (index === 0) throw new Error("source down");
        return [vod({ vod_id: `id-${index}`, vod_name: "同名标题" })];
      },
    ));

    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "同名标题" }),
      sites,
      { perSiteTimeoutMs: 100, globalTimeoutMs: 500 },
    );

    expect(maximum).toBeLessThanOrEqual(5);
    expect(result.failedSites).toContainEqual({ siteKey: "site-0", message: "source down" });
    expect(result.successfulSites).toHaveLength(6);
  });
});

function site(
  siteKey: string,
  playback: boolean,
  searchable: boolean,
  search: PlaybackSourceSite["search"],
  detail: PlaybackSourceSite["detail"] = async (id) => vod({ vod_id: id, vod_name: "同名标题" }),
): PlaybackSourceSite {
  return { siteKey, siteName: siteKey, enabled: true, searchable, playback, search, detail };
}
