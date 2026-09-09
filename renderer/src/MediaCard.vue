<script setup lang="ts">
import { computed } from "vue";

import PosterImage from "./PosterImage.vue";

const props = defineProps<{ item: Record<string, unknown>; playing?: boolean }>();
const emit = defineEmits<{ open: [id: string, sourceKey?: string] }>();
const title = computed(() => String(props.item.vod_name || "未命名"));
const detailAvailable = computed(() => props.item.__qx_detail_available !== false);

function openDetail(): void {
  if (!detailAvailable.value) return;
  const id = String(props.item.vod_id ?? "");
  const sourceKey = typeof props.item.__qx_source_key === "string" ? props.item.__qx_source_key : undefined;
  if (sourceKey) emit("open", id, sourceKey);
  else emit("open", id);
}

function handleKeydown(event: KeyboardEvent): void {
  if (!detailAvailable.value) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openDetail();
}
</script>

<template>
  <article class="media-card" data-testid="vod-card" :data-od-id="`media-card-${String(props.item.vod_id ?? 'unknown')}`" :data-playing="props.playing || undefined" :role="detailAvailable ? 'button' : undefined" :tabindex="detailAvailable ? 0 : undefined" :aria-disabled="detailAvailable ? undefined : 'true'" @click="openDetail" @keydown="handleKeydown">
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
      <span v-if="typeof props.item.__qx_source_name === 'string'" class="media-card-source">来源：{{ props.item.__qx_source_name }}</span>
    </div>
  </article>
</template>
