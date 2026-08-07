import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EpgRepository } from "../src/data/repositories.js";
import { SqliteDataLayer } from "../src/data/sqlite.js";
import { EpgParserError, parseXmltv, parseXmltvTime } from "../src/epg/epg-parser.js";
import { EpgService } from "../src/epg/epg-service.js";

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

function xmltv(programmes = ""): string {
  return `<tv generator-info-name="fixture">
    <channel id="news"><display-name>新闻台</display-name><display-name>News</display-name><icon src="https://guide.example.invalid/news.png" /></channel>
    <channel id="movie"><display-name>电影台</display-name></channel>
    ${programmes}
  </tv>`;
}

function programme(channel: string, start: string, stop: string, title: string, extra = ""): string {
  return `<programme channel="${channel}" start="${start}" stop="${stop}"><title>${title}</title>${extra}</programme>`;
}

describe("XMLTV parser", () => {
  it("parses Chinese metadata, icons, timezone offsets, and programme fields", () => {
    const result = parseXmltv(xmltv([
      programme("news", "20260807120000 +0800", "20260807130000 +0800", "午间新闻", "<sub-title>直播</sub-title><desc>天气与要闻</desc><category>新闻</category><icon src=\"https://guide.example.invalid/program.png\" />"),
      programme("movie", "20260807110000 UTC", "20260807130000 UTC", "午后电影"),
    ].join("")));
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).toMatchObject({ externalId: "news", displayName: "新闻台", normalizedName: "新闻台" });
    expect(result.programmes).toHaveLength(2);
    expect(result.programmes[0]).toMatchObject({ title: "午间新闻", subTitle: "直播", description: "天气与要闻", categories: ["新闻"] });
    expect(result.programmes[0]?.startAt).toBe(Date.UTC(2026, 7, 7, 4));
    expect(result.programmes[1]?.startAt).toBe(Date.UTC(2026, 7, 7, 11));
  });

  it("uses UTC for missing offsets and supports negative offsets", () => {
    expect(parseXmltvTime("20260807120000")).toBe(Date.UTC(2026, 7, 7, 12));
    expect(parseXmltvTime("20260807120000 -0500")).toBe(Date.UTC(2026, 7, 7, 17));
    expect(parseXmltvTime("20260807120000 +08:00")).toBe(Date.UTC(2026, 7, 7, 4));
    expect(parseXmltvTime("20260230000000 UTC")).toBeNull();
  });

  it("rejects malformed XML, DTD, and external entity input", () => {
    expect(() => parseXmltv("<tv><channel id=\"x\"></tv>")).toThrow(EpgParserError);
    expect(() => parseXmltv("<!DOCTYPE tv [<!ENTITY xxe SYSTEM \"file:///secret\">]><tv></tv>"))
      .toThrowError(expect.objectContaining({ code: "EPG_XML_UNSAFE" }));
  });

  it("enforces programme and text limits", () => {
    expect(() => parseXmltv(xmltv([
      programme("news", "20260807120000 UTC", "20260807130000 UTC", "large"),
      programme("news", "20260807130000 UTC", "20260807140000 UTC", "large 2"),
    ].join("")), { maxProgrammes: 1 }))
      .toThrowError(expect.objectContaining({ code: "EPG_TOO_LARGE" }));
    expect(() => parseXmltv(xmltv(programme("news", "20260807120000 UTC", "20260807130000 UTC", "0123456789")), { maxTextBytes: 5 }))
      .toThrowError(expect.objectContaining({ code: "EPG_TOO_LARGE" }));
  });
});

describe("EPG service and repository", () => {
  let directory: string;
  let layer: SqliteDataLayer;
  let repository: EpgRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "qx-epg-"));
    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    repository = new EpgRepository(layer);
  });

  afterEach(() => {
    layer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("previews without writing, batch imports, queries current/next, prunes retention, and survives restart", async () => {
    const service = new EpgService({ repository, now: () => NOW });
    const content = xmltv([
      programme("news", "20260807000000 UTC", "20260807010000 UTC", "旧节目"),
      programme("news", "20260807120000 UTC", "20260807130000 UTC", "当前节目"),
      programme("news", "20260807130000 UTC", "20260807140000 UTC", "下一节目"),
      programme("news", "20260816120000 UTC", "20260816130000 UTC", "过远节目"),
    ].join(""));
    const preview = await service.previewSource({ name: "Fixture EPG", type: "fixture", content });
    expect(repository.listSources()).toHaveLength(0);
    expect(preview.stats).toMatchObject({ channelCount: 2, programmeCount: 4 });
    const source = await service.applyPreview(preview.id);
    expect(source.id).toMatch(/^epg-/u);
    expect(repository.listSources()).toHaveLength(1);
    expect(repository.sourceProgrammeCount(source.id)).toBe(2);
    const news = repository.getChannels(source.id).find((channel) => channel.externalId === "news");
    expect(news).toBeDefined();
    const currentNext = service.currentNext(news!.id, NOW);
    expect(currentNext.current?.title).toBe("当前节目");
    expect(currentNext.next?.title).toBe("下一节目");
    const indexes = layer.prepare("PRAGMA index_list(epg_programmes)").all() as Array<{ name?: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "epg_programmes_channel_start",
      "epg_programmes_channel_end",
      "epg_programmes_channel_window",
    ]));
    service.close();
    layer.close();
    layer = SqliteDataLayer.create(join(directory, "qx-yingshi.db"));
    repository = new EpgRepository(layer);
    expect(repository.listSources()).toHaveLength(1);
    expect(repository.sourceProgrammeCount(source.id)).toBe(2);
  });

  it("supports ETag/304 and preserves last-known-good on refresh failure", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(xmltv(programme("news", "20260807120000 UTC", "20260807130000 UTC", "首版")), {
        status: 200,
        headers: { "content-type": "application/xml", etag: "v1", "last-modified": "yesterday" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: "v1" } }))
      .mockRejectedValueOnce(new Error("offline"));
    const service = new EpgService({ repository, fetchImpl, now: () => NOW });
    const preview = await service.previewSource({ name: "Remote EPG", type: "xmltv-url", location: "https://guide.example.invalid/guide.xml" });
    const source = await service.applyPreview(preview.id);
    const refreshed = await service.refreshSource(source.id);
    expect(refreshed.lastError).toBeNull();
    expect(repository.sourceProgrammeCount(source.id)).toBe(1);
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "if-none-match": "v1" }) }));
    await expect(service.refreshSource(source.id)).rejects.toMatchObject({ code: "EPG_SOURCE_FAILED" });
    expect(repository.sourceProgrammeCount(source.id)).toBe(1);
    expect(repository.getSource(source.id)?.lastError).toBeTruthy();
  });

  it("bounds gzip decompression", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(gzipSync(Buffer.from(xmltv("x".repeat(2_000)))), {
      status: 200,
      headers: { "content-type": "application/xml", "content-encoding": "gzip" },
    }));
    const service = new EpgService({ repository, fetchImpl, maxDecompressedBytes: 128, now: () => NOW });
    await expect(service.previewSource({ name: "Bomb", type: "xmltv-url", location: "https://guide.example.invalid/bomb.xml.gz" }))
      .rejects.toMatchObject({ code: "EPG_TOO_LARGE" });
  });
});
