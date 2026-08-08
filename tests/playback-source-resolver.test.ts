import { describe, expect, it } from "vitest";

import { normalizeVodTitle, PlaybackSourceResolver, type PlaybackSourceSite } from "../src/desktop/playback-source-resolver.js";
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
    expect(result.searchedSites).toEqual(expect.arrayContaining(["disabled", "playable"]));
    expect(result.searchedSites).toHaveLength(2);
    expect(result.failedSites).toEqual([]);
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({
      siteKey: "playable",
      score: 140,
      playable: true,
      hasPlayFrom: true,
      hasPlayUrl: true,
    })]));
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

  it("marks one site timeout while continuing the remaining sites", async () => {
    const candidate = vod({ vod_id: "fast-1", vod_name: "超时隔离", vod_year: "2026", type_name: "剧情" });
    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "超时隔离", vod_year: "2026", type_name: "剧情" }),
      [
        site("slow", false, true, async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return [candidate];
        }),
        site("fast", false, true, async () => [candidate]),
      ],
      { perSiteTimeoutMs: 20, globalTimeoutMs: 250 },
    );

    expect(result.diagnostics.sites).toContainEqual(expect.objectContaining({
      siteKey: "slow",
      search: "timeout",
    }));
    expect(result.diagnostics.searchSuccessSites).toContain("fast");
  });

  it("searches every configured site except the active metadata site", async () => {
    const searched: string[] = [];
    const candidate = vod({ vod_id: "shared-1", vod_name: "共享标题", vod_year: "2026", type_name: "剧情" });
    const sites: PlaybackSourceSite[] = [
      site("douban", false, true, async () => [candidate]),
      ...["site-a", "site-b", "site-c", "site-d"].map((siteKey) => site(
        siteKey,
        false,
        true,
        async () => {
          searched.push(siteKey);
          return [candidate];
        },
      )),
    ];

    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "共享标题", vod_year: "2026", type_name: "剧情" }),
      sites,
      { currentSiteKey: "douban", configSiteCount: 5 },
    );

    expect(searched).toHaveLength(4);
    expect(result.diagnostics).toMatchObject({
      configSiteCount: 5,
      searchableSites: 4,
      runtimeSupportedSites: 4,
      searchedSites: expect.arrayContaining(["site-a", "site-b", "site-c", "site-d"]),
    });
  });

  it("uses complete search even when quickSearch is disabled", async () => {
    const quickValues: boolean[] = [];
    const candidate = vod({ vod_id: "json-1", vod_name: "完整搜索", vod_year: "2026", type_name: "剧情" });
    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "完整搜索", vod_year: "2026", type_name: "剧情" }),
      [{
        siteKey: "json",
        siteName: "JSON",
        type: 1,
        searchable: undefined,
        quickSearch: 0,
        supported: true,
      }],
      {
        engineFactory: {
          create: () => ({
            init: async () => undefined,
            search: async (_query, quick) => {
              quickValues.push(quick);
              return [candidate];
            },
            detail: async () => candidate,
          }),
        },
      },
    );

    expect(quickValues).toEqual([false]);
    expect(result.candidates[0]?.playable).toBe(false);
  });

  it("marks a candidate playable from detail playback fields without requiring parsed episodes", async () => {
    const searchResult = vod({
      vod_id: "detail-1",
      vod_name: "详情才有线路",
      vod_year: "2026",
      type_name: "剧情",
    });
    const detail = vod({
      vod_id: "detail-1",
      vod_name: "详情才有线路",
      vod_year: "2026",
      type_name: "剧情",
      vod_play_from: "主线",
      vod_play_url: "opaque-playback-value",
    });
    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "详情才有线路", vod_year: "2026", type_name: "剧情" }),
      [site("detail", false, true, async () => [searchResult], async () => detail)],
    );

    expect(result.candidates[0]).toMatchObject({
      playable: true,
      hasPlayFrom: true,
      hasPlayUrl: true,
    });
    expect(result.diagnostics.playableCandidateCount).toBe(1);
  });

  it("lazy initializes an engine before searching", async () => {
    const calls: string[] = [];
    const candidate = vod({ vod_id: "lazy-1", vod_name: "懒加载", vod_year: "2026", type_name: "剧情" });
    await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "懒加载", vod_year: "2026", type_name: "剧情" }),
      [{ siteKey: "lazy", siteName: "Lazy", ext: "lazy-ext", supported: true }],
      {
        engineFactory: {
          create: () => ({
            init: async (ext) => { calls.push(`init:${ext}`); },
            search: async () => { calls.push("search"); return [candidate]; },
            detail: async () => { calls.push("detail"); return candidate; },
          }),
        },
      },
    );
    expect(calls).toEqual(["init:lazy-ext", "search", "detail"]);
  });

  it("records unsupported type 3 runtime without stopping supported sites", async () => {
    const candidate = vod({ vod_id: "supported-1", vod_name: "跨运行时", vod_year: "2026", type_name: "剧情" });
    const result = await new PlaybackSourceResolver().resolve(
      vod({ vod_id: "meta-1", vod_name: "跨运行时", vod_year: "2026", type_name: "剧情" }),
      [
        {
          siteKey: "jar",
          siteName: "JAR Spider",
          type: 3,
          api: "csp_Unknown",
          supported: false,
          skipReason: "jar_spider_not_supported",
        },
        site("supported", false, true, async () => [candidate]),
      ],
    );

    expect(result.diagnostics.unsupportedSiteCount).toBe(1);
    expect(result.diagnostics.sites).toContainEqual(expect.objectContaining({
      siteKey: "jar",
      initialization: "unsupported",
      skipReason: "jar_spider_not_supported",
    }));
    expect(result.searchedSites).toContain("supported");
  });

  it("normalizes punctuation and HTML entities without fuzzy title matching", () => {
    expect(normalizeVodTitle(" 蜘蛛侠：崭新之日 ")).toBe(normalizeVodTitle("蜘蛛侠:崭新之日"));
    expect(normalizeVodTitle("Tom &amp; Jerry")).toBe("tom&jerry");
    expect(normalizeVodTitle("蜘蛛侠：崭新之日")).not.toBe(normalizeVodTitle("蜘蛛侠崭新之日特别篇"));
  });
});

function site(
  siteKey: string,
  playback: boolean,
  searchable: boolean,
  search: PlaybackSourceSite["search"],
  detail: PlaybackSourceSite["detail"] = async (id) => vod({ vod_id: id, vod_name: "同名标题" }),
): PlaybackSourceSite {
  return {
    siteKey,
    siteName: siteKey,
    enabled: true,
    searchable,
    playback,
    ...(search ? { search } : {}),
    detail,
  };
}
