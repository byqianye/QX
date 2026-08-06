<script setup lang="ts">
defineProps<{ item: Record<string, unknown>; playing?: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();
</script>

<template>
  <article class="media-card" data-testid="vod-card" :data-od-id="`media-card-${String(item.vod_id ?? 'unknown')}`" :data-playing="playing || undefined">
    <div class="media-card-cover" aria-hidden="true"><span>{{ String(item.vod_name || "未命名").slice(0, 1) }}</span></div>
    <div class="media-card-body">
      <span class="media-card-type">{{ item.vod_remarks || "媒体内容" }}</span>
      <h3>{{ item.vod_name || "未命名" }}</h3>
      <button type="button" class="text-button" data-action="detail" :data-vod-id="item.vod_id" @click="emit('open', String(item.vod_id ?? ''))">查看详情</button>
    </div>
  </article>
</template>
