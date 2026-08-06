import { describe, expect, it } from "vitest";

import {
  SubtitleObjectUrlRegistry,
  SubtitleParseError,
  detectSubtitleEncoding,
  isLocalProxySubtitleUrl,
  normalizeSubtitleTracks,
  parseSubtitle,
  subtitleToWebVtt,
} from "../src/subtitles.js";

describe("subtitle parsing and safety contract", () => {
  it("parses WebVTT and escapes dangerous tags without HTML execution", () => {
    const parsed = parseSubtitle([
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.500",
      "<script>alert('x')</script>",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "第二行",
    ].join("\n"));

    expect(parsed).toMatchObject({ format: "vtt", encoding: "utf-8" });
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({ startMs: 1_000, endMs: 2_500 });
    expect(parsed.cues[0]?.text).toContain("&lt;script&gt;");
    expect(parsed.cues[0]?.text).not.toContain("<script>");
  });

  it("parses SRT and rejects invalid timelines", () => {
    const parsed = parseSubtitle([
      "1",
      "00:00:00,500 --> 00:00:01,500",
      "你好",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "世界",
    ].join("\r\n"));
    expect(parsed.format).toBe("srt");
    expect(parsed.cues.map((cue) => cue.startMs)).toEqual([500, 2_000]);

    expect(() => parseSubtitle("1\n00:00:03,000 --> 00:00:02,000\n坏时间轴", { format: "srt" }))
      .toThrowError(new SubtitleParseError("SUBTITLE_TIMELINE_INVALID", "字幕结束时间必须晚于开始时间。"));
  });

  it("converts basic ASS/SSA Dialogue only and never runs override scripts", () => {
    const parsed = parseSubtitle([
      "[Script Info]",
      "ScriptType: v4.00+",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\pos(1,2)}你好\\N<script>危险</script>",
    ].join("\n"), { format: "ass" });
    expect(parsed.format).toBe("ass");
    expect(parsed.cues[0]).toMatchObject({ startMs: 1_000, endMs: 3_500 });
    expect(parsed.cues[0]?.text).toContain("你好\n");
    expect(parsed.cues[0]?.text).not.toContain("\\pos");
    expect(parsed.warnings[0]).toContain("不会执行");
    expect(subtitleToWebVtt(parsed)).toContain("WEBVTT");
  });

  it("detects BOM/UTF-16 and limited Chinese encodings, while exposing unknown", () => {
    const encoder = new TextEncoder();
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("WEBVTT\n")]);
    expect(detectSubtitleEncoding(utf8)).toMatchObject({ encoding: "utf-8-bom", bom: true, confident: true });

    const utf16 = new Uint8Array([0xff, 0xfe, 0x57, 0x00, 0x45, 0x00, 0x42, 0x00, 0x56, 0x00, 0x54, 0x00, 0x54, 0x00]);
    expect(detectSubtitleEncoding(utf16).encoding).toBe("utf-16le");
    expect(parseSubtitle(utf16, { format: "vtt" }).encoding).toBe("utf-16le");

    const gb18030 = Uint8Array.from([
      ...encoder.encode("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n"),
      0xc4, 0xe3, 0xba, 0xc3,
      0x0a,
    ]);
    expect(detectSubtitleEncoding(gb18030).encoding).toBe("gb18030");
    expect(parseSubtitle(gb18030, { format: "vtt", encoding: "gb18030" }).cues[0]?.text).toContain("你好");

    expect(() => parseSubtitle(Uint8Array.from([0xff, 0x00, 0x81, 0x00]), { format: "srt" }))
      .toThrowError(new SubtitleParseError("SUBTITLE_ENCODING_UNKNOWN", "字幕编码无法可靠识别，请选择编码后重试。"));
  });

  it("normalizes source/Jellyfin/local/proxy/fixture tracks and keeps headers optional", () => {
    const tracks = normalizeSubtitleTracks([
      { id: "source-zh", label: "来源中文", language: "zh-CN", format: "vtt", url: "https://source.invalid/a.vtt", default: true, forced: false, source: "source" },
      { id: "jellyfin-en", label: "English", language: "en", format: "srt", url: "https://jellyfin.invalid/a.srt", headers: { "X-Emby-Token": "secret" }, default: false, forced: false, source: "jellyfin" },
      { id: "local", label: "本地", language: "zh", format: "ass", localPath: "C:\\selected\\a.ass", default: false, forced: false, source: "local" },
      { id: "proxy", label: "代理", language: "zh", format: "vtt", url: "http://127.0.0.1:1234/__qx_playback/token/item.vtt", default: false, forced: true, source: "local-proxy" },
      { id: "fixture", label: "Fixture", language: "und", format: "ssa", url: "http://127.0.0.1:43123/subtitles/a.ssa", default: false, forced: false, source: "fixture" },
    ]);
    expect(tracks).toHaveLength(5);
    expect(tracks[1]?.headers).toEqual({ "X-Emby-Token": "secret" });
    expect(tracks[2]?.localPath).toContain("selected");
    expect(isLocalProxySubtitleUrl(tracks[3]?.url ?? "")).toBe(true);
    expect(isLocalProxySubtitleUrl(tracks[0]?.url ?? "")).toBe(false);
  });

  it("revokes every generated object URL during replacement and cleanup", () => {
    let createCount = 0;
    const revoked: string[] = [];
    const registry = new SubtitleObjectUrlRegistry({
      createObjectURL: () => `blob:${++createCount}`,
      revokeObjectURL: (url) => revoked.push(url),
    });
    const blob = new Blob(["WEBVTT"]);
    expect(registry.create("track", blob)).toBe("blob:1");
    expect(registry.create("track", blob)).toBe("blob:2");
    expect(registry.size).toBe(1);
    registry.revokeAll();
    expect(registry.size).toBe(0);
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });
});
