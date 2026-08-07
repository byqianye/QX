<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import AppSidebar from "./AppSidebar.vue";
import CategoryTabs from "./CategoryTabs.vue";
import DetailDrawer from "./DetailDrawer.vue";
import DiagnosticPanel from "./DiagnosticPanel.vue";
import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import ErrorState from "./ErrorState.vue";
import FilterPanel from "./FilterPanel.vue";
import FavoritesView from "./FavoritesView.vue";
import FollowView from "./FollowView.vue";
import HistoryView from "./HistoryView.vue";
import CacheManagement from "./CacheManagement.vue";
import MediaGrid from "./MediaGrid.vue";
import PlaybackSelector from "./PlaybackSelector.vue";
import PlaybackHealthPanel from "./PlaybackHealthPanel.vue";
import SettingsSection from "./SettingsSection.vue";
import SourceSwitcher from "./SourceSwitcher.vue";
import TopSearchBar from "./TopSearchBar.vue";
import PlaybackDebugPanel from "./PlaybackDebugPanel.vue";
import { PlaybackDebugTimeline } from "./playback-debug.js";
import { displaySource } from "./safe-display.js";
import type {
  RendererNavigation,
  RendererState,
  RendererThemeMode,
  PlayerMediaSync,
  RendererViewStatePatch,
  HistoryResumeMode,
} from "./state.js";

const props = defineProps<{
  state: RendererState;
  pending: string | null;
  lineIndex: number;
  order: "forward" | "reverse";
  initialNavigation?: RendererNavigation;
  initialTheme?: RendererThemeMode;
  initialSearchQuery?: string;
  persistenceDiagnostic?: { code: string; message: string } | null;
}>();

const emit = defineEmits<{
  open: [];
  home: [];
  category: [];
  search: [key: string];
  detail: [vodId: string];
  play: [lineIndex: number, episodeIndex: number, resumeMode?: HistoryResumeMode];
  retry: [];
  line: [index: number];
  order: [order: "forward" | "reverse"];
  switch: [];
  close: [];
  viewState: [patch: RendererViewStatePatch];
  playerDetach: [];
  playerAttach: [];
  playerStop: [];
  playerSync: [value: PlayerMediaSync];
  fallbackCancel: [];
  fallbackApprove: [];
  fallbackMode: [value: "off" | "prompt" | "auto"];
  historyOpen: [identity: string];
  historyDelete: [identity: string];
  historyDeleteProgress: [identity: string];
  historyClear: [identities: string[]];
  historyPause: [paused: boolean];
  favoriteToggle: [];
  favoriteMoveDetail: [groupId: string];
  favoriteOpen: [favoriteId: string];
  favoriteDelete: [favoriteId: string];
  favoriteMove: [payload: { favoriteId: string; groupId: string }];
  favoriteReorder: [payload: { groupId: string; favoriteIds: string[] }];
  favoriteCreateGroup: [name: string];
  favoriteRenameGroup: [payload: { groupId: string; name: string }];
  favoriteDeleteGroup: [payload: { groupId: string; disposition?: "default" | "delete" }];
  favoriteReorderGroups: [groupIds: string[]];
  followRefresh: [];
  followOpen: [identity: string];
  followDelete: [identity: string];
  followMarkWatched: [identity: string];
  followMarkUnwatched: [identity: string];
  followToggle: [];
  followAndFavorite: [];
  cacheRefresh: [];
  cacheClear: [scope: "expired" | "images" | "search" | "all"];
}>();

const view = ref<"browse" | "history" | "favorites" | "follow" | "settings">(props.initialNavigation === "settings"
  ? "settings"
  : props.initialNavigation === "history" ? "history"
    : props.initialNavigation === "favorites" ? "favorites"
      : props.initialNavigation === "follow" ? "follow" : "browse");
const theme = ref<"system" | "light" | "dark">(props.initialTheme ?? "light");
const systemTheme = ref<"light" | "dark">("light");
const debugOpen = ref(false);
const debugVersion = ref(0);
const pendingResumeEpisode = ref<{ lineIndex: number; episodeIndex: number } | null>(null);
const debugTimeline = new PlaybackDebugTimeline();
let systemMediaQuery: MediaQueryList | null = null;

const resolvedTheme = computed(() => theme.value === "system" ? systemTheme.value : theme.value);

function syncSystemTheme(event?: MediaQueryList | MediaQueryListEvent): void {
  systemTheme.value = event?.matches ? "dark" : "light";
}

onMounted(() => {
  window.addEventListener("keydown", handleDebugKeydown);
  if (typeof window.matchMedia === "function") {
    systemMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    syncSystemTheme(systemMediaQuery);
    systemMediaQuery.addEventListener?.("change", syncSystemTheme);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleDebugKeydown);
  systemMediaQuery?.removeEventListener?.("change", syncSystemTheme);
  systemMediaQuery = null;
});

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
const activePage = computed(() => view.value === "settings" || view.value === "history" || view.value === "favorites" || view.value === "follow" ? view.value : props.state.browse.page);
const retryable = computed(() => props.state.error.error?.retryable === true);
const hasPlayback = computed(() => props.state.detail.playbackCatalog !== null || props.state.playback.player.source !== null);
const playerDetached = computed(() => props.state.playback.session?.host === "detached");
const resumeTarget = computed(() => pendingResumeEpisode.value ?? (
  props.state.historyResume?.lineIndex !== null
  && props.state.historyResume?.lineIndex !== undefined
  && props.state.historyResume?.episodeIndex !== null
  && props.state.historyResume?.episodeIndex !== undefined
    ? {
        lineIndex: props.state.historyResume.lineIndex,
        episodeIndex: props.state.historyResume.episodeIndex,
      }
    : null
));
const debugSnapshot = computed(() => {
  debugVersion.value;
  return debugTimeline.snapshot(props.state);
});

watch(
  () => [props.state, props.pending] as const,
  () => {
    debugTimeline.recordState(props.state, props.pending);
    debugVersion.value += 1;
  },
  { deep: true, immediate: true },
);

watch(() => props.state.browse.page, (page) => {
  if ((view.value === "history" || view.value === "favorites" || view.value === "follow") && page === "detail") {
    view.value = "browse";
    persistNavigation("detail");
  }
});

watch(theme, () => {
  emit("viewState", {
    theme: theme.value,
    navigation: view.value === "settings" || view.value === "history" || view.value === "favorites" || view.value === "follow"
      ? view.value
      : navigationFromPage(props.state.browse.page),
  });
});

function navigate(route: "home" | "category" | "history" | "favorites" | "follow" | "settings"): void {
  if (route === "settings") {
    view.value = "settings";
    persistNavigation("settings");
    return;
  }
  if (route === "history") {
    view.value = "history";
    persistNavigation("history");
    return;
  }
  if (route === "favorites") {
    view.value = "favorites";
    persistNavigation("favorites");
    return;
  }
  if (route === "follow") {
    view.value = "follow";
    persistNavigation("follow");
    emit("followRefresh");
    return;
  }
  view.value = "browse";
  persistNavigation(route);
  if (route === "home") emit("home");
  else emit("category");
}

function submitSearch(query: string): void {
  view.value = "browse";
  persistNavigation("search");
  emit("search", query);
}

function selectCategory(key: "home" | "category"): void {
  navigate(key);
}

function playFirstEpisode(): void {
  const line = selectedLine.value;
  const episode = line?.episodes[0];
  if (line && episode) requestPlay(line.index, episode.index);
}

function requestPlay(lineIndex: number, episodeIndex: number): void {
  const candidate = props.state.historyResume;
  const candidateMatches = candidate !== null
    && candidate !== undefined
    && candidate.lineIndex === lineIndex
    && candidate.episodeIndex === episodeIndex;
  if (candidateMatches) {
    pendingResumeEpisode.value = { lineIndex, episodeIndex };
    return;
  }
  emit("play", lineIndex, episodeIndex);
}

function continueResume(): void {
  const target = resumeTarget.value;
  if (!target) return;
  pendingResumeEpisode.value = null;
  emit("play", target.lineIndex, target.episodeIndex, "continue");
}

function playResumeFromBeginning(): void {
  const target = resumeTarget.value;
  if (!target) return;
  pendingResumeEpisode.value = null;
  emit("play", target.lineIndex, target.episodeIndex, "beginning");
}

function cancelResume(): void {
  pendingResumeEpisode.value = null;
}

function formatResumePosition(position: number): string {
  const seconds = Math.max(0, Math.floor(position));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function openDebug(): void {
  debugOpen.value = true;
}

function closeDebug(): void {
  debugOpen.value = false;
}

function handleDebugKeydown(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== "d" || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
  event.preventDefault();
  debugOpen.value = !debugOpen.value;
}

function persistNavigation(navigation: RendererNavigation): void {
  emit("viewState", { theme: theme.value, navigation });
}

function navigationFromPage(page: string): RendererNavigation {
  return page === "category" || page === "search" || page === "detail" ? page : "home";
}
</script>

<template>
  <main
    data-testid="desktop-spider-ui"
    :data-status="props.state.spider.status"
    :data-theme="resolvedTheme"
    :data-theme-mode="theme"
    class="app-shell"
  >
    <AppSidebar
      :active-page="String(activePage)"
      :source="props.state.spider.source"
      :status="props.state.spider.status"
      :can-start="canStart"
      :pending="props.pending !== null"
      :theme="theme"
      :follow-updates="props.state.follow.updateCount"
      @navigate="navigate"
      @open="emit('open')"
      @switch="emit('switch')"
      @close="emit('close')"
      @theme="theme = $event"
    />

    <section class="workspace">
      <TopSearchBar
        :source="props.state.spider.source"
        :api="props.state.spider.api"
        :pending="props.pending !== null"
        :initial-query="props.initialSearchQuery"
        @search="submitSearch"
      />

      <div class="workspace-content">
        <header class="workspace-header">
          <div>
            <span class="section-kicker">{{ view === "settings" ? "工作区设置" : view === "history" ? "播放历史" : view === "favorites" ? "收藏管理" : view === "follow" ? "追更状态" : "媒体工作台" }}</span>
            <h1>{{ view === "settings" ? "设置" : view === "history" ? "History" : view === "favorites" ? "Favorites" : view === "follow" ? "追更" : (props.state.spider.api ? displaySource(props.state.spider.api) : "QX 影视") }}</h1>
            <p data-testid="status" class="workspace-status" :class="{ loading: props.state.browse.loading || props.pending !== null }">
              {{ statusLabels[props.state.spider.status] }}{{ props.state.browse.loading || props.pending !== null ? " · 加载中" : "" }}
            </p>
          </div>
          <div class="workspace-header-meta">
            <span class="status-chip" :data-status="props.state.spider.status">{{ props.state.spider.sidecarRunning ? "连接正常" : "未启动" }}</span>
          </div>
        </header>

        <PlaybackDebugPanel v-if="debugOpen" :snapshot="debugSnapshot" @close="closeDebug" />

        <SourceSwitcher
          :source="props.state.spider.source"
          :api="props.state.spider.api"
          :status="props.state.spider.status"
          :pending="props.pending !== null"
          @change="emit('switch')"
        />

        <template v-if="view === 'settings'">
          <SettingsSection title="来源管理" description="管理已导入的来源和当前连接状态。">
            <div class="settings-row"><span>当前来源</span><strong>{{ displaySource(props.state.spider.source) }}</strong></div>
            <button type="button" class="button-secondary" data-action="settings-switch" @click="emit('switch')">切换来源</button>
          </SettingsSection>
          <SettingsSection title="主题" description="默认使用浅色；选择跟随系统时只读取操作系统的明暗偏好，不保存敏感信息。">
            <label class="settings-control">
              <span>外观模式</span>
              <select v-model="theme" data-action="theme-mode" aria-label="外观模式">
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </SettingsSection>
          <SettingsSection title="LocalProxy" description="播放需要代理时，Electron 主进程负责管理代理会话与生命周期。">
            <div class="settings-row"><span>状态</span><strong>{{ props.state.playback.playback.available ? "按线路决定" : "等待播放线路" }}</strong></div>
            <button type="button" class="button-secondary" data-action="proxy-test">测试连接</button>
          </SettingsSection>
          <SettingsSection title="播放偏好" description="播放顺序与当前线路由既有会话状态决定；本阶段不增加未确认的播放器能力。">
            <div class="settings-row"><span>当前剧集顺序</span><strong>{{ props.order === "forward" ? "正序" : "倒序" }}</strong></div>
          </SettingsSection>
          <SettingsSection title="诊断与日志" description="只展示主进程返回的脱敏诊断，不在 renderer 读取日志文件或凭据。">
            <DiagnosticPanel
              :source="props.state.spider.source"
              :player-status="props.state.playback.player.status"
              :code="props.state.error.error?.code ?? props.persistenceDiagnostic?.code"
              :message="props.state.error.error?.message ?? props.persistenceDiagnostic?.message"
              :error="props.state.error.error ?? undefined"
              :diagnostic="props.persistenceDiagnostic"
              :show-debug="true"
              @open-debug="openDebug"
            />
          </SettingsSection>
          <SettingsSection title="隐私" description="凭据、Cookie、完整播放地址和本机路径不在界面回显。">
            <div class="settings-row"><span>renderer 数据边界</span><strong>仅 typed IPC</strong></div>
          </SettingsSection>
          <CacheManagement
            :state="props.state.cache"
            :pending="props.pending"
            @refresh="emit('cacheRefresh')"
            @clear="emit('cacheClear', $event)"
          />
        </template>

        <FavoritesView
          v-else-if="view === 'favorites'"
          :state="props.state.favorites"
          :pending="props.pending"
          @open="emit('favoriteOpen', $event)"
          @delete="emit('favoriteDelete', $event)"
          @move="emit('favoriteMove', $event)"
          @reorder="emit('favoriteReorder', $event)"
          @create-group="emit('favoriteCreateGroup', $event)"
          @rename-group="emit('favoriteRenameGroup', $event)"
          @delete-group="emit('favoriteDeleteGroup', $event)"
          @reorder-groups="emit('favoriteReorderGroups', $event)"
          @search="submitSearch"
        />
        <FollowView
          v-else-if="view === 'follow'"
          :state="props.state.follow"
          :pending="props.pending"
          @refresh="emit('followRefresh')"
          @open="emit('followOpen', $event)"
          @delete="emit('followDelete', $event)"
          @mark-watched="emit('followMarkWatched', $event)"
          @mark-unwatched="emit('followMarkUnwatched', $event)"
        />
        <HistoryView
          v-else-if="view === 'history'"
          :state="props.state.history"
          :pending="props.pending"
          @open="emit('historyOpen', $event)"
          @delete="emit('historyDelete', $event)"
          @delete-progress="emit('historyDeleteProgress', $event)"
          @clear="emit('historyClear', $event)"
          @pause="emit('historyPause', $event)"
        />

        <template v-else>
          <CategoryTabs :active="props.state.browse.page" @select="selectCategory" />
          <FilterPanel @clear="emit('home')" />

          <div v-if="props.state.error.error" data-testid="error">
            <ErrorState
              :error="props.state.error.error"
              :pending="props.pending !== null"
              @retry="emit('retry')"
              @switch-line="emit('switch')"
              @back="navigate('home')"
              @settings="navigate('settings')"
              @open-debug="openDebug"
            />
          </div>

          <MediaGrid
            :items="props.state.browse.items"
            :loading="props.state.browse.loading || props.pending !== null"
            :playing-id="props.state.detail.detail?.vod_id ? String(props.state.detail.detail.vod_id) : null"
            @detail="emit('detail', $event)"
            @home="emit('home')"
          />

          <DetailDrawer
            v-if="props.state.detail.detail"
            :detail="props.state.detail.detail"
            :can-play="props.state.detail.canPlay"
            :playback-label="props.state.playback.playback.label"
            :favorite="props.state.favoriteDetail"
            :favorite-groups="props.state.favorites.groups"
            :favorite-pending="props.pending !== null"
            :follow="props.state.followDetail"
            :follow-pending="props.pending !== null"
            @close="emit('home')"
            @play="playFirstEpisode"
            @favorite-toggle="emit('favoriteToggle')"
            @favorite-move="emit('favoriteMoveDetail', $event)"
            @follow-toggle="emit('followToggle')"
            @follow-and-favorite="emit('followAndFavorite')"
          />

          <section v-if="hasPlayback" class="playback-stage" data-testid="playback-stage">
            <section v-if="resumeTarget && props.state.historyResume" class="panel history-resume-prompt" data-testid="history-resume-prompt">
              <span class="section-kicker">播放进度</span>
              <h3>{{ props.state.historyResume.title }}</h3>
              <p class="meta">
                {{ props.state.historyResume.episodeName ?? "当前集数" }} · 已播放 {{ formatResumePosition(props.state.historyResume.position) }}
                <span v-if="props.state.historyResume.completed">· 已看完</span>
              </p>
              <p>要从上次位置继续，还是从头开始？</p>
              <div class="button-row">
                <button type="button" class="button-primary" data-action="history-resume" @click="continueResume">继续播放</button>
                <button type="button" class="button-secondary" data-action="history-beginning" @click="playResumeFromBeginning">从头播放</button>
                <button type="button" class="text-button" data-action="history-delete-progress" @click="emit('historyDeleteProgress', props.state.historyResume!.identity); cancelResume()">删除进度</button>
                <button type="button" class="text-button" data-action="history-cancel" @click="cancelResume">取消</button>
              </div>
            </section>
            <PlaybackSelector
              v-if="props.state.detail.playbackCatalog"
              :catalog="props.state.detail.playbackCatalog"
              :selection="props.state.detail.playbackSelection"
              :order="props.order"
              :retryable="retryable"
              @line="emit('line', $event)"
              @order="emit('order', $event)"
              @episode="requestPlay($event[0], $event[1])"
              @retry="emit('retry')"
            />
            <template v-if="playerDetached">
              <section class="panel detached-player-panel" data-testid="detached-player-panel">
                <span class="section-kicker">独立播放窗口</span>
                <h3>{{ props.state.playback.session?.media.title ?? "当前媒体" }}</h3>
                <p class="meta">{{ props.state.playback.session?.lineName ?? "当前线路" }} · {{ props.state.playback.session?.episodeName ?? "当前选集" }}</p>
                <p data-testid="detached-player-status">播放已转移到独立窗口，主窗口不会后台播放。</p>
                <div class="button-row">
                  <button type="button" class="button-primary" data-action="player-attach" @click="emit('playerAttach')">返回主窗口</button>
                  <button type="button" class="button-secondary" data-action="player-stop" @click="emit('playerStop')">停止播放</button>
                </div>
              </section>
            </template>
            <EmbeddedPlayer
              v-else
              :state="props.state.playback.player"
              @detach="emit('playerDetach')"
              @stop="emit('playerStop')"
              @sync="emit('playerSync', $event)"
            />
            <DiagnosticPanel
              :source="props.state.spider.source"
              :player-status="props.state.playback.player.status"
              :code="props.state.error.error?.code"
              :error="props.state.error.error ?? undefined"
              :show-debug="true"
              @open-debug="openDebug"
            />
            <PlaybackHealthPanel
              :health="props.state.playback.health"
              :fallback="props.state.playback.fallback"
              @cancel="emit('fallbackCancel')"
              @approve="emit('fallbackApprove')"
              @mode="emit('fallbackMode', $event)"
              @back="navigate('home')"
              @debug="openDebug"
            />
          </section>
          <section v-else class="playback-stage playback-stage-empty" data-testid="playback-panel">
            <span class="section-kicker">播放</span>
            <p class="meta">选择媒体详情后，这里会显示线路、选集和播放器。</p>
          </section>
        </template>
      </div>
    </section>
  </main>
</template>
