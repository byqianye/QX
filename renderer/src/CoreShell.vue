<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, toRef, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import AppSidebar from "./AppSidebar.vue";
import SourceSwitcher from "./SourceSwitcher.vue";
import TopSearchBar from "./TopSearchBar.vue";
import { CORE_ROUTE_CONTEXT_KEY } from "./core-route-context.js";
import type { CoreRouteName } from "./router.js";
import { sourceDisplayStatus } from "./source-status.js";
import type {
  HistoryResumeMode,
  PlayerMediaSync,
  RendererNavigation,
  RendererState,
  RendererThemeMode,
  RendererViewStatePatch,
} from "./state.js";

const props = defineProps<{
  state: RendererState;
  pending: string | null;
  lineIndex: number;
  order: "forward" | "reverse";
  initialTheme?: RendererThemeMode;
  initialSearchQuery?: string;
  persistenceDiagnostic?: { code: string; message: string } | null;
}>();

const emit = defineEmits<{
  open: [];
  home: [];
  category: [typeId?: string, filters?: Record<string, string>];
  search: [key: string];
  detail: [vodId: string];
  findPlaybackSource: [];
  selectPlaybackSource: [siteKey: string, vodId: string];
  play: [lineIndex: number, episodeIndex: number, resumeMode?: HistoryResumeMode];
  retry: [];
  line: [index: number];
  order: [order: "forward" | "reverse"];
  switch: [];
  selectSource: [siteKey: string];
  close: [];
  viewState: [patch: RendererViewStatePatch];
  playerDetach: [];
  playerAttach: [];
  playerStop: [];
  playerSync: [value: PlayerMediaSync];
  fallbackCancel: [];
  fallbackApprove: [];
  fallbackMode: [value: "off" | "prompt" | "auto"];
  favoriteToggle: [];
  favoriteMoveDetail: [groupId: string];
  followToggle: [];
  followAndFavorite: [];
}>();

const route = useRoute();
const router = useRouter();
const state = toRef(props, "state");
const pending = toRef(props, "pending");
const lineIndex = toRef(props, "lineIndex");
const order = toRef(props, "order");
const theme = ref<RendererThemeMode>(props.initialTheme ?? "light");
const systemTheme = ref<"light" | "dark">("light");
const routeKeyToSkip = ref<string | null>(null);
const loadedSearchQuery = ref("");
let systemMediaQuery: MediaQueryList | null = null;

const resolvedTheme = computed<"light" | "dark">(() => theme.value === "system" ? systemTheme.value : theme.value);
const sourceName = computed(() => {
  const selected = state.value.import.sites.find((site) => site.key === state.value.import.selectedSiteKey);
  return selected?.name?.trim() || (state.value.import.selectedSiteKey ? "当前来源" : "未选择来源");
});
const sourceStatus = computed(() => {
  return sourceDisplayStatus({
    sessionReady: state.value.import.sessionReady,
    spiderStatus: state.value.spider.status,
    errorSource: state.value.error.error?.source,
  });
});
const categoryAvailable = computed(() => state.value.spider.capabilities?.category ?? null);
const searchAvailable = computed(() => state.value.spider.capabilities?.search ?? null);
const localAvailable = computed(() => state.value.localMedia.ready);
const retryable = computed(() => state.value.error.error?.retryable === true);
const canSearchPlayback = computed(() => {
  const catalog = state.value.detail.playbackCatalog;
  return !state.value.detail.canPlay && (!catalog || !catalog.lines.some((line) => line.episodes.length > 0));
});
const routeName = computed(() => String(route.name ?? "home"));
const canGoBack = computed(() => window.history.state?.back != null);
const canGoForward = computed(() => window.history.state?.forward != null);
const pageTitle = computed(() => ({
  home: "首页",
  category: "分类浏览",
  search: "搜索结果",
  media: "媒体详情",
  watch: "播放",
  sources: "来源切换",
}[routeName.value] ?? "媒体工作台"));
const activeSidebarPage = computed(() => routeName.value === "category" ? "category" : routeName.value === "home" ? "home" : routeName.value === "sources" ? "sources" : "");
const statusLabel = computed(() => {
  if (pending.value !== null || state.value.browse.loading) return "正在读取内容";
  if (sourceStatus.value === "error") return "来源暂不可用";
  if (state.value.import.sessionReady) return "来源已就绪";
  if (state.value.spider.status === "error") return "来源暂不可用";
  if (state.value.spider.status === "initializing") return "正在准备来源";
  return "等待来源";
});

function syncSystemTheme(event?: MediaQueryList | MediaQueryListEvent): void {
  systemTheme.value = event?.matches ? "dark" : "light";
}

function persistRoute(routeValue: CoreRouteName): void {
  const patch: RendererViewStatePatch = {};
  if (routeValue === "home") patch.navigation = "home";
  else if (routeValue === "category") {
    patch.navigation = "category";
    const typeId = typeof route.query.type === "string" ? route.query.type.trim() : "";
    if (typeId) patch.category = { typeId, page: 1, filters: routeFilters() };
  }
  else if (routeValue === "search") {
    patch.navigation = "search";
    const query = typeof route.query.q === "string" ? route.query.q : "";
    if (query) patch.search = { key: query, page: 1 };
  } else if (routeValue === "media" || routeValue === "watch") {
    patch.navigation = "detail";
    const mediaId = String(route.params.mediaId ?? "");
    if (mediaId) patch.recentDetailId = mediaId;
  }
  if (Object.keys(patch).length > 0) emit("viewState", patch);
}

function routeFilters(): Record<string, string> {
  if (typeof route.query.filter !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(route.query.filter);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => key.trim().length > 0 && typeof value === "string" && value.trim().length > 0)
        .map(([key, value]) => [key.trim(), value.trim()]),
    );
  } catch {
    return {};
  }
}

function routeLocation(name: CoreRouteName, value?: string): { name: CoreRouteName; params?: Record<string, string>; query?: Record<string, string> } {
  if (name === "media" || name === "watch") return { name, params: { mediaId: value ?? "" } };
  if (name === "search") return { name, query: value ? { q: value } : {} };
  return { name };
}

async function pushRoute(name: CoreRouteName, value?: string): Promise<void> {
  const location = routeLocation(name, value);
  routeKeyToSkip.value = router.resolve(location).fullPath;
  await router.push(location);
  persistRoute(name);
}

async function navigate(name: CoreRouteName): Promise<void> {
  await pushRoute(name);
  if (name === "home") emit("home");
  else if (name === "category") emit("category");
}

async function selectCategory(typeId: string, filters: Record<string, string> = {}): Promise<void> {
  const value = typeId.trim();
  if (!value || categoryAvailable.value === false) return;
  const filterValue = Object.fromEntries(Object.entries(filters).filter(([, item]) => item.trim()));
  const query = {
    type: value,
    ...(Object.keys(filterValue).length > 0 ? { filter: JSON.stringify(filterValue) } : {}),
  };
  const location = { name: "category" as const, query };
  routeKeyToSkip.value = router.resolve(location).fullPath;
  await router.push(location);
  persistRoute("category");
  emit("category", value, filterValue);
}

async function search(query: string): Promise<void> {
  const value = query.trim();
  if (!value) {
    await navigate("home");
    return;
  }
  await pushRoute("search", value);
  if (searchAvailable.value === false) return;
  loadedSearchQuery.value = value;
  emit("search", value);
}

async function openDetail(vodId: string): Promise<void> {
  const id = vodId.trim();
  if (!id) return;
  await pushRoute("media", id);
  emit("detail", id);
}

function back(): void {
  if (window.history.length > 1) router.back();
  else void navigate("home");
}

function forward(): void {
  if (canGoForward.value) router.forward();
}

function switchSource(): void {
  emit("switch");
  void pushRoute("home");
}

function openSources(): void {
  void pushRoute("sources");
}

function navigateFromSidebar(value: string): void {
  if (value === "home" || value === "category") {
    void navigate(value);
    return;
  }
  if (value === "sources") {
    openSources();
    return;
  }
  if (["history", "favorites", "follow", "downloads", "live", "local", "settings"].includes(value)) {
    void router.push({ name: `legacy-${value}` });
  }
}

async function activateRoute(): Promise<void> {
  const name = routeName.value;
  if (routeKeyToSkip.value === route.fullPath) {
    routeKeyToSkip.value = null;
    return;
  }
  if (name === "home") {
    if (state.value.browse.page !== "home") emit("home");
  } else if (name === "category") {
    if (categoryAvailable.value !== false) {
      const typeId = typeof route.query.type === "string" ? route.query.type.trim() : "";
      let filters: Record<string, string> = {};
      if (typeof route.query.filter === "string") {
        try {
          const parsed: unknown = JSON.parse(route.query.filter);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            filters = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string"));
          }
        } catch {
          filters = {};
        }
      }
      emit("category", typeId || undefined, filters);
    }
  } else if (name === "search") {
    if (searchAvailable.value === false) return;
    const query = typeof route.query.q === "string" ? route.query.q.trim() : "";
    if (query && state.value.browse.page === "search" && loadedSearchQuery.value === "") {
      loadedSearchQuery.value = query;
    } else if (query && (state.value.browse.page !== "search" || loadedSearchQuery.value !== query)) {
      loadedSearchQuery.value = query;
      emit("search", query);
    }
  } else if (name === "media" || name === "watch") {
    const mediaId = String(route.params.mediaId ?? "");
    const currentId = String(state.value.detail.detail?.vod_id ?? state.value.detail.detail?.id ?? "");
    if (mediaId && currentId !== mediaId) emit("detail", mediaId);
  }
}

watch(() => route.fullPath, () => { void activateRoute(); }, { immediate: true });
watch(theme, (value) => emit("viewState", { theme: value }));
watch(() => state.value.import.selectedSiteKey, (value) => {
  if (value) emit("viewState", { siteKey: value });
});

onMounted(() => {
  if (typeof window.matchMedia === "function") {
    systemMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    syncSystemTheme(systemMediaQuery);
    systemMediaQuery.addEventListener?.("change", syncSystemTheme);
  }
});

onBeforeUnmount(() => {
  systemMediaQuery?.removeEventListener?.("change", syncSystemTheme);
  systemMediaQuery = null;
});

provide(CORE_ROUTE_CONTEXT_KEY, {
  state,
  pending,
  lineIndex,
  order,
  theme,
  resolvedTheme,
  sourceName,
  retryable,
  canSearchPlayback,
  navigate,
  back,
  search,
  selectCategory,
  openDetail,
  play: (line, episode, resumeMode) => emit("play", line, episode, resumeMode),
  retry: () => emit("retry"),
  findPlaybackSource: () => emit("findPlaybackSource"),
  selectPlaybackSource: (siteKey, vodId) => emit("selectPlaybackSource", siteKey, vodId),
  setLine: (value) => emit("line", value),
  setOrder: (value) => emit("order", value),
  playerDetach: () => emit("playerDetach"),
  playerAttach: () => emit("playerAttach"),
  playerStop: () => emit("playerStop"),
  playerSync: (value) => emit("playerSync", value),
  fallbackCancel: () => emit("fallbackCancel"),
  fallbackApprove: () => emit("fallbackApprove"),
  fallbackMode: (value) => emit("fallbackMode", value),
  switchSource,
  selectSource: (siteKey) => emit("selectSource", siteKey),
  favoriteToggle: () => emit("favoriteToggle"),
  favoriteMove: (groupId) => emit("favoriteMoveDetail", groupId),
  followToggle: () => emit("followToggle"),
  followAndFavorite: () => emit("followAndFavorite"),
});
</script>

<template>
  <main class="app-shell core-app-shell" :data-theme="resolvedTheme" data-testid="core-app-shell" :data-route="routeName">
    <AppSidebar
      :active-page="activeSidebarPage"
      :source="state.spider.source"
      :source-name="sourceName"
      :source-count="state.import.sites.length"
      :status="sourceStatus"
      :category-available="categoryAvailable"
      :local-available="localAvailable"
      :pending="pending !== null"
      :theme="theme"
      :follow-updates="state.follow.updateCount"
      @navigate="navigateFromSidebar"
      @open="emit('open')"
      @switch="openSources"
      @close="emit('close')"
      @theme="theme = $event"
    />

    <section class="workspace">
      <TopSearchBar
        :source="state.spider.source"
        :source-name="sourceName"
        :api="state.spider.api"
        :pending="pending !== null"
        :initial-query="initialSearchQuery"
        :search-available="searchAvailable"
        :can-back="canGoBack"
        :can-forward="canGoForward"
        @search="search"
        @back="back"
        @forward="forward"
      />

      <div class="workspace-content core-workspace-content">
        <header class="workspace-header">
          <div>
            <span class="section-kicker">QX 影视 V3</span>
            <h1>{{ pageTitle }}</h1>
            <p class="workspace-status" :class="{ loading: pending !== null || state.browse.loading }">{{ statusLabel }}</p>
          </div>
          <div class="workspace-header-meta"><span class="status-chip" :data-status="sourceStatus">{{ sourceStatus === "ready" ? "来源已连接" : sourceStatus === "error" ? "来源暂不可用" : "未检测" }}</span></div>
        </header>

        <SourceSwitcher
          v-if="routeName !== 'sources'"
          :source="state.spider.source"
          :source-name="sourceName"
          :api="state.spider.api"
          :source-count="state.import.sites.length"
          :status="sourceStatus"
          :pending="pending !== null"
          @change="openSources"
        />

        <RouterView />
      </div>
    </section>
  </main>
</template>
