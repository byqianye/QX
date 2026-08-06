<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import Icon from "./Icon.vue";
import { displaySource } from "./safe-display.js";

const props = defineProps<{
  detail: Record<string, unknown>;
  canPlay: boolean;
  playbackLabel: string;
}>();

const emit = defineEmits<{ close: []; play: [] }>();
const closeButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("keydown", closeOnEscape);
  closeButton.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", closeOnEscape);
  previousFocus?.focus();
});

const detailFields = computed(() => [
  ["评分", "vod_score"],
  ["年份", "vod_year"],
  ["地区", "vod_area"],
  ["类型", "vod_class"],
  ["导演", "vod_director"],
  ["演员", "vod_actor"],
].flatMap(([label, key]) => {
  const value = props.detail[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? []
    : [{ label, value: String(value) }];
}));
</script>

<template>
  <aside class="detail-drawer" data-testid="detail-drawer" data-od-id="detail-drawer" aria-label="媒体详情">
    <section class="detail-drawer-panel" data-testid="detail-panel">
      <button ref="closeButton" type="button" class="drawer-close" aria-label="关闭详情" @click="emit('close')"><Icon name="close" /></button>
      <div class="detail-cover" aria-hidden="true"><span>{{ String(detail.vod_name || "详").slice(0, 1) }}</span></div>
      <span class="section-kicker">媒体详情</span>
      <h2>{{ detail.vod_name || "详情" }}</h2>
      <p class="detail-summary">{{ detail.vod_content || "暂无简介" }}</p>
      <dl class="detail-meta">
        <div v-for="field in detailFields" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div>
        <div><dt>线路状态</dt><dd>{{ playbackLabel }}</dd></div>
        <div><dt>来源</dt><dd>{{ displaySource(String(detail.vod_from || "当前来源")) }}</dd></div>
      </dl>
      <button
        data-testid="play-button"
        data-action="play"
        class="button-primary button-wide"
        type="button"
        :disabled="!canPlay"
        @click="emit('play')"
      >播放</button>
    </section>
  </aside>
</template>
