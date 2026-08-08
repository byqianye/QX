<script setup lang="ts">
import { computed } from "vue";

import PosterImage from "./PosterImage.vue";

const props = defineProps<{ item: Record<string, unknown>; playing?: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();
const title = computed(() => String(props.item.vod_name || "未命名"));

function openDetail(): void {
  emit("open", String(props.item.vod_id ?? ""));
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openDetail();
}
</script>

<template>
  <article class="media-card" data-testid="vod-card" :data-od-id="`media-card-${String(props.item.vod_id ?? 'unknown')}`" :data-playing="props.playing || undefined" role="button" tabindex="0" @click="openDetail" @keydown="handleKeydown">
    <div class="media-card-cover">
      <PosterImage
        :source="typeof props.item.vod_pic === 'string' && props.item.vod_pic.trim() ? props.item.vod_pic : null"
        :alt="`${title} 海报`"
        :fallback-text="title"
        test-id="vod-poster"
        loading="lazy"
      />
    </div>
    <div class="media-card-body">
      <span class="media-card-type">{{ props.item.vod_remarks || "媒体内容" }}</span>
      <h3>{{ title }}</h3>
    </div>
  </article>
</template>
