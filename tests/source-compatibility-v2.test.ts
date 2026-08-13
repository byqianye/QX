import { describe, expect, it } from "vitest";

import { SourceCompatibilityAuditor, classifySourceCompatibility, detectCapabilities, type SourceProbeEngine } from "../src/spider/source-compatibility-v2.js";
import type { TvBoxConfig } from "../src/config/decoder.js";
import type { VodDetail, VodPage } from "../src/source/media-source.js";

function page(items: VodPage["items"]): VodPage {
  return { page: 1, items, raw: {} };
}

function detail(values: Record<string, unknown>): VodDetail {
  const id = String(values.vod_id ?? "id");
  return { ...values, id, name: String(values.vod_name ?? id), raw: { ...values } } as VodDetail;
}

describe("source compatibility v2", () => {
  it("runs legal search/detail/player phases and reports a fully playable source", async () => {
    const calls: string[] = [];
    const engine: SourceProbeEngine = {
      init: async () => { calls.push("init"); },
      search: async (keyword) => {
        calls.push(`search:${keyword}`);
        return page([{ id: "1", name: "庆余年", raw: {}, vod_id: "1", vod_name: "庆余年" }]);
      },
      detail: async () => {
        calls.push("detail");
        return [detail({ vod_id: "1", vod_name: "庆余年", vod_play_from: "主线", vod_play_url: "第一集$episode" })];
      },
      player: async () => ({ parse: 0, url: "https://media.invalid/episode.m3u8", headers: {} }),
      metadata: () => ({ classLoad: "PASS", resolvedClass: "com.github.catvod.spider.Jianpian" }),
    };
    const config: TvBoxConfig = { sites: [{ key: "jianpian", name: "荐片", type: 3, api: "csp_Jianpian" }] };
    const report = await new SourceCompatibilityAuditor({
      keywords: ["movie", "tv", "anime"],
      createEngine: () => engine,
    }).audit(config, "https://config.invalid/config.json");

    expect(report.summary.total).toBe(1);
    expect(report.sites[0]).toMatchObject({
      siteKey: "jianpian",
      classLoad: "PASS",
      resolvedClass: "com.github.catvod.spider.Jianpian",
      status: "FULLY_PLAYABLE",
      playable: true,
    });
    expect(calls.filter((value) => value.startsWith("search:"))).toHaveLength(3);
  });

  it("keeps static category detection independent of emoji-only source names", () => {
    const capabilities = detectCapabilities({ key: "pan", name: "云盘搜索", api: "csp_PanSearch", type: 3 });
    expect(capabilities.netdisk).toBe(true);
    expect(capabilities.vod).toBe(false);
    expect(capabilities.player).toBe(true);
  });

  it("distinguishes class failure and empty search from a runtime failure", () => {
    const capabilities = detectCapabilities({ key: "a", name: "影视", api: "csp_A", type: 3 });
    const empty = { status: "EMPTY" as const, durationMs: 3 };
    const pass = { status: "PASS" as const, durationMs: 3 };
    expect(classifySourceCompatibility({ capabilities, runtime: "android-dex", classLoad: "PASS", init: pass, search: empty, detail: pass, player: empty })).toBe("SEARCH_ONLY");
    expect(classifySourceCompatibility({ capabilities, runtime: "android-dex", classLoad: "FAIL", init: pass, search: empty, detail: pass, player: empty })).toBe("CLASS_NOT_FOUND");
  });

  it("enforces independent phase concurrency and isolates an authentication result", async () => {
    let activeInit = 0;
    let activeSearch = 0;
    let activeDetail = 0;
    let activePlayer = 0;
    let maxInit = 0;
    let maxSearch = 0;
    let maxDetail = 0;
    let maxPlayer = 0;
    const wait = async (milliseconds = 4): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const track = async (kind: "init" | "search" | "detail" | "player", action: () => Promise<void>): Promise<void> => {
      const active = kind === "init" ? ++activeInit : kind === "search" ? ++activeSearch : kind === "detail" ? ++activeDetail : ++activePlayer;
      if (kind === "init") maxInit = Math.max(maxInit, active);
      if (kind === "search") maxSearch = Math.max(maxSearch, active);
      if (kind === "detail") maxDetail = Math.max(maxDetail, active);
      if (kind === "player") maxPlayer = Math.max(maxPlayer, active);
      try { await action(); } finally {
        if (kind === "init") activeInit -= 1;
        if (kind === "search") activeSearch -= 1;
        if (kind === "detail") activeDetail -= 1;
        if (kind === "player") activePlayer -= 1;
      }
    };
    const config: TvBoxConfig = {
      sites: Array.from({ length: 6 }, (_, index) => ({ key: `site-${index}`, name: `源 ${index}`, type: 3, api: `csp_Test${index}` })),
    };
    const report = await new SourceCompatibilityAuditor({
      keywords: ["movie", "tv", "anime"],
      initConcurrency: 2,
      searchConcurrency: 4,
      detailConcurrency: 3,
      playerConcurrency: 2,
      createEngine: () => ({
        init: () => track("init", wait),
        search: () => track("search", wait).then(() => page([{ id: "1", name: "movie", raw: {} }])) as unknown as Promise<VodPage>,
        detail: () => track("detail", wait).then(() => [detail({ vod_id: "1", vod_name: "movie", vod_play_from: "main", vod_play_url: "ep$1" })]),
        player: () => track("player", wait).then(() => ({ status: "AUTH_REQUIRED" as const, parse: 0, url: "", headers: {}, message: "login required" })),
        metadata: () => ({ classLoad: "PASS" as const }),
      }),
    }).audit(config);

    expect(maxInit).toBeLessThanOrEqual(2);
    expect(maxSearch).toBeLessThanOrEqual(4);
    expect(maxDetail).toBeLessThanOrEqual(3);
    expect(maxPlayer).toBeLessThanOrEqual(2);
    expect(report.sites.every((site) => site.status === "AUTH_REQUIRED")).toBe(true);
    expect(report.sites.every((site) => site.authentication === "OTHER")).toBe(true);
  });
});
