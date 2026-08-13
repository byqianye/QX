<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import Icon from "./Icon.vue";
import PosterImage from "./PosterImage.vue";
import type { PlaybackSourceResolution } from "../../src/desktop/playback-source-resolver.js";
import type { FavoriteGroupItem, FavoriteItem } from "../../src/favorites/favorites-types.js";
import type { FollowItem } from "../../src/follow/follow-types.js";

const props = defineProps<{
  detail: Record<string, unknown>;
  sourceName?: string;
  canPlay: boolean;
  playbackLabel: string;
  favorite?: FavoriteItem | null;
  favoriteGroups?: readonly FavoriteGroupItem[];
  favoritePending?: boolean;
  follow?: FollowItem | null;
  followPending?: boolean;
  canSearchPlayback?: boolean;
  playbackSources?: PlaybackSourceResolution | null;
  playbackSourcePending?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  play: [];
  favoriteToggle: [];
  favoriteMove: [groupId: string];
  followToggle: [];
  followAndFavorite: [];
  findPlaybackSource: [];
  selectPlaybackSource: [siteKey: string, vodId: string];
}>();
const closeButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("keydown", closeOnEscape);
  closeButton.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", closeOnEscape);
  previousFocus?.focus();
});

const detailFields = computed(() => [
  ["评分", "vod_score"],
  ["年份", "vod_year"],
  ["地区", "vod_area"],
  ["类型", "vod_class"],
  ["导演", "vod_director"],
  ["演员", "vod_actor"],
].flatMap(([label, key]) => {
  const value = props.detail[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? []
    : [{ label, value: String(value) }];
}));

const playableCandidates = computed(() => (props.playbackSources?.candidates ?? [])
  .filter((candidate) => candidate.playable));
</script>

<template>
  <aside class="detail-drawer" data-testid="detail-drawer" data-od-id="detail-drawer" aria-label="媒体详情">
    <section class="detail-drawer-panel" data-testid="detail-panel">
      <button ref="closeButton" type="button" class="drawer-close" aria-label="关闭详情" @click="emit('close')"><Icon name="close" /></button>
      <div class="detail-cover">
        <PosterImage
          :source="typeof detail.vod_pic === 'string' && detail.vod_pic.trim() ? detail.vod_pic : null"
          :alt="`${String(detail.vod_name || '详情')} 海报`"
          :fallback-text="String(detail.vod_name || '详情')"
          test-id="detail-poster"
        />
      </div>
      <span class="section-kicker">媒体详情</span>
      <h2>{{ detail.vod_name || "详情" }}</h2>
      <p class="detail-summary">{{ detail.vod_content || "暂无简介" }}</p>
      <dl class="detail-meta">
        <div v-for="field in detailFields" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div>
        <div><dt>线路状态</dt><dd>{{ playbackLabel }}</dd></div>
        <div><dt>来源</dt><dd>{{ props.sourceName ?? "当前来源" }}</dd></div>
      </dl>
      <div class="favorite-actions" data-testid="favorite-detail-actions">
        <button
          type="button"
          class="button-secondary"
          data-action="favorite-toggle-detail"
          :disabled="favoritePending"
          @click="emit('favoriteToggle')"
        >{{ favorite ? "已收藏" : "收藏" }}</button>
        <label v-if="favorite" class="favorite-group-control">
          <span>移动分组</span>
          <select
            data-action="favorite-move-detail"
            :value="favorite.groupId ?? 'default'"
            :disabled="favoritePending"
            @change="emit('favoriteMove', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="group in favoriteGroups ?? []" :key="group.groupId" :value="group.groupId">{{ group.name }}</option>
          </select>
        </label>
      </div>
      <div class="follow-detail-actions" data-testid="follow-detail-actions">
        <button
          type="button"
          class="button-secondary"
          data-action="follow-toggle-detail"
          :disabled="followPending"
          @click="emit('followToggle')"
        >{{ follow ? "已在追更" : "加入追更" }}</button>
        <button
          v-if="!favorite && !follow"
          type="button"
          class="button-secondary"
          data-action="follow-and-favorite-detail"
          :disabled="followPending || favoritePending"
          @click="emit('followAndFavorite')"
        >收藏并追更</button>
      </div>
      <button
        data-testid="play-button"
        data-action="play"
        class="button-primary button-wide"
        type="button"
        :disabled="!canPlay"
        @click="emit('play')"
      >播放</button>
      <section v-if="props.canSearchPlayback" class="playback-source-search" data-testid="playback-source-search">
        <button
          v-if="!props.playbackSources"
          type="button"
          class="button-secondary button-wide"
          data-action="find-playback-source"
          :disabled="props.playbackSourcePending"
          @click="emit('findPlaybackSource')"
        >查找播放源</button>
        <p v-if="props.playbackSourcePending" data-testid="playback-source-searching">正在查找播放源…</p>
        <template v-else-if="props.playbackSources">
          <p
            v-if="props.playbackSources.diagnostics?.runtimePreparation === 'ready'"
            data-testid="android-runtime-ready"
          >Android Runtime READY ({{ props.playbackSources.diagnostics.runtimeWaitDurationMs }}ms)</p>
          <div v-if="playableCandidates.length > 0" data-testid="playback-source-candidates">
            <p>找到可播放来源，请选择：</p>
            <button
              v-for="candidate in playableCandidates"
              :key="`${candidate.siteKey}-${candidate.vod.id}`"
              type="button"
              class="button-secondary button-wide"
              data-action="playback-source-select"
              :data-site-key="candidate.siteKey"
              :data-vod-id="candidate.vod.id"
              @click="emit('selectPlaybackSource', candidate.siteKey, candidate.vod.id)"
            >{{ candidate.siteName }} · {{ candidate.vod.name }}（匹配 {{ candidate.score }}）</button>
          </div>
          <template v-else>
            <p data-testid="playback-source-empty">当前配置中未找到可播放来源</p>
            <details v-if="props.playbackSources.diagnostics" data-testid="playback-source-diagnostics">
              <summary>查看诊断</summary>
              <p>
                配置 {{ props.playbackSources.diagnostics.configSiteCount }} 个来源
                → 允许搜索 {{ props.playbackSources.diagnostics.searchableSites }}
                → QX 当前支持 {{ props.playbackSources.diagnostics.runtimeSupportedSites }}
              </p>
              <p>
                成功搜索 {{ props.playbackSources.diagnostics.searchSuccessSites.length }}
                → 获得 {{ props.playbackSources.diagnostics.searchResultCount }} 个结果
                → 匹配 {{ props.playbackSources.diagnostics.matchedCandidateCount }}
                → 有播放线路 {{ props.playbackSources.diagnostics.playableCandidateCount }}
              </p>
              <p v-if="props.playbackSources.diagnostics.runtimeSupportedSites <= 1 && props.playbackSources.diagnostics.unsupportedSiteCount > 0">
                多数来源因当前 Spider Runtime 尚未支持而被跳过
              </p>
              <ul>
                <li v-for="site in props.playbackSources.diagnostics.sites" :key="site.siteKey">
                  {{ site.siteName }}：初始化 {{ site.initialization }}，搜索 {{ site.search }}，结果 {{ site.resultCount }}<span v-if="site.skipReason">，{{ site.skipReason }}</span>
                </li>
              </ul>
            </details>
          </template>
        </template>
      </section>
    </section>
  </aside>
</template>
