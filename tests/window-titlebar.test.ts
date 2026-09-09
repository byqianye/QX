// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import WindowTitlebar from "../renderer/src/WindowTitlebar.vue";

const windowApi = vi.hoisted(() => ({
  minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
  isMaximized: vi.fn(async () => false), isFullscreen: vi.fn(async () => false),
  unlisten: vi.fn(), onResized: vi.fn(),
}));
vi.mock("../renderer/src/tauri-rpc.js", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));
afterEach(() => { vi.clearAllMocks(); Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null }); });

it("keeps native controls active while business operations are pending and outside the drag region", async () => {
  windowApi.onResized.mockResolvedValue(windowApi.unlisten);
  const wrapper = mount(WindowTitlebar, { attrs: { "data-pending": "connect" } });
  await flushPromises();
  for (const action of ["minimize", "maximize", "close"]) {
    const button = wrapper.get(`[data-action="window-${action}"]`);
    expect(button.element.closest("[data-tauri-drag-region]")).toBeNull();
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
  }
  expect(windowApi.minimize).toHaveBeenCalledOnce();
  expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
  expect(windowApi.close).toHaveBeenCalledOnce();
  wrapper.unmount();
  expect(windowApi.unlisten).toHaveBeenCalledOnce();
});

it("hides the entire chrome in video fullscreen and restores it on exit", async () => {
  windowApi.onResized.mockResolvedValue(windowApi.unlisten);
  const wrapper = mount(WindowTitlebar);
  await flushPromises();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.body });
  document.dispatchEvent(new Event("fullscreenchange"));
  await flushPromises();
  expect(wrapper.find('[data-testid="window-titlebar"]').exists()).toBe(false);
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
  document.dispatchEvent(new Event("fullscreenchange"));
  await flushPromises();
  expect(wrapper.find('[data-testid="window-titlebar"]').exists()).toBe(true);
  wrapper.unmount();
});
