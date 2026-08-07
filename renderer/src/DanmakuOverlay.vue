<script setup lang="ts">
import { computed } from "vue";

import {
  buildDanmakuRenderItems,
  type DanmakuRenderItem,
  type DanmakuUiState,
} from "../../src/danmaku/danmaku-types.js";

const props = defineProps<{
  state: DanmakuUiState;
  currentTime: number;
}>();

const renderItems = computed(() => buildDanmakuRenderItems(
  props.state.items,
  props.currentTime * 1_000,
  props.state.settings,
));

function itemStyle(item: DanmakuRenderItem): Record<string, string> {
  const trackCount = Math.max(1, props.state.settings.trackCount);
  const track = Math.min(100, Math.max(0, (item.track / trackCount) * 100));
  const fontSize = clamp(item.fontSize ?? props.state.settings.fontSize, 12, 48);
  return {
    "--danmaku-track": `${track}%`,
    "--danmaku-elapsed": `${Math.max(0, item.elapsedMs)}ms`,
    "--danmaku-duration": `${item.durationMs}ms`,
    "--danmaku-color": safeColor(item.color),
    "--danmaku-font-size": `${fontSize}px`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function safeColor(value: string | undefined): string {
  if (value && (/^#[\da-f]{3}(?:[\da-f]{3}|[\da-f]{2})?$/i.test(value) || /^(?:white|black|red|yellow|blue|green|cyan|magenta)$/.test(value))) {
    return value;
  }
  return "white";
}
</script>

<template>
  <div
    v-if="props.state.settings.enabled && renderItems.length > 0"
    class="danmaku-overlay"
    :class="{ 'is-paused': !props.state.playing }"
    :style="{ '--danmaku-opacity': props.state.settings.opacity, '--danmaku-display-area': props.state.settings.displayArea }"
    data-testid="danmaku-overlay"
    aria-live="off"
    :data-rendered-count="renderItems.length"
  >
    <span
      v-for="item in renderItems"
      :key="`${props.state.generation}-${item.id}`"
      class="danmaku-item"
      :class="[`danmaku-${item.type}`, { 'danmaku-reverse': item.direction === 'reverse' }]"
      :style="itemStyle(item)"
      v-text="item.text"
    />
  </div>
</template>
