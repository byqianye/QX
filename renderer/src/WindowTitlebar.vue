<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./tauri-rpc.js";

const native = isTauriRuntime();
const maximized = ref(false);
const fullscreen = ref(false);
const error = ref("");
let current: Window | undefined;
let disposed = false;
let unlisten: (() => void) | undefined;

async function refresh(): Promise<void> {
  if (!current) return;
  const [max, full] = await Promise.all([current.isMaximized(), current.isFullscreen()]);
  if (disposed) return;
  maximized.value = max;
  fullscreen.value = full || Boolean(document.fullscreenElement);
}
function browserFullscreen(): void {
  fullscreen.value = Boolean(document.fullscreenElement);
  void refresh().catch(() => undefined);
}
onMounted(async () => {
  if (!native) return;
  try {
    current = getCurrentWindow();
    document.addEventListener("fullscreenchange", browserFullscreen);
    await refresh();
    const stop = await current.onResized(() => { void refresh().catch(() => undefined); });
    if (disposed) stop();
    else unlisten = stop;
  } catch { error.value = "窗口状态暂时不可用"; }
});
onBeforeUnmount(() => {
  disposed = true;
  unlisten?.();
  document.removeEventListener("fullscreenchange", browserFullscreen);
});
async function action(kind: "minimize" | "maximize" | "close"): Promise<void> {
  if (!current) return;
  try {
    error.value = "";
    if (kind === "minimize") await current.minimize();
    else if (kind === "maximize") { await current.toggleMaximize(); await refresh(); }
    else await current.close();
  } catch { error.value = "窗口操作失败，请重试"; }
}
</script>

<template>
  <header v-if="native && !fullscreen" class="window-titlebar" data-testid="window-titlebar">
    <div class="window-titlebar-drag" data-tauri-drag-region>
      <svg class="window-titlebar-logo" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><circle cx="11" cy="11" r="2.5"/><path d="m16.5 16.5 5 5M5.5 5.5l3 3M14 14l3 3"/></svg>
      <span>QX 影视</span>
    </div>
    <span v-if="error" class="window-titlebar-error" role="status">{{ error }}</span>
    <div class="window-titlebar-controls">
      <button type="button" aria-label="最小化" title="最小化" data-action="window-minimize" @click="action('minimize')"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"/></svg></button>
      <button type="button" :aria-label="maximized ? '还原窗口' : '最大化'" :title="maximized ? '还原窗口' : '最大化'" data-action="window-maximize" @click="action('maximize')"><svg viewBox="0 0 16 16" aria-hidden="true"><path v-if="maximized" d="M5 5V3h8v8h-2M3 5h8v8H3z"/><path v-else d="M3 3h10v10H3z"/></svg></button>
      <button type="button" aria-label="关闭窗口" title="关闭窗口" class="window-close" data-action="window-close" @click="action('close')"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13"/></svg></button>
    </div>
  </header>
</template>
