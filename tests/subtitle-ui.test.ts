// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmbeddedPlayer from "../renderer/src/EmbeddedPlayer.vue";
import type { PlayerState } from "../renderer/src/state.js";

const sourceTracks = [
  {
    id: "zh",
    label: "简体中文",
    language: "zh-CN",
    format: "vtt" as const,
    url: "http://127.0.0.1:43123/__qx_playback/token/zh.vtt",
    default: true,
    forced: false,
  },
  {
    id: "forced",
    label: "强制字幕",
    language: "zh-CN",
    format: "srt" as const,
    url: "http://127.0.0.1:43123/__qx_playback/token/forced.srt",
    default: false,
    forced: true,
  },
];

function playerState(): PlayerState {
  return {
    status: "loading",
    source: { parse: 0, url: "http://127.0.0.1:43123/media/fixture.m3u8", headers: {}, subtitles: sourceTracks },
    currentTime: 0,
    duration: 10,
    volume: 1,
    muted: false,
    fullscreen: false,
    error: null,
  };
}

describe("subtitle track player UI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads a proxied track, exposes the controls, and switches tracks safely", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(
      String(input).endsWith("forced.srt")
        ? "1\n00:00:00,000 --> 00:00:01,000\n强制字幕\n"
        : "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<script>安全文本</script>\n",
      { status: 200 },
    )));
    let objectUrlCount = 0;
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => `blob:subtitle-${++objectUrlCount}` });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });

    const wrapper = mount(EmbeddedPlayer, { props: { state: playerState() } });
    await flushPromises();

    expect(wrapper.get('[data-testid="subtitle-track-panel"]')).toBeTruthy();
    expect(wrapper.get('[data-action="subtitle-encoding"]')).toBeTruthy();
    expect(wrapper.get('[data-action="subtitle-font-size"]')).toBeTruthy();
    expect(wrapper.get('[data-action="subtitle-position"]')).toBeTruthy();
    expect(wrapper.get('[data-action="subtitle-background"]')).toBeTruthy();
    expect(wrapper.get('[data-action="subtitle-local-file"]')).toBeTruthy();
    expect(wrapper.find('[data-testid="subtitle-forced-hint"]').exists()).toBe(false);
    expect(fetch).toHaveBeenCalledWith(sourceTracks[0]!.url);

    await wrapper.get('[data-action="subtitle-track"]').setValue("forced");
    await flushPromises();
    expect(wrapper.get('[data-testid="subtitle-forced-hint"]').text()).toContain("强制字幕");
    expect(fetch).toHaveBeenCalledWith(sourceTracks[1]!.url);
    expect(wrapper.findAll("track")).toHaveLength(1);

    wrapper.unmount();
    expect(revoke).toHaveBeenCalled();
  });

  it("accepts only a user-selected local file and revokes its generated URL", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    let objectUrlCount = 0;
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => `blob:local-${++objectUrlCount}` });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });

    const wrapper = mount(EmbeddedPlayer, {
      props: {
        state: {
          ...playerState(),
          source: { parse: 0, url: "http://127.0.0.1:43123/media/fixture.mp4", headers: {}, subtitles: [] },
        },
      },
    });
    const file = new File(["WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n本地字幕\n"], "selected.vtt", { type: "text/vtt" });
    const input = wrapper.get('[data-action="subtitle-local-file"]').element as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await wrapper.get('[data-action="subtitle-local-file"]').trigger("change");
    await flushPromises();

    expect(wrapper.get('[data-action="subtitle-track"]').text()).toContain("selected.vtt");
    expect(wrapper.find("track").exists()).toBe(true);
    expect(wrapper.get('[data-action="subtitle-toggle"]').element).toHaveProperty("checked", true);
    wrapper.unmount();
    expect(revoke).toHaveBeenCalled();
  });
});
