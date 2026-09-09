<script setup lang="ts">
import type { CacheClearScope, CacheType, CacheUiState } from "../../src/cache/cache-types.js";

const props = defineProps<{
  state: CacheUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  refresh: [];
  clear: [scope: CacheClearScope];
}>();

const labels: Record<CacheType, string> = {
  poster: "Poster",
  backdrop: "Backdrop",
  "source-config": "Source config",
  home: "Home",
  category: "Category",
  search: "Search",
  detail: "Detail",
  subtitle: "Subtitle",
  "parser-metadata": "Parser metadata",
  temporary: "Temporary",
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
</script>

<template>
  <section class="settings-section cache-management" data-testid="cache-management" data-od-id="cache-management">
    <div>
      <span class="section-kicker">Storage / Cache</span>
      <h2>Cache management</h2>
      <p class="meta">Only reproducible cache files are cleared. History, favorites, following, settings, and the database stay untouched.</p>
    </div>
    <div class="cache-summary" data-testid="cache-summary">
      <div class="settings-row"><span>Total</span><strong>{{ formatBytes(props.state.totalBytes) }}</strong></div>
      <div class="settings-row"><span>Entries</span><strong>{{ props.state.entries }}</strong></div>
      <div class="settings-row"><span>Limit</span><strong>{{ formatBytes(props.state.maxBytes) }}</strong></div>
    </div>
    <div class="cache-breakdown" data-testid="cache-breakdown">
      <div v-for="item in props.state.byType" :key="item.type" class="settings-row" :data-cache-type="item.type">
        <span>{{ labels[item.type] ?? item.type }}</span>
        <strong>{{ formatBytes(item.bytes) }} · {{ item.count }}</strong>
      </div>
    </div>
    <div class="button-row cache-actions">
      <button type="button" class="button-secondary" data-action="cache-refresh" :disabled="props.pending !== null" @click="emit('refresh')">Refresh</button>
      <button type="button" class="button-secondary" data-action="cache-clear-expired" :disabled="props.pending !== null" @click="emit('clear', 'expired')">Clear expired</button>
      <button type="button" class="button-secondary" data-action="cache-clear-images" :disabled="props.pending !== null" @click="emit('clear', 'images')">Clear images</button>
      <button type="button" class="button-secondary" data-action="cache-clear-search" :disabled="props.pending !== null" @click="emit('clear', 'search')">Clear search</button>
      <button type="button" class="button-primary" data-action="cache-clear-all" :disabled="props.pending !== null" @click="emit('clear', 'all')">Clear all cache</button>
    </div>
  </section>
</template>
