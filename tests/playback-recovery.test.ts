import { describe, expect, it } from "vitest";
import { episodeNumber, recoveryCandidateId, recoverySelection, PlaybackProgressWatchdog, sameRecoveryContent } from "../renderer/src/playback-recovery.js";

const catalog = (...names: string[]) => ({ lines: [{ index: 0, name: "line", episodes: names.map((name, index) => ({ index, name, id: name })) }] });
describe("same-content recovery", () => {
  it("keeps independent Chinese source identities distinct through the RPC identifier boundary", () => {
    const first = recoveryCandidateId("光盘", "123");
    const second = recoveryCandidateId("肥猫", "123");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-z0-9_.:-]{1,120}$/i);
    expect(recoveryCandidateId("a", "film-1")).toBe("a:film-1");
    expect(recoveryCandidateId("光盘", "123")).toBe(first);
  });
  it("requires exact title, year and compatible season metadata", () => {
    const source = { vod_name: "示例剧", vod_year: "2025", season: 2 };
    expect(sameRecoveryContent(source, { ...source })).toBe(true);
    expect(sameRecoveryContent(source, { ...source, vod_name: "示例剧 花絮" })).toBe(false);
    expect(sameRecoveryContent(source, { ...source, vod_year: "2024" })).toBe(false);
    expect(sameRecoveryContent(source, { vod_name: "示例剧", vod_year: "2025" })).toBe(false);
    expect(sameRecoveryContent({ vod_name: "示例剧" }, { vod_name: "示例剧" })).toBe(false);
  });
  it("matches episode numbers instead of playback array offsets", () => {
    expect(episodeNumber("第０６集")).toBe(6);
    expect(episodeNumber("EP06")).toBe(6);
    expect(episodeNumber("预告06")).toBeNull();
    const from = catalog("第01集", "第06集");
    const selected = { lineIndex: 0, episodeIndex: 1 };
    expect(recoverySelection(from, selected, catalog("EP01", "EP02", "EP06"))).toEqual({ lineIndex: 0, episodeIndex: 2 });
    expect(recoverySelection(from, selected, catalog("EP01"))).toBeNull();
    expect(recoverySelection(from, selected, catalog("EP06", "第06集"))).toBeNull();
  });
  it("allows a movie's single episode labels to differ between lines", () => {
    const from = catalog("正片");
    const target = catalog("HD中字");
    const movie = { vod_name: "哪吒之魔童闹海", vod_year: "2025", type_name: "电影" };
    expect(recoverySelection(from, { lineIndex: 0, episodeIndex: 0 }, target, movie, movie))
      .toEqual({ lineIndex: 0, episodeIndex: 0 });
  });
  it("ignores pause, seek and short buffering and fires once per source", () => {
    const watch = new PlaybackProgressWatchdog(0);
    expect(watch.check(14999, true, false)).toBeNull();
    watch.progress(14999, 0.01, true);
    expect(watch.check(22998, true, false)).toBeNull();
    expect(watch.check(22999, true, false)).toBe("stalled");
    expect(watch.check(24000, true, false)).toBeNull();
    const paused = new PlaybackProgressWatchdog(0);
    expect(paused.check(30000, false, false)).toBeNull();
    expect(paused.check(60000, true, false)).toBeNull();
    expect(paused.check(70000, true, true)).toBeNull();
    expect(paused.check(90000, true, false)).toBeNull();
    expect(paused.check(105000, true, false)).toBe("startup-timeout");
  });
});
