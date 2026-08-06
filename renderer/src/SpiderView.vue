<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import AppSidebar from "./AppSidebar.vue";
import CategoryTabs from "./CategoryTabs.vue";
import DetailDrawer from "./DetailDrawer.vue";
import DiagnosticPanel from "./DiagnosticPanel.vue";
import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import ErrorState from "./ErrorState.vue";
import FilterPanel from "./FilterPanel.vue";
import MediaGrid from "./MediaGrid.vue";
import PlaybackSelector from "./PlaybackSelector.vue";
import SettingsSection from "./SettingsSection.vue";
import SourceSwitcher from "./SourceSwitcher.vue";
import TopSearchBar from "./TopSearchBar.vue";
import { displaySource } from "./safe-display.js";
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

const view = ref<"browse" | "settings">("browse");
const theme = ref<"system" | "light" | "dark">("light");
const systemTheme = ref<"light" | "dark">("light");
let systemMediaQuery: MediaQueryList | null = null;

const resolvedTheme = computed(() => theme.value === "system" ? systemTheme.value : theme.value);

function syncSystemTheme(event?: MediaQueryList | MediaQueryListEvent): void {
  systemTheme.value = event?.matches ? "dark" : "light";
}

onMounted(() => {
  if (typeof window.matchMedia !== "function") return;
  systemMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  syncSystemTheme(systemMediaQuery);
  systemMediaQuery.addEventListener?.("change", syncSystemTheme);
});

onBeforeUnmount(() => {
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
const activePage = computed(() => view.value === "settings" ? "settings" : props.state.browse.page);
const retryable = computed(() => props.state.error.error?.code.startsWith("PLAYBACK_") === true);
const hasPlayback = computed(() => props.state.detail.playbackCatalog !== null || props.state.playback.player.source !== null);

function navigate(route: "home" | "category" | "settings"): void {
  if (route === "settings") {
    view.value = "settings";
    return;
  }
  view.value = "browse";
  if (route === "home") emit("home");
  else emit("category");
}

function submitSearch(query: string): void {
  view.value = "browse";
  emit("search", query);
}

function selectCategory(key: "home" | "category"): void {
  navigate(key);
}

function playFirstEpisode(): void {
  const line = selectedLine.value;
  const episode = line?.episodes[0];
  if (line && episode) emit("play", line.index, episode.index);
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
        @search="submitSearch"
      />

      <div class="workspace-content">
        <header class="workspace-header">
          <div>
            <span class="section-kicker">{{ view === "settings" ? "工作区设置" : "媒体工作台" }}</span>
            <h1>{{ view === "settings" ? "设置" : (props.state.spider.api ? displaySource(props.state.spider.api) : "QX 影视") }}</h1>
            <p data-testid="status" class="workspace-status" :class="{ loading: props.state.browse.loading || props.pending !== null }">
              {{ statusLabels[props.state.spider.status] }}{{ props.state.browse.loading || props.pending !== null ? " · 加载中" : "" }}
            </p>
          </div>
          <div class="workspace-header-meta">
            <span class="status-chip" :data-status="props.state.spider.status">{{ props.state.spider.sidecarRunning ? "连接正常" : "未启动" }}</span>
          </div>
        </header>

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
            <DiagnosticPanel :source="props.state.spider.source" :player-status="props.state.playback.player.status" :code="props.state.error.error?.code" />
          </SettingsSection>
          <SettingsSection title="隐私" description="凭据、Cookie、完整播放地址和本机路径不在界面回显。">
            <div class="settings-row"><span>renderer 数据边界</span><strong>仅 typed IPC</strong></div>
          </SettingsSection>
        </template>

        <template v-else>
          <CategoryTabs :active="props.state.browse.page" @select="selectCategory" />
          <FilterPanel @clear="emit('home')" />

          <div v-if="props.state.error.error" data-testid="error">
            <ErrorState
              :error="props.state.error.error"
              :pending="props.pending !== null"
              @retry="emit('retry')"
              @switch-line="emit('switch')"
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
            @close="emit('home')"
            @play="playFirstEpisode"
          />

          <section v-if="hasPlayback" class="playback-stage" data-testid="playback-stage">
            <PlaybackSelector
              v-if="props.state.detail.playbackCatalog"
              :catalog="props.state.detail.playbackCatalog"
              :selection="props.state.detail.playbackSelection"
              :order="props.order"
              :retryable="retryable"
              @line="emit('line', $event)"
              @order="emit('order', $event)"
              @episode="emit('play', $event[0], $event[1])"
              @retry="emit('retry')"
            />
            <EmbeddedPlayer :state="props.state.playback.player" />
            <DiagnosticPanel :source="props.state.spider.source" :player-status="props.state.playback.player.status" :code="props.state.error.error?.code" />
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
