import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TvBoxConfig } from "../src/config/decoder.js";
import { ImportTrustStore } from "../src/config/trust.js";
import { DesktopSpiderSession } from "../src/desktop/spider-session.js";
import { resolveJavaExecutable } from "../src/spikes/java-probe.js";
import { buildJvmArtifacts, removeJvmArtifacts } from "../src/spikes/jvm-build.js";
import { DesktopSpiderClient } from "../src/spider/desktop-client.js";
import { JvmSidecar } from "../src/spider/jvm-sidecar.js";

const javaExecutable = resolveJavaExecutable();
const jvmDescribe = javaExecutable ? describe : describe.skip;

jvmDescribe("JVM-native csp_Douban minimum port", () => {
  let artifacts: Awaited<ReturnType<typeof buildJvmArtifacts>>;
  let server: Server;
  let endpoint: string;
  const requests: string[] = [];
  let delayCategoryRequests = false;
  let rateLimitPrimaryRequests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(request.url ?? "/");
      const detailMatch = requestUrl.pathname.match(/^\/api\/v2\/(movie|tv)\/((?:movie|tv)-[^/]+)$/);
      if (detailMatch) {
        const media = detailMatch[1];
        const id = detailMatch[2];
        const isMovie = media === "movie" && id === "movie-1";
        const isTv = media === "tv" && id === "tv-1";
        const isError = id === "movie-error" || id === "tv-error";
        const isMalformed = id === "movie-error-object";
        const detail = isMovie ? {
          id,
          title: "Detail Movie",
          cover_url: "https://img.example.invalid/detail-movie.jpg",
          rating: { value: 8.1 },
          genres: ["Drama", "Mystery"],
          countries: ["CN"],
          year: "2024",
          directors: [{ name: "Movie Director" }],
          actors: [{ name: "Movie Actor" }],
          intro: "movie intro",
          pubdate: ["2024-01-01"],
        } : isTv ? {
          id,
          title: "Detail TV",
          cover_url: "https://img.example.invalid/detail-tv.jpg",
          rating: { value: 7.4 },
          genres: ["Drama"],
          countries: ["CN", "US"],
          year: "2023",
          directors: [{ name: "TV Director" }],
          actors: [{ name: "TV Actor" }],
          intro: "tv intro",
          pubdate: ["2023-02-02"],
          episodes_count: 12,
          episodes_info: "12 episodes",
        } : undefined;
        const status = isError ? 500 : isMalformed ? 200 : detail ? 200 : 404;
        const delayMs = id === "movie-timeout" ? 250 : 0;
        setTimeout(() => {
          response.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify(
            detail
              ?? (isMalformed
                ? { code: 131, msg: "not a detail document" }
                : { error: isError ? "upstream error" : "not found" }),
          ));
        }, delayMs);
        return;
      }
      if (requestUrl.pathname === "/subject_search") {
        const key = requestUrl.searchParams.get("search_text") ?? "";
        const start = Number(requestUrl.searchParams.get("start") ?? "0");
        const isError = key === "error";
        const isMalformed = key === "malformed";
        const isRateLimited = key === "rate-limit" || key === "fallback-error";
        if (isRateLimited) rateLimitPrimaryRequests += 1;
        const e2eId = key === "e2e-movie"
          ? "movie-1"
          : key === "e2e-tv"
            ? "tv-1"
            : start === 15
              ? 36246196.0
              : 36246195.0;
        const e2eTitle = key === "e2e-movie"
          ? "Search Detail Movie"
          : key === "e2e-tv"
            ? "Search Detail TV"
            : start === 15
              ? "Search Page Two"
              : "Search Page One";
        const searchItem = start === 15 ? {
          id: e2eId,
          title: e2eTitle,
          cover_url: "https://img.example.invalid/search-2.jpg",
          rating: { value: 7.1, rating_info: "" },
          abstract: "page two abstract",
          url: "https://movie.douban.com/subject/search-2/",
          tpl_name: "search_subject",
        } : {
          id: e2eId,
          title: e2eTitle,
          cover_url: "https://img.example.invalid/search-1.jpg",
          rating: { value: 8.2, rating_info: "" },
          abstract: "page one abstract",
          url: "https://movie.douban.com/subject/search-1/",
          tpl_name: "search_subject",
        };
        const body = isError
          ? "upstream error"
          : isMalformed
            ? "<html><body>missing search data</body></html>"
            : isRateLimited
              ? [
                "<html><script>",
                `window.__DATA__ = ${JSON.stringify({
                  count: 0,
                  start,
                  text: key,
                  total: 0,
                  error_info: "search rate limited",
                  items: [],
                })};`,
                "</script></html>",
              ].join("\n")
            : [
              "<html><script>",
              `window.__DATA__ = ${JSON.stringify({
                count: 1,
                start,
                text: key,
                total: 31,
                items: [searchItem],
              })};`,
              "</script></html>",
            ].join("\n");
        const delayMs = key === "timeout" ? 250 : 0;
        setTimeout(() => {
          response.writeHead(isError ? 500 : 200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end(body);
        }, delayMs);
        return;
      }
      if (requestUrl.pathname === "/rexxar/api/v2/search/subjects") {
        const fallbackKey = requestUrl.searchParams.get("q");
        const isFallbackError = fallbackKey === "fallback-error" || fallbackKey === "error";
        const body = JSON.stringify({
          subjects: {
            total: "31",
            items: [{
              id: "fallback-1",
              title: "Fallback Search Movie",
              cover_url: "https://img.example.invalid/fallback.jpg",
              rating: { value: 7.9 },
              abstract: "fallback abstract",
            }],
          },
        });
        response.writeHead(isFallbackError ? 503 : 200, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(body);
        return;
      }
      const isHome = requestUrl.pathname.includes("subject_real_time_hotest");
      const isItemsResponse = requestUrl.pathname.endsWith("/movie/hot_gaia")
        || requestUrl.pathname.endsWith("/recommend");
      const categoryItems = [{
        id: "douban-category-1",
        title: "Spike Category Movie",
        pic: { normal: "https://img.example.invalid/category.jpg" },
        rating: { value: 7.6 },
      }];
      const body = JSON.stringify(isHome ? {
        subject_collection_items: [{
          id: "douban-1",
          title: "Spike Douban Movie",
          pic: { normal: "https://img.example.invalid/poster.jpg" },
          rating: { value: 8.7 },
        }],
      } : {
        start: Number(requestUrl.searchParams.get("start") ?? "0"),
        count: 20,
        total: 95,
        [isItemsResponse ? "items" : "subject_collection_items"]: categoryItems,
      });
      const delayMs = delayCategoryRequests
        ? 250
        : Number(requestUrl.searchParams.get("delayMs") ?? "0");
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(body);
      }, delayMs);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/api/v2/subject_collection/subject_real_time_hotest/items`;
    artifacts = await buildJvmArtifacts();
  });

  afterAll(async () => {
    if (artifacts) await removeJvmArtifacts(artifacts);
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("maps the extracted Douban response to CatVod class/list JSON", async () => {
    requests.length = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({
        ok: true,
        result: { initialized: true },
      });
      await expect(sidecar.homeContent(true)).resolves.toMatchObject({
        ok: true,
        result: {
          class: [
            { type_id: "hot_gaia", type_name: " 热门电影" },
            { type_id: "tv_hot", type_name: "热播剧集" },
            { type_id: "show_hot", type_name: "热播综艺" },
            { type_id: "movie", type_name: "电影筛选" },
            { type_id: "tv", type_name: "电视筛选" },
            { type_id: "rank_list_movie", type_name: "电影榜单" },
            { type_id: "rank_list_tv", type_name: "电视剧榜单" },
          ],
          list: [{
            vod_id: "msearch:douban-1",
            vod_name: "Spike Douban Movie",
            vod_pic: "https://img.example.invalid/poster.jpg@Referer=https://api.douban.com/@User-Agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
            vod_remarks: "评分：8.7",
          }],
        },
      });
    } finally {
      await sidecar.destroy();
    }

    expect(requests).toEqual(["/api/v2/subject_collection/subject_real_time_hotest/items"]);
    expect(sidecar.isRunning).toBe(false);
  });

  it("routes all seven categories, filters, and pages to CatVod pagination JSON", async () => {
    requests.length = 0;
    const sidecar = createSidecar();
    const cases = [
      {
        typeId: "hot_gaia",
        page: 2,
        extend: { sort: "time", area: "华语" },
        path: "/api/v2/movie/hot_gaia",
        query: { sort: "time", area: "华语", start: "20" },
      },
      {
        typeId: "tv_hot",
        page: 1,
        extend: { type: "tv_domestic" },
        path: "/api/v2/subject_collection/tv_domestic/items",
        query: { start: "0" },
      },
      {
        typeId: "show_hot",
        page: 2,
        extend: { type: "type_show" },
        path: "/api/v2/subject_collection/type_show/items",
        query: { start: "20" },
      },
      {
        typeId: "movie",
        page: 3,
        extend: { sort: "rank", 类型: "喜剧" },
        path: "/api/v2/movie/recommend",
        query: { sort: "rank", tags: "喜剧", start: "40" },
      },
      {
        typeId: "tv",
        page: 2,
        extend: { sort: "T", 类型: "动画" },
        path: "/api/v2/tv/recommend",
        query: { sort: "T", tags: "动画", start: "20" },
      },
      {
        typeId: "rank_list_movie",
        page: 1,
        extend: { 榜单: "movie_weekly_best" },
        path: "/api/v2/subject_collection/movie_weekly_best/items",
        query: { start: "0" },
      },
      {
        typeId: "rank_list_tv",
        page: 4,
        extend: { 榜单: "tv_global_best" },
        path: "/api/v2/subject_collection/tv_global_best/items",
        query: { start: "60" },
      },
    ] as const;

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      for (const current of cases) {
        const response = await sidecar.categoryContent(
          current.typeId,
          current.page,
          true,
          current.extend,
        );
        expect(response).toMatchObject({
          ok: true,
          result: {
            page: current.page,
            pagecount: 5,
            limit: 20,
            total: 95,
            list: [{
              vod_id: "msearch:douban-category-1",
              vod_name: "Spike Category Movie",
            }],
          },
        });

        const requestUrl = new URL(
          requests[requests.length - 1] ?? "/",
          "http://127.0.0.1",
        );
        expect(requestUrl.pathname).toBe(current.path);
        for (const [key, value] of Object.entries(current.query)) {
          expect(requestUrl.searchParams.get(key)).toBe(value);
        }
      }
    } finally {
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  it("resolves msearch ids through movie then tv and returns CatVod detail JSON", async () => {
    requests.length = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(
        sidecar.detailContent(["msearch:movie-1", "msearch:tv-1"]),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          list: [
            {
              vod_id: "msearch:movie-1",
              vod_name: "Detail Movie",
              vod_pic: "https://img.example.invalid/detail-movie.jpg",
              vod_remarks: "评分：8.1",
              vod_year: "2024",
              vod_area: "CN",
              vod_class: "Drama,Mystery",
              vod_director: "Movie Director",
              vod_actor: "Movie Actor",
              vod_content: "movie intro",
              vod_pubdate: "2024-01-01",
            },
            {
              vod_id: "msearch:tv-1",
              vod_name: "Detail TV",
              vod_total: 12,
              vod_area: "CN,US",
              vod_class: "Drama",
              vod_director: "TV Director",
              vod_actor: "TV Actor",
              vod_content: "tv intro",
              vod_pubdate: "2023-02-02",
            },
          ],
        },
      });
    } finally {
      await sidecar.destroy();
    }

    expect(requests.map((value) => new URL(value, "http://127.0.0.1").pathname)).toEqual([
      "/api/v2/movie/movie-1",
      "/api/v2/movie/tv-1",
      "/api/v2/tv/tv-1",
    ]);
    expect(sidecar.isRunning).toBe(false);
  });

  it("returns a detail upstream exception without killing the sidecar", async () => {
    requests.length = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(sidecar.detailContent(["msearch:movie-error"])).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      await expect(sidecar.detailContent(["msearch:movie-error-object"])).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      expect(sidecar.isRunning).toBe(true);
      await expect(sidecar.detailContent(["msearch:movie-1"])).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_name: "Detail Movie" }] },
      });
    } finally {
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  it("searches paged Douban results and maps embedded subject data to CatVod list JSON", async () => {
    requests.length = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(sidecar.searchContent("demo", true, 1)).resolves.toMatchObject({
        ok: true,
        result: {
          page: 1,
          pagecount: 3,
          limit: 15,
          total: 31,
          list: [{
            vod_id: "msearch:36246195",
            vod_name: "Search Page One",
            vod_pic: "https://img.example.invalid/search-1.jpg",
            vod_remarks: "评分：8.2",
            vod_content: "page one abstract",
          }],
        },
      });
      await expect(sidecar.searchContent("demo", false, 2)).resolves.toMatchObject({
        ok: true,
        result: {
          page: 2,
          pagecount: 3,
          limit: 15,
          total: 31,
          list: [{
            vod_id: "msearch:36246196",
            vod_name: "Search Page Two",
          }],
        },
      });
    } finally {
      await sidecar.destroy();
    }

    const searchRequests = requests
      .filter((value) => value.startsWith("/subject_search"))
      .map((value) => new URL(value, "http://127.0.0.1"));
    expect(searchRequests.map((value) => value.searchParams.get("start"))).toEqual(["0", "15"]);
    expect(searchRequests.every((value) => value.searchParams.get("cat") === "1002")).toBe(true);
    expect(sidecar.isRunning).toBe(false);
  });

  it("returns a search upstream exception without killing the sidecar", async () => {
    requests.length = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(sidecar.searchContent("error", false, 1)).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      await expect(sidecar.searchContent("malformed", false, 1)).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      expect(sidecar.isRunning).toBe(true);
      await expect(sidecar.searchContent("demo", false, 1)).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:36246195" }] },
      });
    } finally {
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  it("retries a rate-limited primary search and uses the bounded JSON fallback", async () => {
    requests.length = 0;
    rateLimitPrimaryRequests = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(sidecar.searchContent("rate-limit", false, 1)).resolves.toMatchObject({
        ok: true,
        result: {
          page: 1,
          pagecount: 3,
          limit: 15,
          total: 31,
          list: [{
            vod_id: "msearch:fallback-1",
            vod_name: "Fallback Search Movie",
            vod_content: "fallback abstract",
          }],
        },
      });
    } finally {
      await sidecar.destroy();
    }

    const requestUrls = requests.map((value) => new URL(value, "http://127.0.0.1"));
    expect(rateLimitPrimaryRequests).toBe(2);
    expect(requestUrls.map((value) => value.pathname)).toEqual([
      "/subject_search",
      "/subject_search",
      "/rexxar/api/v2/search/subjects",
    ]);
    expect(requestUrls[2]?.searchParams.get("q")).toBe("rate-limit");
    expect(requestUrls[2]?.searchParams.get("type")).toBe("movie");
    expect(requestUrls[2]?.searchParams.get("start")).toBe("0");
    expect(requestUrls[2]?.searchParams.get("count")).toBe("15");
    expect(sidecar.isRunning).toBe(false);
  });

  it("preserves fallback search errors without killing the sidecar", async () => {
    requests.length = 0;
    rateLimitPrimaryRequests = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });
      await expect(sidecar.searchContent("fallback-error", false, 1)).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      expect(sidecar.isRunning).toBe(true);
    } finally {
      await sidecar.destroy();
    }

    const requestUrls = requests.map((value) => new URL(value, "http://127.0.0.1"));
    expect(rateLimitPrimaryRequests).toBe(2);
    expect(requestUrls.map((value) => value.pathname)).toEqual([
      "/subject_search",
      "/subject_search",
      "/rexxar/api/v2/search/subjects",
    ]);
    expect(sidecar.isRunning).toBe(false);
  });

  it("passes search vod_ids directly into movie-first detail and tv fallback", async () => {
    requests.length = 0;
    const sidecar = createSidecar();

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint)).resolves.toMatchObject({ ok: true });

      const movieSearch = await sidecar.searchContent("e2e-movie", false, 1);
      expect(movieSearch).toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:movie-1" }] },
      });
      await expect(sidecar.detailContent([firstVodId(movieSearch)])).resolves.toMatchObject({
        ok: true,
        result: {
          list: [{
            vod_id: "msearch:movie-1",
            vod_name: "Detail Movie",
            vod_content: "movie intro",
          }],
        },
      });

      const tvSearch = await sidecar.searchContent("e2e-tv", false, 1);
      expect(tvSearch).toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:tv-1" }] },
      });
      await expect(sidecar.detailContent([firstVodId(tvSearch)])).resolves.toMatchObject({
        ok: true,
        result: {
          list: [{
            vod_id: "msearch:tv-1",
            vod_name: "Detail TV",
            vod_content: "tv intro",
            vod_total: 12,
          }],
        },
      });
    } finally {
      await sidecar.destroy();
    }

    const requestUrls = requests.map((value) => new URL(value, "http://127.0.0.1"));
    expect(requestUrls.map((value) => value.pathname)).toEqual([
      "/subject_search",
      "/api/v2/movie/movie-1",
      "/subject_search",
      "/api/v2/movie/tv-1",
      "/api/v2/tv/tv-1",
    ]);
    expect(requestUrls[0]?.searchParams.get("search_text")).toBe("e2e-movie");
    expect(requestUrls[2]?.searchParams.get("search_text")).toBe("e2e-tv");
    expect(sidecar.isRunning).toBe(false);
  });

  it("routes csp_Douban through the desktop client for all supported methods", async () => {
    requests.length = 0;
    const client = createDesktopClient();

    try {
      await expect(client.init(endpoint)).resolves.toMatchObject({
        ok: true,
        result: { initialized: true },
      });
      await expect(client.homeContent(false)).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:douban-1" }] },
      });
      await expect(
        client.categoryContent("tv_hot", 1, false, { type: "tv_hot" }),
      ).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:douban-category-1" }] },
      });

      const search = await client.searchContent("e2e-movie", false, 1);
      expect(search).toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:movie-1" }] },
      });
      await expect(client.detailContent([firstVodId(search)])).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:movie-1", vod_name: "Detail Movie" }] },
      });
      expect(client.isRunning).toBe(true);
    } finally {
      await client.destroy();
    }

    expect(client.isRunning).toBe(false);
    expect(requests.map((value) => new URL(value, "http://127.0.0.1").pathname)).toEqual([
      "/api/v2/subject_collection/subject_real_time_hotest/items",
      "/api/v2/subject_collection/tv_hot/items",
      "/subject_search",
      "/api/v2/movie/movie-1",
    ]);
  });

  it("gates csp_Douban behind confirmation and exposes the four desktop calls", async () => {
    requests.length = 0;
    const source = "http://127.0.0.1/config.json";
    const trustStore = new ImportTrustStore();
    const session = createDesktopSession(source, trustStore);

    expect(session.view.status).toBe("confirmation_required");
    expect(session.view.warning).toBeTruthy();
    expect(session.view.playback).toMatchObject({
      available: false,
      label: "Douban：无正片播放源",
    });
    await expect(session.open("douban", endpoint)).rejects.toThrow(/confirmation/i);

    session.confirmImport();
    expect(trustStore.isTrusted(source)).toBe(true);
    expect(session.view.status).toBe("idle");

    try {
      await expect(session.open("douban", endpoint)).resolves.toMatchObject({
        ok: true,
        result: { initialized: true },
      });
      await expect(session.homeContent(false)).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:douban-1" }] },
      });
      await expect(
        session.categoryContent("tv_hot", 1, false, { type: "tv_hot" }),
      ).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:douban-category-1" }] },
      });
      const search = await session.searchContent("e2e-movie", false, 1);
      expect(search).toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:movie-1" }] },
      });
      await expect(session.detailContent([firstVodId(search)])).resolves.toMatchObject({
        ok: true,
        result: { list: [{ vod_id: "msearch:movie-1", vod_name: "Detail Movie" }] },
      });
      expect(session.view.status).toBe("ready");
      expect(session.view.api).toBe("csp_Douban");
      expect(session.view.sidecarRunning).toBe(true);
      await expect(session.playerContent("default", "msearch:movie-1", [])).rejects.toThrow(
        /does not provide a full-content playback URL/,
      );
      expect(session.view.error).toMatchObject({ code: "PLAYBACK_UNAVAILABLE" });
      expect(session.view.playback.available).toBe(false);
    } finally {
      await session.destroy();
    }

    expect(session.view.status).toBe("destroyed");
    expect(session.view.sidecarRunning).toBe(false);
  });

  it("keeps RPC errors visible and records timeout sidecar termination", async () => {
    requests.length = 0;
    const source = "http://127.0.0.1/config.json";
    const trustStore = new ImportTrustStore();
    trustStore.trust(source);
    const session = createDesktopSession(source, trustStore);

    try {
      await expect(session.open("douban", endpoint)).resolves.toMatchObject({ ok: true });
      await expect(session.detailContent(["msearch:movie-error"])).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      expect(session.view.status).toBe("error");
      expect(session.view.error?.code).toBe("JVM_SPIDER_ERROR");
      expect(session.view.sidecarRunning).toBe(true);

      await expect(session.searchContent("timeout", false, 1, 50)).rejects.toThrow(/timeout/i);
      expect(session.view.status).toBe("error");
      expect(session.view.error?.code).toBe("SPIDER_TIMEOUT");
      expect(session.view.sidecarRunning).toBe(false);
    } finally {
      await session.destroy();
    }

    expect(session.view.status).toBe("destroyed");
  });

  it("preserves RPC errors and terminates the desktop client on timeout", async () => {
    requests.length = 0;
    const client = createDesktopClient(1_000);

    try {
      await expect(client.init(endpoint, 1_000)).resolves.toMatchObject({ ok: true });
      await expect(client.detailContent(["msearch:movie-error"])).resolves.toMatchObject({
        ok: false,
        error: { code: "JVM_SPIDER_ERROR" },
      });
      expect(client.isRunning).toBe(true);
      await expect(client.searchContent("timeout", false, 1, 50)).rejects.toThrow(/timeout/i);
      expect(client.isRunning).toBe(false);
    } finally {
      await client.destroy();
    }

    expect(client.isRunning).toBe(false);
  });

  it("terminates the isolated sidecar when categoryContent exceeds its timeout", async () => {
    requests.length = 0;
    const sidecar = createSidecar(50);

    try {
      delayCategoryRequests = true;
      await sidecar.start();
      await expect(sidecar.init(endpoint, 1_000)).resolves.toMatchObject({ ok: true });
      await expect(
        sidecar.categoryContent("tv_hot", 1, false, { type: "tv_hot" }),
      ).rejects.toThrow(/timeout/i);
    } finally {
      delayCategoryRequests = false;
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  it("terminates the isolated sidecar when detailContent exceeds its timeout", async () => {
    requests.length = 0;
    const sidecar = createSidecar(50);

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint, 1_000)).resolves.toMatchObject({ ok: true });
      await expect(
        sidecar.detailContent(["msearch:movie-timeout"]),
      ).rejects.toThrow(/timeout/i);
    } finally {
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  it("terminates the isolated sidecar when searchContent exceeds its timeout", async () => {
    requests.length = 0;
    const sidecar = createSidecar(50);

    try {
      await sidecar.start();
      await expect(sidecar.init(endpoint, 1_000)).resolves.toMatchObject({ ok: true });
      await expect(
        sidecar.searchContent("timeout", false, 1),
      ).rejects.toThrow(/timeout/i);
    } finally {
      await sidecar.destroy();
    }

    expect(sidecar.isRunning).toBe(false);
  });

  function createSidecar(requestTimeoutMs = 1_000): JvmSidecar {
    return new JvmSidecar({
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      requestTimeoutMs,
    });
  }

  function createDesktopClient(requestTimeoutMs = 1_000): DesktopSpiderClient {
    return new DesktopSpiderClient({
      api: "csp_Douban",
      javaExecutable: javaExecutable as string,
      hostJar: artifacts.hostJar,
      spiderJar: artifacts.spiderJar,
      spiderClass: "com.qx.spike.fixture.DoubanJvmSpider",
      requestTimeoutMs,
    });
  }

  function createDesktopSession(
    source: string,
    trustStore: ImportTrustStore,
    requestTimeoutMs = 1_000,
  ): DesktopSpiderSession {
    const config: TvBoxConfig = {
      spider: "fixture-spider.jar",
      sites: [{ key: "douban", name: "Douban", type: 3, api: "csp_Douban" }],
    };
    return new DesktopSpiderSession({
      source,
      config,
      trustStore,
      requestTimeoutMs,
      createClient: (site) => {
        if (site.api !== "csp_Douban") {
          throw new Error(`Unexpected Spider API: ${String(site.api)}`);
        }
        return createDesktopClient(requestTimeoutMs);
      },
    });
  }
});

function firstVodId(response: { result?: unknown }): string {
  if (!isRecord(response.result)) throw new Error("search response has no result object");
  const list = response.result.list;
  if (!Array.isArray(list) || !isRecord(list[0]) || typeof list[0].vod_id !== "string") {
    throw new Error("search response has no vod_id");
  }
  return list[0].vod_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
