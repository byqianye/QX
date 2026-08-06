<script setup lang="ts">
import { computed, ref } from "vue";

import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import PlaybackSelector from "./PlaybackSelector.vue";
import type { RendererState } from "./state.js";

const props = defineProps<{
  state: RendererState;
  pending: string | null;
  lineIndex: number;
  order: "forward" | "reverse";
}>();

const emit = defineEmits<{
  open: [];
  home: [];
  category: [];
  search: [key: string];
  detail: [vodId: string];
  play: [lineIndex: number, episodeIndex: number];
  retry: [];
  line: [index: number];
  order: [order: "forward" | "reverse"];
  switch: [];
  close: [];
}>();

const searchKey = ref("");

const statusLabels: Record<RendererState["spider"]["status"], string> = {
  confirmation_required: "等待导入确认",
  idle: "待启动",
  initializing: "正在启动",
  loading: "加载中",
  ready: "就绪",
  error: "错误",
  destroyed: "已关闭",
};

const selectedLine = computed(() => {
  const catalog = props.state.detail.playbackCatalog;
  if (!catalog) return null;
  return catalog.lines.find((line) => line.index === props.lineIndex) ?? catalog.lines[0] ?? null;
});

const canStart = computed(() => props.state.spider.status === "idle"
  || (props.state.spider.status === "error" && !props.state.spider.sidecarRunning));
const retryable = computed(() => props.state.error.error?.code.startsWith("PLAYBACK_") === true);

function submitSearch(): void {
  emit("search", searchKey.value.trim());
}

function playEpisode(line: number, episode: number): void {
  emit("play", line, episode);
}
</script>

<template>
  <main data-testid="desktop-spider-ui" :data-status="props.state.spider.status" class="renderer-shell">
    <header class="page-header">
      <p class="eyebrow">QX 影视</p>
      <h1>{{ props.state.spider.api ?? "Spider" }}</h1>
      <p class="meta">来源：{{ props.state.spider.source }} · API：{{ props.state.spider.api ?? "未选择" }}</p>
      <p data-testid="status" :class="{ loading: props.state.browse.loading || props.pending !== null }">
        {{ statusLabels[props.state.spider.status] }}{{ props.state.browse.loading || props.pending !== null ? " · 加载中" : "" }}
      </p>
    </header>

    <section v-if="props.state.spider.warning && props.state.spider.status === 'confirmation_required'" class="panel warning" data-testid="import-warning">
      <strong>首次导入需要确认</strong>
      <p>{{ props.state.spider.warning }}</p>
    </section>

    <section v-if="props.state.error.error" class="panel error" data-testid="error">
      <strong>{{ props.state.error.error.code }}</strong>
      <span data-testid="error-code">{{ props.state.error.error.code }}</span>
      <p>{{ props.state.error.error.message }}</p>
    </section>

    <nav v-if="props.state.spider.status !== 'confirmation_required' && props.state.spider.status !== 'destroyed'" aria-label="Spider 导航" class="panel button-row">
      <button v-if="canStart" data-action="open" type="button" :disabled="props.pending !== null" @click="emit('open')">启动 Spider</button>
      <button data-action="home" type="button" :disabled="props.pending !== null" @click="emit('home')">首页</button>
      <button data-action="category" data-type-id="hot_gaia" data-page="1" type="button" :disabled="props.pending !== null" @click="emit('category')">分类</button>
      <button data-action="switch" type="button" :disabled="props.pending !== null" @click="emit('switch')">切换来源</button>
      <button data-action="close" type="button" :disabled="props.pending !== null" @click="emit('close')">关闭</button>
    </nav>

    <form data-testid="search-form" @submit.prevent="submitSearch" class="panel search-form">
      <label for="search-key">搜索</label>
      <input id="search-key" v-model="searchKey" name="key" autocomplete="off" />
      <button type="submit" :disabled="props.pending !== null">搜索</button>
    </form>

    <section v-if="props.state.detail.detail" data-testid="detail-panel" class="panel detail-panel">
      <h2>{{ props.state.detail.detail.vod_name || "详情" }}</h2>
      <p>{{ props.state.detail.detail.vod_content || "" }}</p>
      <button
        data-testid="play-button"
        data-action="play"
        type="button"
        :disabled="!props.state.detail.canPlay"
        :data-play-url="props.state.playback.player.source?.url ?? (props.state.playback.playback.available ? props.state.playback.playback.url : '')"
        @click="selectedLine?.episodes[0] && emit('play', selectedLine.index, selectedLine.episodes[0].index)"
      >播放</button>
      <span data-testid="playback-label">{{ props.state.playback.playback.label }}</span>
    </section>

    <PlaybackSelector
      v-if="props.state.detail.playbackCatalog"
      :catalog="props.state.detail.playbackCatalog"
      :selection="props.state.detail.playbackSelection"
      :order="props.order"
      :retryable="retryable"
      @line="emit('line', $event)"
      @order="emit('order', $event)"
      @episode="playEpisode"
      @retry="emit('retry')"
    />

    <EmbeddedPlayer :state="props.state.playback.player" />

    <section class="vod-list" data-testid="vod-list">
      <article v-for="item in props.state.browse.items" :key="String(item.vod_id)" class="vod-card" data-testid="vod-card">
        <h3>{{ item.vod_name || "未命名" }}</h3>
        <p>{{ item.vod_remarks || "" }}</p>
        <button data-action="detail" type="button" :data-vod-id="item.vod_id" @click="emit('detail', String(item.vod_id ?? ''))">查看详情</button>
      </article>
    </section>
  </main>
</template>
