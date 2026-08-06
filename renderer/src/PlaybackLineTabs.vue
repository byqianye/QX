<script setup lang="ts">
import type { PlaybackLine } from "./state.js";

const props = defineProps<{ lines: PlaybackLine[]; selectedIndex: number }>();
const emit = defineEmits<{ select: [index: number] }>();

function statusLabel(line: PlaybackLine): string {
  if (line.status === "ready") return "可播放";
  if (line.status === "proxy-required") return "需要代理";
  if (line.status === "unavailable") return "不可用";
  return "待解析";
}

function moveLine(event: KeyboardEvent): void {
  const tabs = Array.from((event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  const current = tabs.indexOf(event.currentTarget as HTMLButtonElement);
  if (tabs.length === 0 || current < 0) return;
  const next = event.key === "ArrowRight" ? (current + 1) % tabs.length
    : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next]?.focus();
  const lineIndex = Number(tabs[next]?.dataset.lineIndex);
  if (Number.isInteger(lineIndex)) emit("select", lineIndex);
}
</script>

<template>
  <div data-component="PlaybackLineTabs" data-testid="playback-lines" data-od-id="playback-line-tabs" aria-label="播放线路" class="playback-lines" role="tablist">
    <button
      v-for="line in props.lines"
      :key="line.index"
      type="button"
      data-action="playback-line"
      :data-line-index="line.index"
      role="tab"
      :aria-pressed="line.index === props.selectedIndex"
      :aria-selected="line.index === props.selectedIndex"
      :data-line-status="line.status ?? 'unknown'"
      :data-protocol="line.protocol ?? 'unknown'"
      @keydown="moveLine"
      @click="emit('select', line.index)"
    >
      <span class="playback-line-label">{{ line.name }}</span>
      <span class="playback-line-meta">{{ line.protocol ?? "协议未提供" }} · {{ statusLabel(line) }}</span>
    </button>
  </div>
</template>
