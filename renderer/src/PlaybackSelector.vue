<script setup lang="ts">
import { computed } from "vue";

import EpisodeGrid from "./EpisodeGrid.vue";
import PlaybackLineTabs from "./PlaybackLineTabs.vue";
import type { PlaybackCatalog, PlaybackSelection } from "./state.js";

const props = defineProps<{
  catalog: PlaybackCatalog;
  selection: PlaybackSelection | null;
  lineIndex?: number;
  order: "forward" | "reverse";
  retryable: boolean;
}>();

const emit = defineEmits<{
  line: [index: number];
  order: [order: "forward" | "reverse"];
  episode: [lineIndex: number, episodeIndex: number];
  retry: [];
}>();

const selectedLine = computed(() => {
  const selected = props.lineIndex ?? props.selection?.lineIndex ?? props.catalog.lines[0]?.index ?? 0;
  return props.catalog.lines.find((line) => line.index === selected) ?? props.catalog.lines[0] ?? null;
});

const currentEpisode = computed(() => {
  const selection = props.selection;
  return selectedLine.value?.episodes.find((episode) => episode.index === selection?.episodeIndex)?.name ?? "未选择";
});

</script>

<template>
  <section data-testid="playback-selector" data-od-id="playback-selector" class="panel playback-selector">
    <strong class="playback-selector-title">线路与选集</strong>
    <p v-if="props.catalog.lines.length === 0" data-testid="playback-empty">暂无可用选集</p>
    <template v-else>
      <PlaybackLineTabs :lines="props.catalog.lines" :selected-index="selectedLine?.index ?? 0" @select="emit('line', $event)" />
      <p class="playback-selection-summary"><span data-testid="current-line">{{ selectedLine?.name ?? "" }}</span><span aria-hidden="true"> · </span><span data-testid="current-episode">{{ currentEpisode }}</span></p>
      <div data-testid="playback-order" aria-label="剧集顺序" class="button-row">
        <button
          type="button"
          data-action="playback-order"
          data-order="forward"
          :aria-pressed="props.order === 'forward'"
          @click="emit('order', 'forward')"
        >正序</button>
        <button
          type="button"
          data-action="playback-order"
          data-order="reverse"
          :aria-pressed="props.order === 'reverse'"
          @click="emit('order', 'reverse')"
        >倒序</button>
        <button v-if="props.retryable" type="button" data-testid="playback-retry" @click="emit('retry')">
          重试
        </button>
      </div>
      <div data-testid="playback-episodes" class="episode-list" tabindex="0" role="region" aria-label="选集列表">
        <EpisodeGrid
          v-if="selectedLine"
          :line="selectedLine"
          :order="props.order"
          :selected-episode="props.selection?.episodeIndex ?? null"
          @select="emit('episode', selectedLine.index, $event)"
        />
      </div>
    </template>
  </section>
</template>
