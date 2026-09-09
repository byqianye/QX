<script setup lang="ts">
import { computed, inject } from "vue";
import { useRoute } from "vue-router";

import EmptyState from "../EmptyState.vue";
import EmbeddedPlayer from "../EmbeddedPlayer.vue";
import ErrorState from "../ErrorState.vue";
import LoadingState from "../LoadingState.vue";
import PlaybackSelector from "../PlaybackSelector.vue";
import PlaybackHealthPanel from "../PlaybackHealthPanel.vue";
import { useCoreRouteContext } from "../core-route-context.js";

const route = useRoute();
const context = useCoreRouteContext(inject);
const state = context.state;
const pending = context.pending;
const lineIndex = context.lineIndex;
const order = context.order;
const sourceName = context.sourceName;
const retryable = context.retryable;

const detailId = computed(() => String(route.params.mediaId ?? ""));
const detail = computed(() => state.value.detail.detail);
const hasDetail = computed(() => detail.value !== null && String(detail.value.vod_id ?? detail.value.id ?? "") === detailId.value);
const playerBelongsToDetail = computed(() => {
  const sessionDetailId = state.value.playback.session?.media.detailId;
  return !sessionDetailId || String(sessionDetailId) === detailId.value;
});
const hasPlayer = computed(() => playerBelongsToDetail.value && (pending.value === "player"
  || pending.value === "player-line-switch"
  || state.value.playback.player.source !== null
  || state.value.playback.player.status !== "idle"
  || state.value.playback.session !== null));
const playerDetached = computed(() => playerBelongsToDetail.value && state.value.playback.session?.host === "detached");
const playerPlaybackKey = computed(() => {
  const selection = state.value.detail.playbackSelection;
  return [
    state.value.playback.session?.id ?? "",
    selection?.lineIndex ?? "",
    selection?.episodeIndex ?? "",
  ].join(":");
});
const resumeCandidate = computed(() => {
  const candidate = state.value.historyResume;
  if (!candidate || !candidate.canResume || String(candidate.vodId) !== detailId.value) return null;
  if (candidate.lineIndex === null || candidate.episodeIndex === null) return null;
  return candidate;
});

function playFirst(): void {
  if (resumeCandidate.value) return;
  const line = context.state.value.detail.playbackCatalog?.lines[0];
  const episode = line?.episodes[0];
  if (line && episode) context.play(line.index, episode.index);
}

function playEpisode(lineIndex: number, episodeIndex: number): void {
  if (resumeCandidate.value) return;
  context.play(lineIndex, episodeIndex);
}

function continueResume(): void {
  const candidate = resumeCandidate.value;
  if (!candidate || candidate.lineIndex === null || candidate.episodeIndex === null) return;
  context.play(candidate.lineIndex, candidate.episodeIndex, "continue");
}

function playFromBeginning(): void {
  const candidate = resumeCandidate.value;
  if (!candidate || candidate.lineIndex === null || candidate.episodeIndex === null) return;
  context.play(candidate.lineIndex, candidate.episodeIndex, "beginning");
}

function formatResumePosition(position: number): string {
  const seconds = Math.max(0, Math.floor(position));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

</script>

<template>
  <section class="core-page watch-page" data-testid="core-watch-page">
    <header class="watch-page-header">
      <div>
        <h2>{{ hasDetail ? detail?.vod_name : "播放" }}</h2>
      </div>
    </header>

    <LoadingState v-if="pending === 'detail' && !hasDetail" label="正在准备播放页面" />
    <EmptyState v-else-if="!hasDetail" title="暂时没有播放内容" message="当前播放地址需要从媒体详情页选择。" :show-action="false" />

    <div v-else class="watch-layout">
      <div class="watch-screen-column">
      <div class="watch-screen" data-testid="watch-screen">
      <EmbeddedPlayer
        v-if="hasPlayer && !playerDetached"
        :state="state.playback.player"
        :session-id="state.playback.session?.id"
        :playback-key="playerPlaybackKey"
        :danmaku="state.danmaku"
        @detach="context.playerDetach"
        @stop="context.playerStop"
        @sync="context.playerSync"
      />
      <section v-if="resumeCandidate" class="panel history-resume-prompt" data-testid="core-history-resume-prompt">
        <span class="section-kicker">播放进度</span>
        <h3>{{ resumeCandidate.title }}</h3>
        <p class="meta">{{ resumeCandidate.episodeName ?? "当前集数" }} · 已播放 {{ formatResumePosition(resumeCandidate.position) }}<span v-if="resumeCandidate.completed"> · 已看完</span></p>
        <p>要从上次位置继续，还是从头开始？</p>
        <div class="button-row">
          <button type="button" class="button-primary" data-action="core-history-resume" @click="continueResume">继续播放</button>
          <button type="button" class="button-secondary" data-action="core-history-beginning" @click="playFromBeginning">从头播放</button>
          <button type="button" class="text-button" data-action="core-history-delete-progress" @click="context.historyDeleteProgress(resumeCandidate.identity)">删除进度</button>
        </div>
      </section>
      <section v-if="!hasPlayer && !playerDetached && !resumeCandidate" class="panel watch-ready-panel">
        <h3>{{ detail?.vod_name }}</h3>
        <p>选择线路和选集后开始播放。</p>
        <button type="button" class="button-primary" :disabled="!state.detail.playbackCatalog" data-action="core-watch-play" @click="playFirst">开始播放</button>
      </section>
      <section v-if="playerDetached" class="panel detached-player-panel" data-testid="core-detached-player-panel">
        <span class="section-kicker">独立播放窗口</span>
        <h3>{{ state.playback.session?.media.title || "当前媒体" }}</h3>
        <p class="meta">{{ state.playback.session?.lineName || "当前线路" }} · {{ state.playback.session?.episodeName || "当前选集" }}</p>
        <p>播放已转移到独立窗口，主窗口不会后台播放。</p>
        <div class="button-row">
          <button type="button" class="button-primary" data-action="core-player-attach" @click="context.playerAttach">返回主窗口</button>
          <button type="button" class="button-secondary" data-action="core-player-stop" @click="context.playerStop">停止播放</button>
        </div>
      </section>
      </div>
      <PlaybackHealthPanel
        compact
        :health="state.playback.health"
        :fallback="state.playback.fallback"
        @cancel="context.fallbackCancel"
        @approve="context.fallbackApprove"
        @mode="context.fallbackMode"
        @debug="() => undefined"
      />
      </div>
      <aside class="watch-episode-panel" aria-label="来源与选集" data-testid="watch-episode-panel">
        <section class="watch-source-panel" data-testid="watch-source-panel">
          <div><span class="meta">当前来源</span><strong>{{ sourceName }}</strong></div>
          <button type="button" class="text-button" data-action="core-watch-switch-source" @click="context.openSources">切换</button>
        </section>
        <PlaybackSelector
          v-if="state.detail.playbackCatalog"
          :catalog="state.detail.playbackCatalog"
          :selection="state.detail.playbackSelection"
          :line-index="lineIndex"
          :order="order"
          :retryable="retryable"
          @line="context.setLine"
          @order="context.setOrder"
          @episode="playEpisode"
          @retry="context.retry"
        />
      </aside>
    </div>

    <ErrorState
      v-if="state.error.error"
      :error="state.error.error"
      :show-technical="false"
      :show-back="false"
      :pending="pending !== null"
      @retry="context.retry"
      @switch-line="context.openSources"
      @settings="context.navigate('sources')"
    />
  </section>
</template>
