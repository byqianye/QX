<script setup lang="ts">
import { computed, inject } from "vue";
import { useRoute, useRouter } from "vue-router";

import EmptyState from "../EmptyState.vue";
import EmbeddedPlayer from "../EmbeddedPlayer.vue";
import ErrorState from "../ErrorState.vue";
import LoadingState from "../LoadingState.vue";
import PlaybackSelector from "../PlaybackSelector.vue";
import PlaybackHealthPanel from "../PlaybackHealthPanel.vue";
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

const detailId = computed(() => String(route.params.mediaId ?? ""));
const detail = computed(() => state.value.detail.detail);
const hasDetail = computed(() => detail.value !== null && String(detail.value.vod_id ?? detail.value.id ?? "") === detailId.value);
const hasPlayer = computed(() => state.value.playback.player.source !== null || state.value.playback.player.status !== "idle");
const playerDetached = computed(() => state.value.playback.session?.host === "detached");

function backToDetail(): void {
  router.push({ name: "media", params: { mediaId: detailId.value } });
}

function playFirst(): void {
  const line = context.state.value.detail.playbackCatalog?.lines[0];
  const episode = line?.episodes[0];
  if (line && episode) context.play(line.index, episode.index);
}
</script>

<template>
  <section class="core-page watch-page" data-testid="core-watch-page">
    <header class="watch-page-header">
      <div>
        <button type="button" class="text-button" data-action="core-watch-back" @click="backToDetail">返回媒体详情</button>
        <span class="section-kicker">正在观看</span>
        <h2>{{ hasDetail ? detail?.vod_name : "播放" }}</h2>
        <p v-if="hasDetail" class="meta">{{ sourceName }}</p>
      </div>
      <span class="status-chip" :data-status="state.playback.player.status">{{ state.playback.player.status === "playing" ? "播放中" : "播放准备" }}</span>
    </header>

    <LoadingState v-if="pending === 'detail' && !hasDetail" label="正在准备播放页面" />
    <EmptyState v-else-if="!hasDetail" title="暂时没有播放内容" message="当前播放地址需要从媒体详情页选择。" action-label="返回首页" @action="context.navigate('home')" />

    <template v-else>
      <PlaybackSelector
        v-if="state.detail.playbackCatalog"
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
      <section v-if="!hasPlayer && !playerDetached" class="panel watch-ready-panel">
        <span class="section-kicker">播放</span>
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
      <EmbeddedPlayer
        v-else-if="hasPlayer"
        :state="state.playback.player"
        :session-id="state.playback.session?.id"
        :danmaku="state.danmaku"
        @detach="context.playerDetach"
        @stop="context.playerStop"
        @sync="context.playerSync"
      />
      <PlaybackHealthPanel
        :health="state.playback.health"
        :fallback="state.playback.fallback"
        @cancel="context.fallbackCancel"
        @approve="context.fallbackApprove"
        @mode="context.fallbackMode"
        @back="backToDetail"
        @debug="() => undefined"
      />
    </template>

    <ErrorState
      v-if="state.error.error"
      :error="state.error.error"
      :show-technical="false"
      :pending="pending !== null"
      @retry="context.retry"
      @switch-line="context.switchSource"
      @back="backToDetail"
      @settings="context.navigate('sources')"
    />
  </section>
</template>
