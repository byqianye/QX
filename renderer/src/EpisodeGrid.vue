<script setup lang="ts">
import type { PlaybackLine } from "./state.js";

const props = defineProps<{ line: PlaybackLine; order: "forward" | "reverse"; selectedEpisode: number | null }>();
const emit = defineEmits<{ select: [episodeIndex: number] }>();

function orderedEpisodes() {
  const episodes = [...props.line.episodes];
  return props.order === "reverse" ? episodes.reverse() : episodes;
}
</script>

<template>
  <div data-component="EpisodeGrid" data-od-id="episode-grid" :data-playback-line="props.line.index" class="episode-grid">
    <p v-if="props.line.episodes.length === 0" data-testid="playback-line-empty">暂无可用选集</p>
    <button
      v-for="episode in orderedEpisodes()"
      :key="episode.index"
      type="button"
      data-action="player-episode"
      :data-line-index="props.line.index"
      :data-episode-index="episode.index"
      :data-play-flag="props.line.name"
      :data-play-id="episode.id"
      :aria-pressed="episode.index === props.selectedEpisode"
      @click="emit('select', episode.index)"
    >
      {{ episode.name }}
    </button>
  </div>
</template>
