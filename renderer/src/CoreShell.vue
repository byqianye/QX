<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, toRef, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import AppSidebar from "./AppSidebar.vue";
import TopSearchBar from "./TopSearchBar.vue";
import SpiderView from "./SpiderView.vue";
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

defineOptions({ inheritAttrs: false });

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
  detail: [vodId: string, siteKey?: string];
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
  historyOpen: [identity: string];
  historyDelete: [identity: string];
  historyDeleteProgress: [identity: string];
  historyClear: [identities: string[]];
  historyPause: [paused: boolean];
  favoriteOpen: [favoriteId: string];
  favoriteDelete: [favoriteId: string];
  favoriteMove: [payload: { favoriteId: string; groupId: string }];
  favoriteReorder: [payload: { groupId: string; favoriteIds: string[] }];
  favoriteCreateGroup: [name: string];
  favoriteRenameGroup: [payload: { groupId: string; name: string }];
  favoriteDeleteGroup: [payload: { groupId: string; disposition?: "default" | "delete" }];
  favoriteReorderGroups: [groupIds: string[]];
  followToggle: [];
  followAndFavorite: [];
  followRefresh: [];
  followOpen: [identity: string];
  followDelete: [identity: string];
  followMarkWatched: [identity: string];
  followMarkUnwatched: [identity: string];
  localOpenFile: [];
  localAddFolder: [];
  localRescan: [rootId?: string];
  localCancelScan: [rootId?: string];
  localRemoveFolder: [rootId: string];
  localRemoveItem: [itemId: string];
  localRemoveHistory: [identity: string];
  localLocate: [itemId: string];
  localPlay: [itemId: string, resumeMode?: "continue" | "beginning"];
  localDrop: [paths: string[]];
  localPlayerDetach: [];
  localPlayerStop: [];
  localPlayerSync: [value: PlayerMediaSync];
  downloadSelectFolder: [];
  downloadAdd: [payload: { title: string; url: string; filename: string; targetDirectoryId: string }];
  downloadRefresh: [];
  downloadPause: [taskId: string];
  downloadResume: [taskId: string];
  downloadCancel: [taskId: string];
  downloadRetry: [taskId: string];
  downloadRemove: [taskId: string];
  downloadOpenFolder: [targetDirectoryId: string];
}>();

const route = useRoute();
const router = useRouter();
const state = toRef(props, "state");
const pending = toRef(props, "pending");
const lineIndex = toRef(props, "lineIndex");
const order = toRef(props, "order");
const theme = ref<RendererThemeMode>(props.initialTheme ?? "dark");
const sidebarCollapsed = ref(false);
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
    importStatus: state.value.import.status,
    errorSource: state.value.error.error?.source,
  });
});
const categoryAvailable = computed(() => state.value.spider.capabilities?.category ?? null);
const searchAvailable = computed(() => state.value.import.sites.length > 1 ? true : state.value.spider.capabilities?.search ?? null);
const localAvailable = computed(() => state.value.localMedia.ready);
const retryable = computed(() => state.value.error.error?.retryable === true);
const navigationBlocked = computed(() => false);
const canSearchPlayback = computed(() => {
  const catalog = state.value.detail.playbackCatalog;
  return !state.value.detail.canPlay && (!catalog || !catalog.lines.some((line) => line.episodes.length > 0));
});
const routeName = computed(() => String(route.name ?? "home"));
const isLegacyRoute = computed(() => routeName.value === "legacy-downloads" || routeName.value === "legacy-local" || routeName.value === "legacy-settings");
const legacyNavigation = computed<RendererNavigation>(() => routeName.value === "legacy-downloads"
  ? "downloads"
  : routeName.value === "legacy-local" ? "local" : "settings");
const canGoBack = computed(() => {
  if (routeName.value === "home" || routeName.value === "onboarding") return false;
  return window.history.state?.back != null || routeName.value !== "home";
});
const activeSidebarPage = computed(() => {
  if (isLegacyRoute.value) return legacyNavigation.value;
  if (["search", "media", "watch"].includes(routeName.value)) return "home";
  return ["home", "category", "sources", "history", "favorites", "follow"].includes(routeName.value) ? routeName.value : "";
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
  } else if (routeValue === "history" || routeValue === "favorites") {
    patch.navigation = routeValue;
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
  else if (name === "follow") emit("followRefresh");
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

async function openDetail(vodId: string, siteKey?: string): Promise<void> {
  const id = vodId.trim();
  if (!id) return;
  const location = { name: "media", params: { mediaId: id }, ...(siteKey ? { query: { source: siteKey } } : {}) };
  routeKeyToSkip.value = router.resolve(location).fullPath;
  await router.push(location);
  persistRoute("media");
  if (siteKey) emit("detail", id, siteKey);
  else emit("detail", id);
}

function back(): void {
  if (!canGoBack.value) return;
  if (window.history.state?.back != null) {
    router.back();
    return;
  }
  if (routeName.value === "watch") {
    const mediaId = String(route.params.mediaId ?? "").trim();
    if (mediaId) {
      void router.replace({ name: "media", params: { mediaId } });
      return;
    }
  }
  if (routeName.value === "sources") {
    const returnTo = route.query.returnTo === "watch" || route.query.returnTo === "media"
      ? route.query.returnTo
      : null;
    const mediaId = String(route.query.mediaId ?? "").trim();
    if (returnTo === "watch" && mediaId) {
      void router.replace({ name: "watch", params: { mediaId } });
      return;
    }
    if (returnTo === "media" && mediaId) {
      void router.replace({ name: "media", params: { mediaId } });
      return;
    }
  }
  void router.replace({ name: "home" });
}

function switchSource(): void {
  emit("switch");
}

function openSources(): void {
  const playbackRoute = routeName.value === "watch" || routeName.value === "media";
  const mediaId = playbackRoute ? String(route.params.mediaId ?? "").trim() : "";
  const query = playbackRoute && mediaId
    ? { returnTo: routeName.value, mediaId }
    : {};
  const location = { name: "sources" as const, ...(Object.keys(query).length > 0 ? { query } : {}) };
  routeKeyToSkip.value = router.resolve(location).fullPath;
  void router.push(location);
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
  if (value === "history" || value === "favorites") {
    void pushRoute(value);
    return;
  }
  if (value === "follow") {
    void navigate("follow");
    return;
  }
  if (["downloads", "local", "settings"].includes(value)) {
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
    const siteKey = typeof route.query.source === "string" ? route.query.source : "";
    if (mediaId && (currentId !== mediaId || (siteKey && state.value.import.selectedSiteKey !== siteKey))) {
      if (siteKey) emit("detail", mediaId, siteKey); else emit("detail", mediaId);
    }
  } else if (name === "follow") {
    emit("followRefresh");
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
  openSources,
  switchSource,
  selectSource: (siteKey) => emit("selectSource", siteKey),
  favoriteToggle: () => emit("favoriteToggle"),
  favoriteMove: (groupId) => emit("favoriteMoveDetail", groupId),
  historyOpen: (identity) => emit("historyOpen", identity),
  historyDelete: (identity) => emit("historyDelete", identity),
  historyDeleteProgress: (identity) => emit("historyDeleteProgress", identity),
  historyClear: (identities) => emit("historyClear", identities),
  historyPause: (paused) => emit("historyPause", paused),
  favoriteOpen: (favoriteId) => emit("favoriteOpen", favoriteId),
  favoriteDelete: (favoriteId) => emit("favoriteDelete", favoriteId),
  favoriteMoveItem: (payload) => emit("favoriteMove", payload),
  favoriteReorder: (payload) => emit("favoriteReorder", payload),
  favoriteCreateGroup: (name) => emit("favoriteCreateGroup", name),
  favoriteRenameGroup: (payload) => emit("favoriteRenameGroup", payload),
  favoriteDeleteGroup: (payload) => emit("favoriteDeleteGroup", payload),
  favoriteReorderGroups: (groupIds) => emit("favoriteReorderGroups", groupIds),
  followToggle: () => emit("followToggle"),
  followAndFavorite: () => emit("followAndFavorite"),
  followRefresh: () => emit("followRefresh"),
  followOpen: (identity) => emit("followOpen", identity),
  followDelete: (identity) => emit("followDelete", identity),
  followMarkWatched: (identity) => emit("followMarkWatched", identity),
  followMarkUnwatched: (identity) => emit("followMarkUnwatched", identity),
});

const legacyListeners = {
  open: () => emit("open"),
  home: () => emit("home"),
  category: () => emit("category"),
  search: (key: string) => emit("search", key),
  detail: (vodId: string) => emit("detail", vodId),
  findPlaybackSource: () => emit("findPlaybackSource"),
  selectPlaybackSource: (siteKey: string, vodId: string) => emit("selectPlaybackSource", siteKey, vodId),
  play: (line: number, episode: number, resumeMode?: HistoryResumeMode) => emit("play", line, episode, resumeMode),
  retry: () => emit("retry"),
  line: (index: number) => emit("line", index),
  order: (value: "forward" | "reverse") => emit("order", value),
  switch: () => emit("switch"),
  close: () => emit("close"),
  viewState: (patch: RendererViewStatePatch) => emit("viewState", patch),
  playerDetach: () => emit("playerDetach"),
  playerAttach: () => emit("playerAttach"),
  playerStop: () => emit("playerStop"),
  playerSync: (value: PlayerMediaSync) => emit("playerSync", value),
  fallbackCancel: () => emit("fallbackCancel"),
  fallbackApprove: () => emit("fallbackApprove"),
  fallbackMode: (value: "off" | "prompt" | "auto") => emit("fallbackMode", value),
  historyOpen: (identity: string) => emit("historyOpen", identity),
  historyDelete: (identity: string) => emit("historyDelete", identity),
  historyDeleteProgress: (identity: string) => emit("historyDeleteProgress", identity),
  historyClear: (identities: string[]) => emit("historyClear", identities),
  historyPause: (paused: boolean) => emit("historyPause", paused),
  favoriteToggle: () => emit("favoriteToggle"),
  favoriteMoveDetail: (groupId: string) => emit("favoriteMoveDetail", groupId),
  favoriteOpen: (favoriteId: string) => emit("favoriteOpen", favoriteId),
  favoriteDelete: (favoriteId: string) => emit("favoriteDelete", favoriteId),
  favoriteMove: (payload: { favoriteId: string; groupId: string }) => emit("favoriteMove", payload),
  favoriteReorder: (payload: { groupId: string; favoriteIds: string[] }) => emit("favoriteReorder", payload),
  favoriteCreateGroup: (name: string) => emit("favoriteCreateGroup", name),
  favoriteRenameGroup: (payload: { groupId: string; name: string }) => emit("favoriteRenameGroup", payload),
  favoriteDeleteGroup: (payload: { groupId: string; disposition?: "default" | "delete" }) => emit("favoriteDeleteGroup", payload),
  favoriteReorderGroups: (groupIds: string[]) => emit("favoriteReorderGroups", groupIds),
  followRefresh: () => emit("followRefresh"),
  followOpen: (identity: string) => emit("followOpen", identity),
  followDelete: (identity: string) => emit("followDelete", identity),
  followMarkWatched: (identity: string) => emit("followMarkWatched", identity),
  followMarkUnwatched: (identity: string) => emit("followMarkUnwatched", identity),
  followToggle: () => emit("followToggle"),
  followAndFavorite: () => emit("followAndFavorite"),
  localOpenFile: () => emit("localOpenFile"),
  localAddFolder: () => emit("localAddFolder"),
  localRescan: (rootId?: string) => emit("localRescan", rootId),
  localCancelScan: (rootId?: string) => emit("localCancelScan", rootId),
  localRemoveFolder: (rootId: string) => emit("localRemoveFolder", rootId),
  localRemoveItem: (itemId: string) => emit("localRemoveItem", itemId),
  localRemoveHistory: (identity: string) => emit("localRemoveHistory", identity),
  localLocate: (itemId: string) => emit("localLocate", itemId),
  localPlay: (itemId: string, resumeMode?: "continue" | "beginning") => emit("localPlay", itemId, resumeMode),
  localDrop: (paths: string[]) => emit("localDrop", paths),
  localPlayerDetach: () => emit("localPlayerDetach"),
  localPlayerStop: () => emit("localPlayerStop"),
  localPlayerSync: (value: PlayerMediaSync) => emit("localPlayerSync", value),
  downloadSelectFolder: () => emit("downloadSelectFolder"),
  downloadAdd: (payload: { title: string; url: string; filename: string; targetDirectoryId: string }) => emit("downloadAdd", payload),
  downloadRefresh: () => emit("downloadRefresh"),
  downloadPause: (taskId: string) => emit("downloadPause", taskId),
  downloadResume: (taskId: string) => emit("downloadResume", taskId),
  downloadCancel: (taskId: string) => emit("downloadCancel", taskId),
  downloadRetry: (taskId: string) => emit("downloadRetry", taskId),
  downloadRemove: (taskId: string) => emit("downloadRemove", taskId),
  downloadOpenFolder: (targetDirectoryId: string) => emit("downloadOpenFolder", targetDirectoryId),
};
</script>

<template>
  <main class="app-shell core-app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }" :data-theme="resolvedTheme" data-testid="core-app-shell" :data-route="routeName" :data-selected-site-key="state.import.selectedSiteKey" :data-source-count="state.import.sites.length">
    <AppSidebar
      :active-page="activeSidebarPage"
      :source="state.spider.source"
      :source-name="sourceName"
      :source-count="state.import.sites.length"
      :status="sourceStatus"
      :category-available="categoryAvailable"
      :local-available="localAvailable"
      :pending="navigationBlocked"
      :theme="theme"
      :follow-updates="state.follow.updateCount"
      :collapsed="sidebarCollapsed"
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
        :pending="navigationBlocked"
        :initial-query="typeof route.query.q === 'string' ? route.query.q : initialSearchQuery"
        :search-available="searchAvailable"
        :can-back="canGoBack"
        :sidebar-collapsed="sidebarCollapsed"
        @search="search"
        @back="back"
        @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      />

      <div class="workspace-content core-workspace-content">
        <RouterView v-if="!isLegacyRoute" />
        <SpiderView
          v-else
          :key="route.fullPath"
          :state="state"
          :pending="pending"
          :line-index="lineIndex"
          :order="order"
          :initial-navigation="legacyNavigation"
          :initial-theme="theme"
          :initial-search-query="typeof route.query.q === 'string' ? route.query.q : initialSearchQuery"
          :persistence-diagnostic="persistenceDiagnostic"
          :embedded="true"
          v-on="{ ...$attrs, ...legacyListeners }"
        />
      </div>
    </section>
  </main>
</template>
