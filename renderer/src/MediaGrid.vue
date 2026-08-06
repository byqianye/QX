<script setup lang="ts">
import EmptyState from "./EmptyState.vue";
import LoadingState from "./LoadingState.vue";
import MediaCard from "./MediaCard.vue";

const props = defineProps<{ items: Record<string, unknown>[]; loading: boolean; playingId?: string | null }>();
const emit = defineEmits<{ detail: [id: string]; home: [] }>();
</script>

<template>
  <section class="media-grid-section" data-testid="media-grid" data-od-id="media-grid">
    <LoadingState v-if="props.items.length === 0 && props.loading" label="正在读取媒体列表" />
    <EmptyState v-else-if="props.items.length === 0" @action="emit('home')" />
    <div v-else class="media-grid" data-testid="vod-list">
      <MediaCard v-for="item in props.items" :key="String(item.vod_id)" :item="item" :playing="props.playingId === String(item.vod_id)" @open="emit('detail', $event)" />
    </div>
  </section>
</template>
