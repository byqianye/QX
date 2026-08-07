// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import DanmakuOverlay from "../renderer/src/DanmakuOverlay.vue";
import DanmakuSettingsPanel from "../renderer/src/DanmakuSettingsPanel.vue";
import {
  EMPTY_DANMAKU_UI_STATE,
  normalizeDanmakuSettings,
  type DanmakuUiState,
} from "../src/danmaku/danmaku-types.js";

function stateWithItems(): DanmakuUiState {
  return {
    ...EMPTY_DANMAKU_UI_STATE,
    settings: normalizeDanmakuSettings({ maxActive: 20, maxPerSecond: 20, trackCount: 8 }),
    status: "ready",
    playing: true,
    totalCount: 1,
    items: [{
      id: "unsafe",
      timeMs: 0,
      text: `<img src=x onerror=alert(1)><script>alert(2)</script>plain`,
      type: "scroll",
      source: "fixture",
    }],
  };
}

describe("danmaku renderer", () => {
  it("renders untrusted text as text and never creates HTML elements", () => {
    const wrapper = mount(DanmakuOverlay, {
      props: { state: stateWithItems(), currentTime: 1 },
    });
    const overlay = wrapper.get('[data-testid="danmaku-overlay"]');
    expect(overlay.attributes("aria-live")).toBe("off");
    expect(Number(overlay.attributes("data-rendered-count"))).toBe(1);
    expect(wrapper.findAll("img")).toHaveLength(0);
    expect(wrapper.findAll("script")).toHaveLength(0);
    expect(wrapper.findAll("svg")).toHaveLength(0);
    expect(wrapper.text()).toContain("<img src=x onerror=alert(1)>");
  });

  it("caps the rendered DOM and exposes settings actions", async () => {
    const state = stateWithItems();
    state.items = Array.from({ length: 50_000 }, (_, index) => ({
      id: `item-${index}`,
      timeMs: index * 100,
      text: `item-${index}`,
      type: "scroll" as const,
      source: "fixture",
    }));
    state.totalCount = state.items.length;
    const overlay = mount(DanmakuOverlay, { props: { state, currentTime: 25 } });
    expect(overlay.findAll(".danmaku-item").length).toBeLessThanOrEqual(state.settings.maxActive);

    const panel = mount(DanmakuSettingsPanel, {
      props: { state: stateWithItems(), pending: null },
    });
    const enabled = panel.get('input[type="checkbox"]');
    (enabled.element as HTMLInputElement).checked = false;
    await enabled.trigger("change");
    expect(panel.emitted("settings")).toEqual([[{ enabled: false }]]);
  });
});
