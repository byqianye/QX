import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { LiveSourceService } from "../src/live/live-service.js";
import { parseLiveContent } from "../src/live/live-parser.js";

const M3U = `\uFEFF#EXTM3U\r
#EXTINF:-1 tvg-id="cctv1" tvg-name="央视一套" tvg-logo="https://img.example/logo.png?token=hidden" group-title="新闻" tvg-chno="1" x-custom="保留",央视一套\r
#EXTVLCOPT:http-referrer=https://media.example/ref\r
https://media.example/cctv1.m3u8\r
#EXTINF:-1 group-title="体育",体育频道\r
https://media.example/sports.m3u8\r
#EXTINF:-1,缺少地址\r
`;

describe("live source parser", () => {
  it("parses M3U metadata, unicode, relative URLs, headers, and diagnostics", () => {
    const result = parseLiveContent(M3U, { format: "m3u" });
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).toMatchObject({
      name: "央视一套",
      group: "新闻",
      tvgId: "cctv1",
      attributes: { "x-custom": "保留" },
      streams: [{ url: "https://media.example/cctv1.m3u8", headers: { referer: "https://media.example/ref" }, protocol: "HLS" }],
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LIVE_ENTRY_MISSING_URL" }),
    ]));
    expect(result.issues.map((issue) => issue.raw).join(" ")).not.toContain("hidden");

    const relative = parseLiveContent("#EXTM3U\n#EXTINF:-1,测试\n./stream.m3u8\n", {
      format: "m3u",
      baseUrl: "https://media.example/path/list.m3u",
    });
    expect(relative.channels[0]?.streams[0]?.url).toBe("https://media.example/path/stream.m3u8");
  });

  it("parses grouped TXT playlists and keeps multiple URLs on one channel", () => {
    const result = parseLiveContent("新闻,#genre#\n央视一套,http://one.example/live#https://two.example/live\n坏行\n", { format: "txt" });
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toMatchObject({
      group: "新闻",
      name: "央视一套",
      streams: [
        { url: "http://one.example/live", priority: 0 },
        { url: "https://two.example/live", priority: 1 },
      ],
    });
    expect(result.issues).toEqual([expect.objectContaining({ code: "LIVE_TXT_LINE_INVALID", line: 3 })]);
  });
});

describe("live source persistence and refresh", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("previews, applies, persists, disables, and restores a local source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-live-local-"));
    directories.push(directory);
    const path = join(directory, "playlist.m3u");
    writeFileSync(path, "#EXTM3U\n#EXTINF:-1,本地频道\n./local.m3u8\n", "utf8");
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    const repository = new LiveRepository(layer);
    const service = new LiveSourceService({ repository, now: () => 100 });

    const preview = await service.previewSource({ name: "本地测试", type: "m3u-file", fileName: "playlist.m3u", filePath: path });
    expect(preview.stats).toMatchObject({ channelCount: 1, streamCount: 1, addedCount: 1 });
    const source = await service.applyPreview(preview.id);
    expect(repository.getChannels(source.id)[0]?.streams[0]?.url).toMatch(/\/local\.m3u8$/u);
    expect(repository.getChannels(source.id)[0]?.name).toBe("本地频道");

    const disabled = service.setSourceEnabled(source.id, false);
    expect(disabled.enabled).toBe(false);
    layer.close();
    layers.splice(layers.indexOf(layer), 1);
    const reopened = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(reopened);
    const reopenedRepository = new LiveRepository(reopened);
    expect(reopenedRepository.getSource(source.id)).toMatchObject({ enabled: false, name: "本地测试" });
    expect(reopenedRepository.getChannels(source.id)).toHaveLength(1);
  });

  it("uses validators, keeps last-known-good channels, and rejects unsafe remote inputs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-live-remote-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    const repository = new LiveRepository(layer);
    const calls: Array<{ url: string; headers: Headers }> = [];
    const responses: Response[] = [
      new Response("#EXTM3U\n#EXTINF:-1,远程频道\nhttps://media.example/live.m3u8\n", {
        headers: { "content-type": "application/x-mpegurl", etag: "v1", "last-modified": "today" },
      }),
      new Response(null, { status: 304, headers: { etag: "v1", "last-modified": "today" } }),
      new Response("upstream unavailable", { status: 503, headers: { "content-type": "text/plain" } }),
    ];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return responses.shift() ?? new Response(null, { status: 503 });
    });
    const service = new LiveSourceService({ repository, fetchImpl, now: () => 200 });

    const preview = await service.previewSource({ name: "远程测试", type: "m3u-url", location: "https://media.example/playlist.m3u" });
    const source = await service.applyPreview(preview.id);
    expect(source.etag).toBe("v1");
    expect(repository.getChannels(source.id)).toHaveLength(1);

    const notModified = await service.refreshSource(source.id);
    expect(notModified.lastError).toBeNull();
    expect(calls[1]?.headers.get("if-none-match")).toBe("v1");

    await expect(service.refreshSource(source.id)).rejects.toMatchObject({ code: "LIVE_SOURCE_FETCH_FAILED" });
    expect(repository.getChannels(source.id)).toHaveLength(1);
    expect(repository.getSource(source.id)?.lastError).toContain("不可用");

    await expect(service.previewSource({
      name: "不安全",
      type: "m3u-url",
      location: "https://media.example/playlist.m3u?token=secret-value",
    })).rejects.toMatchObject({ code: "LIVE_SOURCE_AUTH_UNSUPPORTED" });
    expect(repository.listSources()).toHaveLength(1);
    expect(JSON.stringify(repository.getChannels(source.id))).not.toContain("secret-value");
  });

  it("enforces remote content type, size, redirect origin, and timeout limits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-live-limits-"));
    directories.push(directory);
    const layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    layers.push(layer);
    const repository = new LiveRepository(layer);

    const makeService = (response: Response | null, options: { maxResponseBytes?: number } = {}) => new LiveSourceService({
      repository,
      fetchImpl: vi.fn(async () => response ?? new Response(null, { status: 503 })),
      requestTimeoutMs: 10,
      ...options,
    });
    await expect(makeService(new Response("<html />", { headers: { "content-type": "text/html" } })).previewSource({
      name: "类型错误", type: "m3u-url", location: "https://media.example/playlist.m3u",
    })).rejects.toMatchObject({ code: "LIVE_SOURCE_CONTENT_TYPE_UNSUPPORTED" });
    await expect(makeService(new Response("123456789", { headers: { "content-type": "text/plain", "content-length": "9" } }), { maxResponseBytes: 4 }).previewSource({
      name: "过大", type: "m3u-url", location: "https://media.example/playlist.m3u",
    })).rejects.toMatchObject({ code: "LIVE_SOURCE_TOO_LARGE" });
    await expect(makeService(new Response(null, { status: 302, headers: { location: "https://evil.example/playlist.m3u" } })).previewSource({
      name: "跨源", type: "m3u-url", location: "https://media.example/playlist.m3u",
    })).rejects.toMatchObject({ code: "LIVE_REDIRECT_ORIGIN_MISMATCH" });

    const timeoutFetch: typeof fetch = vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const timeoutService = new LiveSourceService({ repository, fetchImpl: timeoutFetch, requestTimeoutMs: 1 });
    await expect(timeoutService.previewSource({
      name: "超时", type: "m3u-url", location: "https://media.example/playlist.m3u",
    })).rejects.toMatchObject({ code: "LIVE_SOURCE_TIMEOUT" });
  });
});
