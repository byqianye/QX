// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import PlaybackHealthPanel from "../renderer/src/PlaybackHealthPanel.vue";
import { createRendererState } from "../renderer/src/state.js";

describe("playback health panel", () => {
  it("shows unknown metrics, fallback reason/next line, and emits mode/actions", async () => {
    const state = createRendererState();
    state.playback.fallback = {
      ...state.playback.fallback,
      status: "prompt",
      trigger: "segment-errors",
      reason: "连续分片错误",
      next: { id: "line-1", label: "备用线路", kind: "healthier", healthScore: 88 },
    };
    const wrapper = mount(PlaybackHealthPanel, {
      props: { health: state.playback.health, fallback: state.playback.fallback },
    });

    expect(wrapper.get('[data-testid="playback-health-panel"]').text()).toContain("unknown");
    expect(wrapper.get('[data-testid="playback-fallback-status"]').text()).toContain("备用线路");
    await wrapper.get('[data-action="playback-fallback-mode"]').setValue("auto");
    await wrapper.get('[data-action="playback-fallback-approve"]').trigger("click");
    await wrapper.get('[data-action="playback-fallback-cancel"]').trigger("click");

    expect(wrapper.emitted("mode")?.[0]).toEqual(["auto"]);
    expect(wrapper.emitted("approve")).toHaveLength(1);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    wrapper.unmount();
  });
});
