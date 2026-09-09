import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { DANMAKU_SETTINGS_KEY, DanmakuService } from "../src/danmaku/danmaku-service.js";
import { LocalDanmakuSourceAdapter } from "../src/danmaku/danmaku-adapter.js";
import {
  buildDanmakuRenderItems,
  compileDanmakuRegex,
  DanmakuError,
  DanmakuTimeline,
  escapeDanmakuText,
  filterDanmaku,
  normalizeDanmakuItems,
  normalizeDanmakuSettings,
  parseDanmakuPayload,
  parseDanmakuXml,
} from "../src/danmaku/danmaku-types.js";
import { SettingsRepository } from "../src/data/repositories.js";
import { openSqliteDataLayer, type SqliteDataLayer } from "../src/data/sqlite.js";

describe("danmaku model, adapter, timeline, and service", () => {
  const directories: string[] = [];
  const layers: SqliteDataLayer[] = [];

  afterEach(() => {
    while (layers.length > 0) layers.pop()?.close();
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses project JSON and XML fixtures while retaining unsupported type metadata", () => {
    const json = parseDanmakuPayload(JSON.stringify({ items: [
      { id: "json-1", time: 1.25, text: "hello", type: "top", source: "fixture-json" },
      { timeMs: 2_000, content: "reverse", type: "reverse", source: "fixture-json" },
    ] }), "auto", "fixture-json");
    expect(json).toMatchObject([
      { id: "json-1", timeMs: 1_250, text: "hello", type: "top" },
      { timeMs: 2_000, text: "reverse", type: "reverse" },
    ]);

    const xml = parseDanmakuXml(
      `<i><d p="1.5,1,25,16711680,0,0,user-1">scroll &amp; safe</d><d timeMs="3000" type="bottom" color="#00ff00">bottom</d></i>`,
      "fixture-xml",
    );
    expect(xml).toMatchObject([
      { timeMs: 1_500, type: "scroll", color: "#ff0000", userHash: "user-1", text: "scroll & safe" },
      { timeMs: 3_000, type: "bottom", color: "#00ff00" },
    ]);

    const unknown = normalizeDanmakuItems([{ time: 1, text: "unknown", type: "new-position" }], "fixture");
    expect(unknown[0]).toMatchObject({ type: "scroll", rawType: "new-position" });
  });

  it("keeps content text-only and rejects unsafe XML declarations", () => {
    const items = normalizeDanmakuItems([{
      time: 1,
      text: `<img src=x onerror=alert(1)><script>alert(2)</script><svg>bad</svg>plain`,
    }]);
    expect(items[0]?.text).toBe("alert(2)badplain");
    expect(escapeDanmakuText(`<img src="x">&`)).toBe("&lt;img src=&quot;x&quot;&gt;&amp;");
    expect(() => parseDanmakuXml("<!DOCTYPE i [<!ENTITY x SYSTEM 'file:///secret'>]><i />")).toThrowError(
      expect.objectContaining({ code: "DANMAKU_XML_UNSAFE" }),
    );
    expect(() => parseDanmakuPayload("{", "json")).toThrowError(
      expect.objectContaining({ code: "DANMAKU_JSON_INVALID" }),
    );
  });

  it("rebuilds timeline windows across pause, resume, seek, speed, and episode reset", () => {
    const timeline = new DanmakuTimeline();
    expect(timeline.snapshot()).toMatchObject({ currentTimeMs: 0, generation: 0, playing: false });
    timeline.setPlaying(true);
    expect(timeline.sync(1_000, "playing")).toMatchObject({ currentTimeMs: 1_000, playing: true, seeked: false });
    expect(timeline.sync(1_000, "user-pause").playing).toBe(false);
    expect(timeline.sync(1_200, "playing").playing).toBe(true);
    const forwardSeek = timeline.sync(8_000, "seek");
    expect(forwardSeek.seeked).toBe(true);
    const generation = forwardSeek.generation;
    const backwardSeek = timeline.sync(500, "seek");
    expect(backwardSeek.generation).toBe(generation + 1);
    expect(timeline.setPlaybackRate(2).playbackRate).toBe(2);
    expect(timeline.reset()).toMatchObject({ currentTimeMs: 0, playing: false, seeked: true });
  });

  it("filters by keyword, safe regex, type, and source", () => {
    const items = normalizeDanmakuItems([
      { timeMs: 1_000, text: "keep this", type: "scroll", source: "a" },
      { timeMs: 2_000, text: "drop this", type: "top", source: "a" },
      { timeMs: 3_000, text: "keep other", type: "scroll", source: "b" },
    ]);
    const settings = normalizeDanmakuSettings({ keyword: "keep", types: ["scroll"], sources: ["a"] });
    expect(filterDanmaku(items, settings)).toHaveLength(1);
    expect(filterDanmaku(items, normalizeDanmakuSettings({ regex: "^keep" }))).toHaveLength(2);
    expect(() => compileDanmakuRegex("^(a+)+$")).toThrowError(
      expect.objectContaining({ code: "DANMAKU_REGEX_UNSAFE" }),
    );
    expect(() => compileDanmakuRegex("[".repeat(130))).toThrowError(
      expect.objectContaining({ code: "DANMAKU_REGEX_TOO_LONG" }),
    );
    expect(() => compileDanmakuRegex("[")).toThrowError(
      expect.objectContaining({ code: "DANMAKU_REGEX_INVALID" }),
    );
  });

  it("bounds rendering for large datasets and allocates multiple tracks", () => {
    const datasets = [1_000, 10_000, 50_000];
    for (const size of datasets) {
      const fixture = Array.from({ length: size }, (_, index) => ({
        id: `large-${size}-${index}`,
        timeMs: index * 100,
        text: `comment-${index}`,
        type: "scroll" as const,
        source: "fixture",
      }));
      const items = parseDanmakuPayload(JSON.stringify({ items: fixture }), "json", "fixture");
      expect(items).toHaveLength(size);
      const settings = normalizeDanmakuSettings({ maxActive: 40, maxPerSecond: 60, trackCount: 12, density: 1 });
      const rendered = buildDanmakuRenderItems(items, 25_000, settings);
      expect(rendered.length).toBeLessThanOrEqual(40);
      expect(new Set(rendered.map((item) => item.track)).size).toBeGreaterThan(1);
    }
  });

  it("renders scroll, top, bottom, and reverse types through independent tracks", () => {
    const items = normalizeDanmakuItems([
      { id: "scroll", timeMs: 1_000, text: "scroll", type: "scroll" },
      { id: "top", timeMs: 1_000, text: "top", type: "top" },
      { id: "bottom", timeMs: 1_000, text: "bottom", type: "bottom" },
      { id: "reverse", timeMs: 1_000, text: "reverse", type: "reverse" },
    ]);
    const rendered = buildDanmakuRenderItems(items, 1_500, normalizeDanmakuSettings({ trackCount: 8 }));
    expect(rendered.map((item) => item.type)).toEqual(expect.arrayContaining(["scroll", "top", "bottom", "reverse"]));
    expect(rendered.find((item) => item.type === "reverse")?.direction).toBe("reverse");
  });

  it("provides load/query/cancel/destroy adapter lifecycle", async () => {
    const adapter = new LocalDanmakuSourceAdapter();
    await adapter.load({ format: "items", data: [{ time: 1, text: "fixture" }], source: "fixture" });
    expect(adapter.query()).toHaveLength(1);
    adapter.cancel();
    adapter.clear();
    expect(adapter.query()).toHaveLength(0);
    adapter.destroy();
    await expect(adapter.load({ format: "items", data: [] })).rejects.toMatchObject({ code: "DANMAKU_DESTROYED" });
  });

  it("does not let a malformed persisted regex prevent startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-danmaku-invalid-settings-"));
    directories.push(directory);
    const opened = openSqliteDataLayer(join(directory, "danmaku.db"));
    layers.push(opened.layer);
    const settings = new SettingsRepository(opened.layer);
    settings.set(DANMAKU_SETTINGS_KEY, { regex: "[" });
    const service = new DanmakuService({ settings });
    expect(service.uiState().settings.regex).toBe("");
    expect(service.uiState().settings.enabled).toBe(true);
    service.close();
  });

  it("hydrates settings through SQLite and handles VOD fixtures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qx-danmaku-"));
    directories.push(directory);
    const path = join(directory, "danmaku.db");
    const first = openSqliteDataLayer(path);
    layers.push(first.layer);
    const firstService = new DanmakuService({ settings: new SettingsRepository(first.layer) });
    firstService.setSettings({ enabled: false, opacity: 0.5, keyword: "blocked" });
    firstService.close();
    first.layer.close();
    layers.splice(layers.indexOf(first.layer), 1);

    const second = openSqliteDataLayer(path);
    layers.push(second.layer);
    const service = new DanmakuService({ settings: new SettingsRepository(second.layer) });
    expect(service.uiState().settings).toMatchObject({ enabled: false, opacity: 0.5, keyword: "blocked" });
    await service.load({
      format: "items",
      timeline: "vod",
      source: "fixture-vod",
      data: [{ id: "vod-1", timeMs: 1_000, text: "vod" }],
    });
    expect(service.query(1_200)).toHaveLength(0);
    service.setSettings({ enabled: true, keyword: "" });
    expect(service.query(1_200)).toHaveLength(1);
    expect(service.sync(1.2 * 1_000, "playing", "playing").playing).toBe(true);
    expect(service.sync(500, "playing", "playing").currentTimeMs).toBe(500);
    expect(service.clear().totalCount).toBe(0);
    service.close();
  });
});
