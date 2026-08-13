<script setup lang="ts">
import EmptyState from "./EmptyState.vue";
import LoadingState from "./LoadingState.vue";
import MediaCard from "./MediaCard.vue";

const props = defineProps<{
  items: Record<string, unknown>[];
  loading: boolean;
  page: "import" | "home" | "category" | "search" | "detail" | "closed";
  playingId?: string | null;
}>();
const emit = defineEmits<{ detail: [id: string]; home: []; clearSearch: [] }>();
</script>

<template>
  <section class="media-grid-section" data-testid="media-grid" data-od-id="media-grid">
    <LoadingState v-if="props.items.length === 0 && props.loading" label="正在读取媒体列表" />
    <EmptyState
      v-else-if="props.items.length === 0"
      :title="props.page === 'search' ? '没有找到匹配内容' : undefined"
      :message="props.page === 'search' ? '换一个关键词试试，或清除本次搜索。' : undefined"
      :action-label="props.page === 'search' ? '清除搜索' : undefined"
      @action="props.page === 'search' ? emit('clearSearch') : emit('home')"
    />
    <div v-else class="media-grid" data-testid="vod-list">
      <MediaCard v-for="item in props.items" :key="String(item.vod_id)" :item="item" :playing="props.playingId === String(item.vod_id)" @open="emit('detail', $event)" />
    </div>
  </section>
</template>
