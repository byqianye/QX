import { describe, expect, it, vi } from "vitest";

import type { JellyfinAdapter } from "../src/jellyfin/jellyfin-adapter.js";
import { JellyfinDesktopClient } from "../src/jellyfin/jellyfin-client.js";
import { JellyfinMediaSource } from "../src/jellyfin/jellyfin-source.js";
import { JvmMediaSource } from "../src/spider/jvm-source.js";
import type { DesktopSpiderClient } from "../src/spider/desktop-client.js";

describe("unified media source contract", () => {
  it("runs Douban and PlayableFixture through the same JVM source contract", async () => {
    const doubanClient = createJvmClient({
      home: { list: [{ vod_id: "msearch:1", vod_name: "Douban" }], class: [{ type_id: "movie", type_name: "Movie" }] },
      category: { list: [{ vod_id: "msearch:2", vod_name: "Category" }] },
      search: { list: [{ vod_id: "msearch:3", vod_name: "Search" }] },
      detail: { list: [{ vod_id: "msearch:3", vod_name: "Detail" }] },
    });
    const douban = new JvmMediaSource({ api: "csp_Douban", client: doubanClient });

    expect(douban.capabilities).toMatchObject({ engine: "jvm", playback: false });
    await douban.init({ sourceId: "inline:douban", siteKey: "douban", ext: "fixture" });
    await expect(douban.home()).resolves.toMatchObject({
      items: [{ id: "msearch:1", name: "Douban" }],
      categories: [{ id: "movie", name: "Movie" }],
    });
    await expect(douban.detail(["msearch:3"])).resolves.toMatchObject([{ id: "msearch:3" }]);
    await expect(douban.player({ flag: "default", id: "msearch:3" })).rejects.toMatchObject({
      code: "PLAYBACK_UNAVAILABLE",
    });
    await douban.destroy();
    await douban.destroy();

    const playable = new JvmMediaSource({ api: "csp_PlayableFixture", client: createJvmClient({
      player: { parse: 0, url: "https://media.example.invalid/fixture.mp4", header: {} },
    }) });
    expect(playable.capabilities).toMatchObject({ engine: "fixture", playback: true });
    await playable.init({ sourceId: "inline:playable", siteKey: "playable", ext: "fixture" });
    await expect(playable.player({ flag: "default", id: "fixture:1" })).resolves.toEqual({
      parse: 0,
      url: "https://media.example.invalid/fixture.mp4",
      headers: {},
    });
    await playable.destroy();
  });

  it("adapts Jellyfin to the same home/category/search/detail/player contract", async () => {
    const adapter = {
      connect: vi.fn(async () => ({ authenticated: true as const })),
      listLibraries: vi.fn(async () => [
        { id: "movies", name: "Movies", collectionType: "movies" },
        { id: "shows", name: "Shows", collectionType: "tvshows" },
      ]),
      listMovies: vi.fn(async () => [{ id: "movie-1", name: "Movie", type: "Movie" }]),
      listSeries: vi.fn(async () => [{ id: "series-1", name: "Series", type: "Series" }]),
      search: vi.fn(async () => [{ id: "movie-1", name: "Movie", type: "Movie" }]),
      getDetails: vi.fn(async () => ({ id: "movie-1", name: "Movie", type: "Movie", overview: "Detail" })),
      getPlayback: vi.fn(async () => ({
        parse: 0,
        url: "http://127.0.0.1:8096/Videos/movie-1/stream",
        headers: { "X-Emby-Token": "fixture-token" },
        directPlay: true as const,
        itemId: "movie-1",
        mediaSourceId: "source-1",
      })),
    } as unknown as JellyfinAdapter;
    const source = new JellyfinMediaSource(adapter);

    expect(source.capabilities).toEqual({
      home: true,
      category: true,
      search: true,
      detail: true,
      playback: true,
      localProxy: false,
      filters: false,
      pagination: false,
      engine: "jellyfin",
    });
    await source.init({ sourceId: "jellyfin:fixture" });
    await expect(source.home()).resolves.toMatchObject({
      categories: [{ id: "movies" }, { id: "shows" }],
      items: [{ id: "movie-1" }, { id: "series-1" }],
    });
    await expect(source.category({ typeId: "shows" })).resolves.toMatchObject({
      items: [{ id: "series-1" }],
    });
    await expect(source.search({ key: "Movie" })).resolves.toMatchObject({
      items: [{ id: "movie-1", name: "Movie" }],
    });
    await expect(source.detail(["movie-1"])).resolves.toMatchObject([{ id: "movie-1", name: "Movie" }]);
    await expect(source.player({ flag: "direct", id: "movie-1" })).resolves.toMatchObject({
      parse: 0,
      url: "http://127.0.0.1:8096/Videos/movie-1/stream",
      headers: { "X-Emby-Token": "fixture-token" },
    });
    await source.destroy();
    await source.destroy();
  });

  it("keeps Jellyfin playback credentials behind its specialized LocalProxy", async () => {
    const adapter = {
      origin: "http://127.0.0.1:8096",
      connect: vi.fn(async () => ({ authenticated: true as const })),
      listLibraries: vi.fn(async () => []),
      getPlayback: vi.fn(async () => ({
        parse: 0,
        url: "http://127.0.0.1:8096/Videos/movie-1/stream",
        headers: { "X-Emby-Token": "fixture-token" },
        directPlay: true as const,
        itemId: "movie-1",
        mediaSourceId: "source-1",
      })),
    } as unknown as JellyfinAdapter;
    const client = new JellyfinDesktopClient({
      config: {
        baseUrl: "http://127.0.0.1:8096",
        token: "fixture-token",
        userId: "user-1",
      },
      adapter,
    });

    await expect(client.init("")).resolves.toMatchObject({ ok: true });
    const response = await client.playerContent("direct", "movie-1");
    expect(response).toMatchObject({ ok: true, result: { parse: 0, header: {} } });
    expect((response.result as { url: string }).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(JSON.stringify(response)).not.toContain("fixture-token");
    await client.stopPlayback();
    await client.destroy();
  });
});

interface JvmResults {
  home?: Record<string, unknown>;
  category?: Record<string, unknown>;
  search?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  player?: Record<string, unknown>;
}

function createJvmClient(results: JvmResults): DesktopSpiderClient {
  const response = (result: unknown) => ({ id: "fixture", ok: true as const, result });
  return {
    init: vi.fn(async () => response({ initialized: true })),
    homeContent: vi.fn(async () => response(results.home ?? { list: [] })),
    categoryContent: vi.fn(async () => response(results.category ?? { list: [] })),
    searchContent: vi.fn(async () => response(results.search ?? { list: [] })),
    detailContent: vi.fn(async () => response(results.detail ?? { list: [] })),
    playerContent: vi.fn(async () => response(results.player ?? { parse: 0, url: "https://media.example.invalid/fixture.mp4" })),
    destroy: vi.fn(async () => undefined),
  } as unknown as DesktopSpiderClient;
}
