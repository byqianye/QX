<script setup lang="ts">
import EmptyState from "./EmptyState.vue";
import LoadingState from "./LoadingState.vue";
import MediaCard from "./MediaCard.vue";

const props = defineProps<{
  items: Record<string, unknown>[];
  loading: boolean;
  failed?: boolean;
  page: "import" | "home" | "category" | "search" | "detail" | "closed";
  playingId?: string | null;
}>();
const emit = defineEmits<{ detail: [id: string, sourceKey?: string]; home: []; clearSearch: [] }>();
</script>

<template>
  <section :aria-busy="props.loading" class="media-grid-section" data-testid="media-grid" data-od-id="media-grid">
    <LoadingState v-if="props.items.length === 0 && props.loading" label="正在读取媒体列表" />
    <EmptyState
      v-else-if="props.items.length === 0 && !props.failed"
      :title="props.page === 'search' ? '没有找到匹配内容' : undefined"
      :message="props.page === 'search' ? '换一个关键词试试，或清除本次搜索。' : undefined"
      :action-label="props.page === 'search' ? '清除搜索' : undefined"
      :show-action="props.page === 'search'"
      @action="props.page === 'search' ? emit('clearSearch') : emit('home')"
    />
    <div v-else-if="props.items.length > 0" class="media-grid" data-testid="vod-list">
      <MediaCard v-for="item in props.items" :key="`${String(item.__qx_source_key ?? '')}:${String(item.vod_id)}`" :item="item" :playing="props.playingId === String(item.vod_id)" @open="(id, sourceKey) => sourceKey ? emit('detail', id, sourceKey) : emit('detail', id)" />
    </div>
  </section>
</template>
