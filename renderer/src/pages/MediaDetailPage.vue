<script setup lang="ts">
import { computed, inject } from "vue";
import { useRoute, useRouter } from "vue-router";

import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import LoadingState from "../LoadingState.vue";
import PlaybackSelector from "../PlaybackSelector.vue";
import PosterImage from "../PosterImage.vue";
import { useCoreRouteContext } from "../core-route-context.js";

const route = useRoute();
const router = useRouter();
const context = useCoreRouteContext(inject);
const state = context.state;
const pending = context.pending;
const lineIndex = context.lineIndex;
const order = context.order;
const sourceName = context.sourceName;
const retryable = context.retryable;
const canSearchPlayback = context.canSearchPlayback;

const detail = computed(() => state.value.detail.detail);
const detailId = computed(() => String(route.params.mediaId ?? ""));
const fields = computed(() => [
  ["评分", "vod_score"],
  ["年份", "vod_year"],
  ["地区", "vod_area"],
  ["类型", "vod_class"],
  ["导演", "vod_director"],
  ["演员", "vod_actor"],
].flatMap(([label, key]) => {
  const value = detail.value?.[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? []
    : [{ label, value: String(value) }];
}));
const playableCandidates = computed(() => (state.value.playbackSources?.candidates ?? []).filter((candidate) => candidate.playable));
const sourceSearchPending = computed(() => pending.value === "playback-source-search" || pending.value === "playback-source-select");
const hasMatchingDetail = computed(() => detail.value !== null && String(detail.value.vod_id ?? detail.value.id ?? "") === detailId.value);
const selectedLine = computed(() => {
  const catalog = state.value.detail.playbackCatalog;
  if (!catalog) return null;
  return catalog.lines.find((line) => line.index === lineIndex.value) ?? catalog.lines[0] ?? null;
});
const selectedEpisode = computed(() => {
  const episodeIndex = state.value.detail.playbackSelection?.episodeIndex;
  return selectedLine.value?.episodes.find((episode) => episode.index === episodeIndex)
    ?? selectedLine.value?.episodes[0]
    ?? null;
});

function goBack(): void {
  if (window.history.length > 1) router.back();
  else context.navigate("home");
}

function playFirst(): void {
  if (selectedLine.value && selectedEpisode.value) context.play(selectedLine.value.index, selectedEpisode.value.index);
}

function selectPlaybackSource(siteKey: string, vodId: string): void {
  context.selectPlaybackSource(siteKey, vodId);
}
</script>

<template>
  <section class="core-page media-detail-page" data-testid="core-media-detail-page">
    <button type="button" class="text-button core-back-button" data-action="core-detail-back" @click="goBack">返回</button>

    <LoadingState v-if="pending === 'detail' && !hasMatchingDetail" label="正在读取媒体详情" />
    <EmptyState v-else-if="!hasMatchingDetail" title="暂时没有详情" message="当前路由没有对应的媒体内容。" action-label="返回首页" @action="context.navigate('home')" />

    <template v-else-if="detail">
      <header class="detail-page-hero">
        <div class="detail-page-cover">
          <PosterImage
            :source="typeof detail.vod_pic === 'string' && detail.vod_pic.trim() ? detail.vod_pic : null"
            :alt="`${String(detail.vod_name ?? '媒体')} 海报`"
            :fallback-text="String(detail.vod_name ?? '媒体')"
            test-id="core-detail-poster"
          />
        </div>
        <div class="detail-page-copy">
          <span class="section-kicker">媒体详情</span>
          <h2>{{ detail.vod_name }}</h2>
          <p class="detail-page-summary">{{ detail.vod_content || "暂无简介" }}</p>
          <div class="button-row">
            <button type="button" class="button-primary" data-action="core-detail-play" :disabled="!selectedLine || !selectedEpisode" @click="playFirst">播放</button>
            <button type="button" class="button-secondary" data-action="core-detail-favorite" :disabled="pending !== null" @click="context.favoriteToggle">{{ state.favoriteDetail ? "已收藏" : "收藏" }}</button>
            <button type="button" class="button-secondary" data-action="core-detail-follow" :disabled="pending !== null" @click="context.followToggle">{{ state.followDetail ? "已在追更" : "加入追更" }}</button>
          </div>
        </div>
      </header>

      <dl v-if="fields.length > 0" class="detail-page-meta">
        <div v-for="field in fields" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div>
        <div><dt>来源</dt><dd>{{ sourceName }}</dd></div>
        <div><dt>线路</dt><dd>{{ state.playback.playback.label }}</dd></div>
      </dl>

      <section v-if="state.detail.playbackCatalog" class="detail-page-section">
        <div class="core-section-heading"><div><span class="section-kicker">播放选择</span><h3>线路与选集</h3></div></div>
        <PlaybackSelector
          :catalog="state.detail.playbackCatalog"
          :selection="state.detail.playbackSelection"
          :line-index="lineIndex"
          :order="order"
          :retryable="retryable"
          @line="context.setLine"
          @order="context.setOrder"
          @episode="context.play"
          @retry="context.retry"
        />
      </section>

      <section v-if="canSearchPlayback" class="detail-page-section playback-source-search" data-testid="core-playback-source-search">
        <div class="core-section-heading"><div><span class="section-kicker">来源适配</span><h3>查找可播放来源</h3></div></div>
        <button v-if="!state.playbackSources" type="button" class="button-secondary" :disabled="sourceSearchPending" data-action="core-find-playback-source" @click="context.findPlaybackSource">查找播放源</button>
        <p v-if="sourceSearchPending" class="meta loading">正在查找播放源</p>
        <div v-if="playableCandidates.length > 0" class="playback-candidate-list">
          <button v-for="candidate in playableCandidates" :key="`${candidate.siteKey}-${candidate.vod.id}`" type="button" class="button-secondary" data-action="core-select-playback-source" @click="selectPlaybackSource(candidate.siteKey, candidate.vod.id)">
            {{ candidate.siteName }} · {{ candidate.vod.name }}
          </button>
        </div>
        <p v-else-if="state.playbackSources && !sourceSearchPending" class="meta">当前配置中未找到可播放来源。</p>
      </section>
    </template>

    <ErrorState
      v-if="state.error.error"
      :error="state.error.error"
      :show-technical="false"
      :pending="pending !== null"
      @retry="context.retry"
      @switch-line="context.switchSource"
      @back="goBack"
      @settings="context.navigate('sources')"
    />
  </section>
</template>
