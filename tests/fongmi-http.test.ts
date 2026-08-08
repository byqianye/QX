import { describe, expect, it, vi } from "vitest";

import {
  normalizeFongMiConfig,
  resolveFongMiReference,
} from "../src/config/fongmi.js";
import { resolveDesktopSourceBinding } from "../src/desktop/source-router.js";
import { parseVodPlayback } from "../src/desktop/vod-playback.js";
import { HttpDesktopClient } from "../src/spider/http-client.js";

describe("FongMi HTTP source compatibility", () => {
  it("normalizes site fields and resolves relative HTTP references", () => {
    const config = normalizeFongMiConfig({
      sites: [{
        key: "cms",
        name: "CMS",
        type: 4,
        api: "./api.php/provide/vod/",
        ext: { token: "fixture" },
        header: { Referer: "https://example.test/", Cookie: "sid=fixture" },
        searchable: 1,
        quickSearch: 1,
        filterable: 1,
        changeable: 0,
        timeout: 15,
        categories: ["电影", 1],
      }],
    }, "https://config.example.test/tvbox/config.json");

    expect(config.sites[0]).toMatchObject({
      key: "cms",
      type: 4,
      endpoint: "https://config.example.test/tvbox/api.php/provide/vod/",
      searchable: true,
      quickSearch: true,
      filterable: true,
      changeable: false,
      timeoutMs: 15_000,
      headers: { Referer: "https://example.test/", Cookie: "sid=fixture" },
      categories: ["电影"],
    });
    expect(resolveFongMiReference("file:///secret", "https://config.example.test/config.json")).toBeUndefined();
  });

  it("routes type 0/1/4 sites to the HTTP engine without changing Spider routing", () => {
    const binding = resolveDesktopSourceBinding({ sites: [] }, {
      key: "json",
      name: "JSON",
      type: 1,
      api: "./api.php",
      header: { "User-Agent": "fixture" },
    }, "https://config.example.test/config.json");

    expect(binding).toMatchObject({
      engine: "http",
      siteType: 1,
      endpoint: "https://config.example.test/api.php",
      capabilities: { engine: "http", home: true, playback: true },
    });
    expect(resolveDesktopSourceBinding({}, { key: "js", type: 3, api: "js:./spider.js" }))
      .toMatchObject({ engine: "quickjs", script: "./spider.js" });
    expect(resolveDesktopSourceBinding({}, { key: "unknown", type: 3, api: "csp_Unknown" })).toBeUndefined();
  });

  it("calls type 4 CMS endpoints with base64 ext and maps XML type 0 responses", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        list: [{ vod_id: "1", vod_name: "JSON fixture", vod_play_url: "线路$https://media.test/1.mp4" }],
      }), { headers: { "content-type": "application/json" } });
    });
    const json = new HttpDesktopClient({
      api: "https://source.test/api.php",
      type: 4,
      headers: { Referer: "https://source.test/" },
      fetchImpl,
    });

    await expect(json.init(JSON.stringify({ token: "fixture" }))).resolves.toMatchObject({ ok: true });
    const home = await json.homeContent();
    const category = await json.categoryContent("1", 2, true, { area: "华语" });
    const search = await json.searchContent("关键词", false, 3);
    const detail = await json.detailContent(["1"]);
    const player = await json.playerContent("线路", encodeURIComponent("https://media.test/1.mp4"));

    expect(home).toMatchObject({ ok: true, result: { list: [{ vod_id: "1" }] } });
    expect(category).toMatchObject({ ok: true });
    expect(search).toMatchObject({ ok: true });
    expect(detail).toMatchObject({ ok: true });
    expect(player).toMatchObject({ ok: true, result: { parse: 0, url: "https://media.test/1.mp4" } });
    const categoryUrl = new URL(requests[1]!);
    expect(categoryUrl.searchParams.get("ac")).toBe("videolist");
    expect(categoryUrl.searchParams.get("pg")).toBe("2");
    expect(categoryUrl.searchParams.get("f")).toBe(JSON.stringify({ area: "华语" }));
    expect(categoryUrl.searchParams.get("ext")).toBe(Buffer.from(JSON.stringify({ token: "fixture" })).toString("base64"));
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { Referer: "https://source.test/" } });

    const xml = new HttpDesktopClient({
      api: "https://source.test/api.php",
      type: 0,
      fetchImpl: async () => new Response(
        `<rss><class><ty id="movie" name="电影"/></class><list pagecount="2"><video><id>7</id><name>XML fixture</name><dl><flag>线路</flag><dd>第一集$https://media.test/1.m3u8#第二集$https://media.test/2.m3u8</dd></dl></video></list></rss>`,
        { headers: { "content-type": "application/xml" } },
      ),
    });
    await xml.init("");
    await expect(xml.homeContent()).resolves.toMatchObject({
      ok: true,
      result: {
        pagecount: "2",
        class: [{ type_id: "movie", type_name: "电影" }],
        list: [{ id: "7", name: "XML fixture" }],
      },
    });
    const xmlDetail = await xml.detailContent(["7"]);
    expect(xmlDetail).toMatchObject({
      ok: true,
      result: {
        list: [{
          vod_play_from: "线路",
          vod_play_url: "第一集$https://media.test/1.m3u8#第二集$https://media.test/2.m3u8",
        }],
      },
    });
    const xmlItem = (xmlDetail.result as { list: Array<Record<string, unknown>> }).list[0]!;
    expect(parseVodPlayback(xmlItem)).toMatchObject({
      lines: [{ name: "线路", episodes: [{ id: "https://media.test/1.m3u8" }, { id: "https://media.test/2.m3u8" }] }],
    });
    await json.destroy();
    await xml.destroy();
  });
});
