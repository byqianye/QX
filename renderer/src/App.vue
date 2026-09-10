<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { RendererApi } from "./api.js";
import ConfigImportView from "./ConfigImportView.vue";
import CoreShell from "./CoreShell.vue";
import { toAppError } from "./error.js";
import LaunchSplash from "./LaunchSplash.vue";
import PlayerWindow from "./PlayerWindow.vue";
import WindowTitlebar from "./WindowTitlebar.vue";
import { isCoreRouteName, router, ROUTER_ENABLED_KEY } from "./router.js";
import SpiderView from "./SpiderView.vue";
import { isTauriRuntime } from "./tauri-rpc.js";
import {
  applyRendererEnvelope,
  createRendererState,
  type AppErrorSource,
  type RendererPersistenceState,
  type RendererEnvelope,
  type RendererState,
  type PlayerMediaSync,
  type RendererViewStatePatch,
  type HistoryResumeMode,
} from "./state.js";
import { configuredTestPresetUrl, testPresetAutoConfirmEnabled, testPresetAutoLoadEnabled } from "./test-preset.js";
import { DEFAULT_SOURCE_URL, shouldLoadDefaultSource } from "./default-source.js";
import { isRequestCancelled, type RendererRequestOptions } from "./request-task.js";

const api = new RendererApi();
const state = ref<RendererState>(createRendererState());
const pendingOperations = ref<Record<string, string>>({});
const pending = computed(() => Object.values(pendingOperations.value).at(-1) ?? null);
const operationControllers = new Map<string, AbortController>();
const lineIndex = ref(0);
const order = ref<"forward" | "reverse">("forward");
const persistence = ref<RendererPersistenceState | null>(null);
const restored = ref(false);
const restoreCompleted = ref(false);
const routerEnabled = inject(ROUTER_ENABLED_KEY, false);
const isPlayerWindow = new URL(window.location.href).searchParams.get("player-window") === "1";
const initialRouteIntent = ref<string | null>(captureInitialRouteIntent());
const rendererTheme = computed<"light" | "dark">(() => persistence.value?.theme === "light" ? "light" : persistence.value?.theme === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let playerSyncTimer: ReturnType<typeof setTimeout> | undefined;
let playerSyncInterval: ReturnType<typeof setInterval> | undefined;
let latestPlayerSync: PlayerMediaSync | null = null;
let playerSyncSequence = 0;
let requestRevision = 0;
let activePlayKey: string | null = null;
let retryAction: { operation: string; call: (options: RendererRequestOptions) => Promise<RendererEnvelope> } | null = null;
let scrollContainer: HTMLElement | null = null;
let testPresetRequested = false;
let testPresetConfirmed = false;
let defaultSourceRequested = false;
let defaultSourceConfirmed = false;
let playerWindowEventUnlisten: (() => void) | null = null;
let playerWindowEventDisposed = false;

const testPresetUrl = configuredTestPresetUrl();
const testPresetEnabled = testPresetAutoLoadEnabled();
const testPresetAutoConfirm = testPresetAutoConfirmEnabled();

const showImport = computed(() => state.value.import.status !== "ready"
  || (!state.value.import.sessionReady && !state.value.import.trusted));
const isCoreRoute = computed(() => routerEnabled && isCoreRouteName(router.currentRoute.value.name));
const legacyInitialNavigation = computed<RendererPersistenceState["navigation"]>(() => {
  const name = String(router.currentRoute.value.name ?? "");
  const legacy = name.startsWith("legacy-") ? name.slice("legacy-".length) : "";
  return (legacy === "history" || legacy === "favorites" || legacy === "follow" || legacy === "settings" || legacy === "local" || legacy === "downloads")
    ? legacy
    : persistence.value?.navigation ?? "home";
});

onMounted(() => {
  if (isPlayerWindow) return;
  window.addEventListener("qx-player-attached", refreshAfterPlayerWindow);
  if (isTauriRuntime()) {
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const stops = await Promise.all([listen("qx-player-attached", refreshAfterPlayerWindow), listen("qx-player-stopped", () => post("player-stop", "/api/player/stop"))]);
        return () => stops.forEach(stop => stop());
      })
      .then((unlisten) => {
        if (playerWindowEventDisposed) unlisten();
        else playerWindowEventUnlisten = unlisten;
      })
      .catch(() => undefined);
  }
  document.addEventListener("scroll", handleScroll, { passive: true, capture: true });
  playerSyncInterval = setInterval(() => {
    if (latestPlayerSync) void flushPlayerSync();
  }, 5_000);
  void nextTick(bindScrollContainer);
  void request("state", options => api.getState(options));
});

watch(() => [state.value.ready, state.value.import.status] as const, ([ready, importStatus]) => {
  if (!ready || importStatus !== "empty" || !testPresetEnabled || testPresetRequested || isPlayerWindow) return;
  testPresetRequested = true;
  post("test-import", "/api/import/load", { input: testPresetUrl, bootstrapDefault: true });
}, { immediate: true });

watch(() => [state.value.ready, state.value.import.status] as const, ([ready, status]) => {
  if (testPresetEnabled) return;
  if (shouldLoadDefaultSource({
    desktop: !isPlayerWindow, ready, status,
    savedSource: persistence.value?.configSource,
    persistenceError: Boolean(persistence.value?.diagnostic),
    requested: defaultSourceRequested, playerWindow: isPlayerWindow,
  })) {
    defaultSourceRequested = true;
    post("default-import", "/api/import/load", { input: DEFAULT_SOURCE_URL, bootstrapDefault: true });
  }
  // Only this explicitly configured initial import is auto-selected. A manual
  // replacement or restored configuration keeps the existing confirmation flow.
  if (ready && status === "confirmation_required" && defaultSourceRequested && !defaultSourceConfirmed
    && state.value.import.source === DEFAULT_SOURCE_URL) {
    defaultSourceConfirmed = true;
    post("default-confirm", "/api/import/confirm");
  }
}, { immediate: true });

watch(() => [state.value.ready, state.value.import.status] as const, ([ready, importStatus]) => {
  if (!ready || importStatus !== "confirmation_required" || !testPresetAutoConfirm || testPresetConfirmed || isPlayerWindow) return;
  testPresetConfirmed = true;
  post("test-confirm", "/api/import/confirm");
}, { immediate: true });

watch([showImport, restoreCompleted], ([importVisible, isRestored]) => {
  void nextTick(bindScrollContainer);
  if (!routerEnabled || isPlayerWindow) return;
  if (importVisible) {
    if (router.currentRoute.value.name !== "onboarding") void router.replace({ name: "onboarding" });
    return;
  }
  if (!isRestored) return;
  if (initialRouteIntent.value) {
    const target = initialRouteIntent.value;
    initialRouteIntent.value = null;
    void router.replace(target);
    return;
  }
  syncRouteFromPersistence();
}, { immediate: true });

watch(() => router.currentRoute.value.fullPath, () => {
  if (!routerEnabled || isPlayerWindow) return;
  persistView({ scrollTop: currentScrollTop() });
  void nextTick(bindScrollContainer);
});

onBeforeUnmount(() => {
  for (const controller of operationControllers.values()) controller.abort();
  if (isPlayerWindow) return;
  const scrollTop = currentScrollTop();
  unbindScrollContainer();
  document.removeEventListener("scroll", handleScroll, true);
  window.removeEventListener("qx-player-attached", refreshAfterPlayerWindow);
  playerWindowEventDisposed = true;
  playerWindowEventUnlisten?.();
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  if (playerSyncInterval !== undefined) clearInterval(playerSyncInterval);
  persistView({ scrollTop });
  void flushPlayerSync();
});

interface RequestOptions {
  latest?: boolean;
}

async function request(
  operation: string,
  call: (options: RendererRequestOptions) => Promise<RendererEnvelope>,
  remember = true,
  options: RequestOptions = {},
): Promise<boolean> {
  requestRevision += 1;
  if (remember) retryAction = { operation, call };
  const lane = /player|play|fallback/u.test(operation) ? "playback" : /search/u.test(operation) ? "search" : /detail/u.test(operation) ? "detail" : "connection";
  for (const [key, controller] of operationControllers) {
    if (key === lane || (lane !== "playback" && key !== "playback" && !(lane === "detail" && key === "search"))) controller.abort();
  }
  const controller = new AbortController();
  operationControllers.set(lane, controller);
  pendingOperations.value = { ...pendingOperations.value, [lane]: operation };
  const clear = (): void => {
    if (operationControllers.get(lane) !== controller) return;
    operationControllers.delete(lane);
    const next = { ...pendingOperations.value };
    delete next[lane];
    pendingOperations.value = next;
  };
  controller.signal.addEventListener("abort", clear, { once: true });
  const current = () => !controller.signal.aborted && operationControllers.get(lane) === controller;
  const progress = (envelope: RendererEnvelope): void => {
    if (!current()) return;
    if (envelope.persistence) persistence.value = clonePersistence(envelope.persistence);
    state.value = applyRendererEnvelope(state.value, envelope);
    if (!restored.value && state.value.import.status === "ready" && state.value.import.trusted) {
      restored.value = true;
      restoreCompleted.value = true;
    }
  };
  const execute = async () => {
    try {
      const envelope = await call({ signal: controller.signal, onProgress: progress });
      if (!current()) return { success: false, restore: false };
      if (envelope.persistence) {
        persistence.value = clonePersistence(envelope.persistence);
      }
      state.value = applyRendererEnvelope(state.value, envelope);
      const selection = state.value.detail.playbackSelection;
      lineIndex.value = selection?.lineIndex ?? state.value.detail.playbackCatalog?.lines[0]?.index ?? 0;
      if (!restored.value && state.value.import.status === "ready"
        && (state.value.import.sessionReady || operation === "confirm" || state.value.import.trusted)) {
        if (operation === "confirm" && envelope.errorCode) {
          restored.value = true;
          restoreCompleted.value = true;
        } else {
          return { success: true, restore: true };
        }
      }
      return { success: true, restore: false };
    } catch (error) {
      if (!current() || isRequestCancelled(error)) return { success: false, restore: false };
      const appError = toAppError({
        code: error instanceof Error && error.message === "SOURCE_OPERATION_TIMEOUT" ? "SOURCE_OPERATION_TIMEOUT" : "RENDERER_REQUEST_ERROR",
        message: error instanceof Error ? error.message : String(error),
        safeDetails: { operation },
      }, sourceForOperation(operation));
      state.value = {
        ...state.value,
        ready: true,
        browse: { ...state.value.browse, loading: false },
        playback: /player|play/u.test(operation)
          ? {
              ...state.value.playback,
              player: {
                ...state.value.playback.player,
                status: "error",
                source: null,
                error: {
                  code: appError.code,
                  message: appError.message,
                },
              },
            }
          : state.value.playback,
        import: state.value.import.status === "ready"
          ? state.value.import
          : { ...state.value.import, error: appError },
        error: { error: appError },
      };
      return { success: false, restore: false };
    } finally {
      clear();
      controller.signal.removeEventListener("abort", clear);
    }
  };
  const result = await execute();
  if (result.restore) await restorePage();
  return result.success;
}

function post(operation: string, path: string, body: Record<string, unknown> = {}): void {
  void request(operation, options => api.post(path, body, options));
}

function cancelRequests(): void {
  for (const [lane, controller] of operationControllers) if (lane !== "playback") controller.abort();
  void api.post("/api/requests/cancel");
  const progress = state.value.browse.searchProgress;
  if (progress) state.value.browse.searchProgress = { ...progress, status: "cancelled", sources: progress.sources.map(source => ({ ...source, status: source.status === "running" || source.status === "queued" ? "cancelled" : source.status })) };
}

function syncRouteFromPersistence(): void {
  if (!routerEnabled || showImport.value) return;
  const currentName = router.currentRoute.value.name;
  if (currentName && currentName !== "home" && currentName !== "onboarding" && isCoreRouteName(currentName)) return;
  void router.replace({ name: "home" });
}

function captureInitialRouteIntent(): string | null {
  const current = router.currentRoute.value;
  return routerEnabled
    && isCoreRouteName(current.name)
    && current.name !== "home"
    && current.name !== "onboarding"
    ? current.fullPath
    : null;
}

function retryLast(): void {
  const action = retryAction;
  if (!action) return;
  void request(`retry-${action.operation}`, action.call, false);
}

function persistView(patch: RendererViewStatePatch): void {
  void api.post("/api/view-state", patch).then((envelope) => {
    if (envelope.persistence) persistence.value = clonePersistence(envelope.persistence);
  }).catch(() => undefined);
}

function syncPlayer(value: PlayerMediaSync): void {
  latestPlayerSync = value;
  if (playerSyncTimer !== undefined) clearTimeout(playerSyncTimer);
  const eventType = value.event?.type;
  if (value.status === "error" || value.status === "paused" || value.status === "ended" || eventType === "first-frame" || eventType === "startup-timeout" || eventType === "user-pause" || eventType === "completion") {
    playerSyncTimer = undefined;
    void flushPlayerSync();
    return;
  }
  playerSyncTimer = setTimeout(() => {
    playerSyncTimer = undefined;
    void flushPlayerSync();
  }, 750);
}

async function flushPlayerSync(): Promise<void> {
  if (playerSyncTimer !== undefined) {
    clearTimeout(playerSyncTimer);
    playerSyncTimer = undefined;
  }
  const value = latestPlayerSync;
  latestPlayerSync = null;
  if (!value) return;
  const sequence = ++playerSyncSequence;
  const revision = requestRevision;
  try {
    const envelope = await api.post("/api/player/sync", value);
    if (envelope.state && sequence === playerSyncSequence && revision === requestRevision) {
      const next = applyRendererEnvelope(state.value, envelope);
      // Progress replies must not replace a newer search result or page load.
      state.value = { ...state.value, playback: next.playback, detail: next.detail, danmaku: next.danmaku };
    }
  } catch {
    // Playback cleanup remains local if the host is closing.
  }
}

async function detachPlayer(): Promise<void> {
  await flushPlayerSync();
  await request("detach-player", () => api.post("/api/player/detach"));
  await nextTick();
  await flushPlayerSync();
  await request("open-player", () => api.post("/api/player/open"));
}

function attachPlayer(): void {
  post("attach-player", "/api/player/attach");
}

async function stopPlayer(): Promise<void> {
  await flushPlayerSync();
  await request("stop-player", () => api.post("/api/player/stop"));
}

function cancelFallback(): void {
  post("cancel-fallback", "/api/player/fallback/cancel");
}

function approveFallback(): void {
  post("approve-fallback", "/api/player/fallback/approve");
}

function setFallbackMode(mode: "off" | "prompt" | "auto"): void {
  post("fallback-mode", "/api/player/fallback/mode", { mode });
}

function refreshAfterPlayerWindow(): void {
  void request(
    "player-window",
    () => isTauriRuntime() ? api.post("/api/player/attach") : api.getState(),
    false,
  );
}

function bindScrollContainer(): void {
  const next = document.querySelector<HTMLElement>(".workspace-content");
  if (next === scrollContainer) return;
  unbindScrollContainer();
  scrollContainer = next;
}

function unbindScrollContainer(): void {
  scrollContainer = null;
}

function resolveScrollContainer(): HTMLElement | null {
  if (scrollContainer?.isConnected) return scrollContainer;
  const current = document.querySelector<HTMLElement>(".workspace-content");
  if (current) scrollContainer = current;
  return scrollContainer;
}

function currentScrollTop(): number {
  return resolveScrollContainer()?.scrollTop ?? window.scrollY;
}

function sourceForOperation(operation: string): AppErrorSource {
  if (operation.includes("import") || operation === "confirm" || operation === "select") return "config";
  if (operation.includes("player")) return "player";
  if (operation.includes("search")) return "search";
  if (operation.includes("detail")) return "detail";
  if (operation === "open"
    || operation === "home"
    || operation === "category"
    || operation === "switch"
    || operation === "select-source"
    || operation.startsWith("restore-")
    || operation.startsWith("initial-")) return "source";
  return "renderer";
}

function handleScroll(event?: Event): void {
  if (event?.target instanceof HTMLElement && event.target.classList.contains("workspace-content")) {
    scrollContainer = event.target;
  }
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined;
    persistView({ scrollTop: currentScrollTop() });
  }, 150);
}

async function restorePage(): Promise<void> {
  restored.value = true;
  // Tauri restores the source and home page inside getState/confirm. The
  // legacy fetch renderer still needs the two follow-up calls here.
  if (!isTauriRuntime() && state.value.import.selectedSiteKey && state.value.import.sessionReady) {
    await request("initial-open", () => api.post("/api/open"));
    await request("initial-home", () => api.post("/api/home"));
  }
  await nextTick();
  bindScrollContainer();
  restoreScroll(persistence.value?.scrollTop ?? 0);
  restoreCompleted.value = true;
}

function restoreScroll(scrollTop: number): void {
  if (scrollTop <= 0) return;
  let attempts = 0;
  const apply = (): void => {
    const container = resolveScrollContainer();
    if (container) {
      container.scrollTop = scrollTop;
    } else if (typeof window.scrollTo === "function") {
      attempts += 1;
      if (attempts < 3) {
        window.setTimeout(apply, 0);
        return;
      }
      window.scrollTo(0, scrollTop);
    }
  };
  window.setTimeout(apply, 0);
}

function clonePersistence(value: RendererPersistenceState): RendererPersistenceState {
  return {
    ...value,
    category: value.category ? { ...value.category } : null,
    search: value.search ? { ...value.search } : null,
  };
}

function selectSite(siteKey: string): void {
  post("select", "/api/import/select", { siteKey });
}

function loadConfigFile(file: { name: string; text: string }): void {
  if (isTauriRuntime()) {
    post("import-file", "/api/import/load-file", { input: file.text, sourceName: file.name });
  } else {
    post("import", "/api/import/load", { input: file.text });
  }
}

async function play(line: number, episode: number, resumeMode?: HistoryResumeMode): Promise<void> {
  const detailId = String(state.value.detail.detail?.vod_id ?? state.value.detail.detail?.id ?? "").trim();
  const playKey = `${detailId}:${line}:${episode}:${resumeMode ?? ""}`;
  if (activePlayKey === playKey && pending.value === "player") return;
  activePlayKey = playKey;
  await flushPlayerSync();
  lineIndex.value = line;
  const detail = state.value.detail.detail;
  const mediaId = String(detail?.vod_id ?? detail?.id ?? "");
  if (routerEnabled && mediaId) {
    const target = { name: "watch" as const, params: { mediaId }, query: { episode: String(episode + 1), ...(state.value.import.selectedSiteKey ? { source: state.value.import.selectedSiteKey } : {}) } };
    if (router.currentRoute.value.name === "watch" && String(router.currentRoute.value.params.mediaId ?? "") === mediaId) {
      await router.replace(target);
    } else {
      await router.push(target);
    }
  }
  try {
    const success = await request("player", options => api.post("/api/player", {
      lineIndex: line,
      episodeIndex: episode,
      vipFlags: [],
      ...(resumeMode ? { resume: resumeMode } : {}),
    }, options), true, { latest: true });
    if (!success) return;
  } finally {
    if (activePlayKey === playKey) activePlayKey = null;
  }
}

async function handleLineChange(index: number): Promise<void> {
  const catalog = state.value.detail.playbackCatalog;
  const line = catalog?.lines.find((candidate) => candidate.index === index);
  if (!line) return;

  const selectedEpisodeIndex = state.value.detail.playbackSelection?.episodeIndex;
  const episode = line.episodes.find((candidate) => candidate.index === selectedEpisodeIndex) ?? line.episodes[0];
  if (!episode) {
    lineIndex.value = line.index;
    return;
  }

  if (line.index === (state.value.detail.playbackSelection?.lineIndex ?? lineIndex.value)
    && state.value.playback.player.source !== null
    && state.value.playback.player.status !== "error") return;
  await flushPlayerSync();
  lineIndex.value = line.index;
  await request("player-line-switch", options => api.post("/api/player", {
    lineIndex: line.index,
    episodeIndex: episode.index,
    vipFlags: [],
  }, options), true, { latest: true });
}

function handleHome(): void {
  post("home", "/api/home");
  if (routerEnabled) void router.push({ name: "home" });
}

function handleCategory(typeIdValue?: string, filters: Record<string, string> = {}): void {
  const typeId = typeIdValue?.trim() || persistence.value?.category?.typeId?.trim();
  post("category", "/api/category", {
    page: 1,
    ...(typeId ? { typeId } : {}),
    ...(Object.keys(filters).length > 0 ? { extend: filters, filter: filters } : {}),
  });
  if (routerEnabled) {
    const query = {
      ...(typeId ? { type: typeId } : {}),
      ...(Object.keys(filters).length > 0 ? { filter: JSON.stringify(filters) } : {}),
    };
    void router.push({ name: "category", ...(Object.keys(query).length > 0 ? { query } : {}) });
  }
}

function handleSearch(query: string): void {
  post("search", "/api/search", { key: query, page: 1, quick: false });
  if (routerEnabled && query.trim()) void router.push({ name: "search", query: { q: query.trim() } });
}

function handleDetail(vodId: string, siteKey?: string): void {
  post("detail", "/api/detail", { vodId, ...(siteKey ? { siteKey } : {}) });
  const currentRoute = router.currentRoute.value.name;
  if (routerEnabled && vodId.trim() && currentRoute !== "media" && currentRoute !== "watch") {
    void router.push({ name: "media", params: { mediaId: vodId }, ...(siteKey ? { query: { source: siteKey } } : {}) });
  }
}

async function openFeatureDetail(
  operation: string,
  call: () => Promise<RendererEnvelope>,
): Promise<void> {
  const opened = await request(operation, call);
  if (!opened) return;
  const vodId = String(state.value.detail.detail?.vod_id ?? state.value.detail.detail?.id ?? "").trim();
  if (!vodId) return;
  if (routerEnabled) await router.push({ name: "media", params: { mediaId: vodId } });
}

async function handleHistoryOpen(identity: string): Promise<void> {
  await openFeatureDetail("history-open", () => api.post("/api/history/open", { identity }));
}

async function handleFavoriteOpen(favoriteId: string): Promise<void> {
  await openFeatureDetail("favorite-open", () => api.post("/api/favorites/open", { favoriteId }));
}

async function handleFollowOpen(identity: string): Promise<void> {
  await openFeatureDetail("follow-open", () => api.post("/api/follow/open", { identity }));
}

function handleDetailClose(): void {
  post("detail-close", "/api/detail/close");
  if (routerEnabled) void router.push({ name: "home" });
}

async function handleSwitch(): Promise<void> {
  const switched = await request("switch", options => api.post("/api/switch", {}, options));
  if (switched && routerEnabled) await router.replace({ name: "home" });
}

async function selectCoreSource(siteKey: string): Promise<void> {
  if (!siteKey.trim()) return;
  const currentRoute = router.currentRoute.value;
  const returnTo = currentRoute.name === "watch" || currentRoute.name === "media"
    ? String(currentRoute.name)
    : typeof currentRoute.query.returnTo === "string" && (currentRoute.query.returnTo === "watch" || currentRoute.query.returnTo === "media")
      ? currentRoute.query.returnTo
      : "";
  const title = returnTo ? String(state.value.detail.detail?.vod_name ?? state.value.detail.detail?.title ?? "").trim() : "";
  const selected = await request("select-source", options => api.post("/api/import/select", { siteKey }, options));
  if (!selected || !routerEnabled) return;
  if (title) {
    // Catalog IDs and episode indexes belong to one source. Re-search the
    // title so the user can choose an identified result from the new source.
    await router.replace({ name: "search", query: { q: title } });
    return;
  }
  if (state.value.import.selectedSiteKey === siteKey && state.value.import.sessionReady) {
    await router.replace({ name: "home" });
  }
}

function selectPlaybackSource(siteKey: string, vodId: string): void {
  post("playback-source-select", "/api/playback-sources/select", { siteKey, vodId });
}

function playLocal(itemId: string, resumeMode?: HistoryResumeMode): void {
  post("local-play", "/api/local-media/play", {
    itemId,
    ...(resumeMode ? { resume: resumeMode } : {}),
  });
}

const legacyHandlers = {
  detailClose: handleDetailClose,
  danmakuLoad: (input: Record<string, unknown>) => post("danmaku-load", "/api/danmaku/load", input),
  danmakuClear: () => post("danmaku-clear", "/api/danmaku/clear"),
  danmakuSettings: (input: Record<string, unknown>) => post("danmaku-settings", "/api/danmaku/settings", input),
  cacheRefresh: () => post("cache-refresh", "/api/cache/refresh"),
  cacheClear: (scope: "expired" | "images" | "search" | "all") => post("cache-clear", "/api/cache/clear", { scope }),
  storageRefresh: () => post("storage-refresh", "/api/storage/refresh"),
  storageOpen: () => post("storage-open", "/api/storage/open"),
  storageSwitch: (mode: "normal" | "portable") => post("storage-switch", "/api/storage/switch", { mode, confirmed: true }),
  backupCreate: (includeCache: boolean) => post("backup-create", "/api/backup/create", { includeCache }),
  backupPick: () => post("backup-pick", "/api/backup/pick"),
  backupApply: () => post("backup-apply", "/api/backup/apply"),
  backupClear: () => post("backup-clear", "/api/backup/clear"),
  backupOpen: () => post("backup-open", "/api/backup/open"),
  localOpenFile: () => post("local-open-file", "/api/local-media/open-file"),
  localAddFolder: () => post("local-add-folder", "/api/local-media/add-folder"),
  localRescan: (rootId?: string) => post("local-rescan", "/api/local-media/rescan", rootId ? { rootId } : {}),
  localCancelScan: (rootId?: string) => post("local-cancel-scan", "/api/local-media/cancel-scan", rootId ? { rootId } : {}),
  localRemoveFolder: (rootId: string) => post("local-remove-folder", "/api/local-media/remove-folder", { rootId }),
  localRemoveItem: (itemId: string) => post("local-remove-item", "/api/local-media/remove-item", { itemId }),
  localRemoveHistory: (identity: string) => post("local-remove-history", "/api/history/delete", { identity }),
  localLocate: (itemId: string) => post("local-locate", "/api/local-media/locate", { itemId }),
  localPlay: playLocal,
  localDrop: (paths: string[]) => post("local-drop", "/api/local-media/drop", { paths }),
  localPlayerDetach: detachPlayer,
  localPlayerStop: stopPlayer,
  localPlayerSync: syncPlayer,
  downloadSelectFolder: () => post("download-select-folder", "/api/downloads/select-folder"),
  downloadAdd: (payload: { title: string; url: string; filename: string; targetDirectoryId: string }) => post("download-add", "/api/downloads/add", payload),
  downloadRefresh: () => post("download-refresh", "/api/downloads/refresh"),
  downloadPause: (taskId: string) => post("download-pause", "/api/downloads/pause", { taskId }),
  downloadResume: (taskId: string) => post("download-resume", "/api/downloads/resume", { taskId }),
  downloadCancel: (taskId: string) => post("download-cancel", "/api/downloads/cancel", { taskId }),
  downloadRetry: (taskId: string) => post("download-retry", "/api/downloads/retry", { taskId }),
  downloadRemove: (taskId: string) => post("download-remove", "/api/downloads/remove", { taskId }),
  downloadOpenFolder: (targetDirectoryId: string) => post("download-open-folder", "/api/downloads/open-folder", { targetDirectoryId }),
  pushSettings: (input: { enabled: boolean; port: number; confirmationPolicy: "ask" | "allow-trusted-local"; conflictMode: "replace" | "queue" | "reject" }) => post("push-settings", "/api/push/settings", input),
  pushConfirm: (id: string) => post("push-confirm", "/api/push/confirm", { id }),
  pushReject: (id: string) => post("push-reject", "/api/push/reject", { id }),
  pushCancel: (id: string) => post("push-cancel", "/api/push/cancel", { id }),
  pushClear: () => post("push-clear", "/api/push/clear"),
  castDiscover: () => post("cast-discover", "/api/cast/discover"),
  cast: (deviceId: string) => post("cast", "/api/cast/play", { deviceId }),
  castStop: () => post("cast-stop", "/api/cast/stop"),
  castDisconnect: () => post("cast-disconnect", "/api/cast/disconnect"),
};
</script>

<template>
  <PlayerWindow v-if="isPlayerWindow" />
  <div
    v-else
    id="vue-renderer"
    data-testid="vue-renderer"
    :data-theme="rendererTheme"
    :data-ready="String(state.ready)"
    :data-pending="pending ?? ''"
  >
    <WindowTitlebar />
    <div v-if="state.ready && !showImport && (pendingOperations.connection || pendingOperations.search || pendingOperations.detail)" class="request-status" role="status" data-testid="request-status">
      <span>{{ pendingOperations.search ? "正在查询来源，已返回的内容可立即打开" : "正在连接，仍可导航或切换来源" }}</span>
      <button type="button" data-action="cancel-requests" @click="cancelRequests">取消等待</button>
    </div>
    <LaunchSplash v-if="!state.ready" />
    <ConfigImportView
      v-else-if="showImport"
      :state="state.import"
      :pending="pending"
      :persistence-diagnostic="persistence?.diagnostic"
      @load="post('import', '/api/import/load', { input: $event })"
      @load-file="loadConfigFile"
      @select="selectSite"
      @confirm="post('confirm', '/api/import/confirm')"
      @cancel="post('cancel', '/api/import/cancel')"
    />
    <CoreShell
      v-else-if="routerEnabled && isCoreRoute"
      :state="state"
      :pending="pending"
      :line-index="lineIndex"
      :order="order"
      :initial-theme="persistence?.theme"
      :initial-search-query="persistence?.search?.key"
      :persistence-diagnostic="persistence?.diagnostic"
      v-on="legacyHandlers"
      @open="post('open', '/api/open')"
      @home="handleHome"
      @category="handleCategory"
      @search="handleSearch"
      @detail="handleDetail"
      @find-playback-source="post('playback-source-search', '/api/playback-sources/search')"
      @select-playback-source="selectPlaybackSource"
      @play="play"
      @retry="retryLast"
      @line="handleLineChange"
      @order="order = $event"
      @switch="handleSwitch"
      @select-source="selectCoreSource"
      @close="post('close', '/api/close')"
      @view-state="persistView"
      @player-detach="detachPlayer"
      @player-attach="attachPlayer"
      @player-stop="stopPlayer"
      @player-sync="syncPlayer"
      @fallback-cancel="cancelFallback"
      @fallback-approve="approveFallback"
      @fallback-mode="setFallbackMode"
      @favorite-toggle="post('favorite-toggle-detail', '/api/favorites/toggle-detail')"
      @favorite-move-detail="post('favorite-move-detail', '/api/favorites/move-detail', { groupId: $event })"
      @follow-toggle="post('follow-toggle-detail', '/api/follow/toggle-detail')"
      @follow-and-favorite="post('follow-and-favorite-detail', '/api/follow/favorite-detail')"
      @follow-refresh="post('follow-refresh', '/api/follow/refresh')"
      @follow-open="handleFollowOpen"
      @follow-delete="post('follow-delete', '/api/follow/delete', { identity: $event })"
      @follow-mark-watched="post('follow-mark-watched', '/api/follow/mark-watched', { identity: $event })"
      @follow-mark-unwatched="post('follow-mark-unwatched', '/api/follow/mark-unwatched', { identity: $event })"
      @history-open="handleHistoryOpen"
      @history-delete="post('history-delete', '/api/history/delete', { identity: $event })"
      @history-delete-progress="post('history-delete-progress', '/api/history/delete-progress', { identity: $event })"
      @history-clear="post('history-clear', '/api/history/clear', { identities: $event })"
      @history-pause="post('history-pause', '/api/history/pause', { paused: $event })"
      @favorite-open="handleFavoriteOpen"
      @favorite-delete="post('favorite-delete', '/api/favorites/delete', { favoriteId: $event })"
      @favorite-move="post('favorite-move', '/api/favorites/move', { favoriteId: $event.favoriteId, groupId: $event.groupId })"
      @favorite-reorder="post('favorite-reorder', '/api/favorites/reorder', { groupId: $event.groupId, favoriteIds: $event.favoriteIds })"
      @favorite-create-group="post('favorite-create-group', '/api/favorites/group/create', { name: $event })"
      @favorite-rename-group="post('favorite-rename-group', '/api/favorites/group/rename', { groupId: $event.groupId, name: $event.name })"
      @favorite-delete-group="post('favorite-delete-group', '/api/favorites/group/delete', { groupId: $event.groupId, disposition: $event.disposition })"
      @favorite-reorder-groups="post('favorite-reorder-groups', '/api/favorites/group/reorder', { groupIds: $event })"
    />
    <SpiderView
      v-else
      :state="state"
      :pending="pending"
      :line-index="lineIndex"
      :order="order"
      :initial-navigation="routerEnabled ? legacyInitialNavigation : persistence?.navigation"
      :initial-theme="persistence?.theme"
      :initial-search-query="persistence?.search?.key"
      :persistence-diagnostic="persistence?.diagnostic"
      @open="post('open', '/api/open')"
      @home="handleHome"
      @category="handleCategory"
      @search="handleSearch"
      @detail="handleDetail"
      @detail-close="handleDetailClose"
      @find-playback-source="post('playback-source-search', '/api/playback-sources/search')"
      @select-playback-source="selectPlaybackSource"
      @play="play"
      @retry="retryLast"
      @line="handleLineChange"
      @order="order = $event"
      @switch="handleSwitch"
      @close="post('close', '/api/close')"
      @view-state="persistView"
      @player-detach="detachPlayer"
      @player-attach="attachPlayer"
      @player-stop="stopPlayer"
      @player-sync="syncPlayer"
      @danmaku-load="post('danmaku-load', '/api/danmaku/load', $event)"
      @danmaku-clear="post('danmaku-clear', '/api/danmaku/clear')"
      @danmaku-settings="post('danmaku-settings', '/api/danmaku/settings', $event)"
      @fallback-cancel="cancelFallback"
      @fallback-approve="approveFallback"
      @fallback-mode="setFallbackMode"
      @history-open="post('history-open', '/api/history/open', { identity: $event })"
      @history-delete="post('history-delete', '/api/history/delete', { identity: $event })"
      @history-delete-progress="post('history-delete-progress', '/api/history/delete-progress', { identity: $event })"
      @history-clear="post('history-clear', '/api/history/clear', { identities: $event })"
      @history-pause="post('history-pause', '/api/history/pause', { paused: $event })"
      @favorite-toggle="post('favorite-toggle-detail', '/api/favorites/toggle-detail')"
      @favorite-move-detail="post('favorite-move-detail', '/api/favorites/move-detail', { groupId: $event })"
      @favorite-open="post('favorite-open', '/api/favorites/open', { favoriteId: $event })"
      @favorite-delete="post('favorite-delete', '/api/favorites/delete', { favoriteId: $event })"
      @favorite-move="post('favorite-move', '/api/favorites/move', { favoriteId: $event.favoriteId, groupId: $event.groupId })"
      @favorite-reorder="post('favorite-reorder', '/api/favorites/reorder', { groupId: $event.groupId, favoriteIds: $event.favoriteIds })"
      @favorite-create-group="post('favorite-create-group', '/api/favorites/group/create', { name: $event })"
      @favorite-rename-group="post('favorite-rename-group', '/api/favorites/group/rename', { groupId: $event.groupId, name: $event.name })"
      @favorite-delete-group="post('favorite-delete-group', '/api/favorites/group/delete', { groupId: $event.groupId, disposition: $event.disposition })"
      @favorite-reorder-groups="post('favorite-reorder-groups', '/api/favorites/group/reorder', { groupIds: $event })"
      @follow-refresh="post('follow-refresh', '/api/follow/refresh')"
      @follow-open="post('follow-open', '/api/follow/open', { identity: $event })"
      @follow-delete="post('follow-delete', '/api/follow/delete', { identity: $event })"
      @follow-mark-watched="post('follow-mark-watched', '/api/follow/mark-watched', { identity: $event })"
      @follow-mark-unwatched="post('follow-mark-unwatched', '/api/follow/mark-unwatched', { identity: $event })"
      @follow-toggle="post('follow-toggle-detail', '/api/follow/toggle-detail')"
      @follow-and-favorite="post('follow-and-favorite-detail', '/api/follow/favorite-detail')"
      @cache-refresh="post('cache-refresh', '/api/cache/refresh')"
      @cache-clear="post('cache-clear', '/api/cache/clear', { scope: $event })"
      @storage-refresh="post('storage-refresh', '/api/storage/refresh')"
      @storage-open="post('storage-open', '/api/storage/open')"
      @storage-switch="post('storage-switch', '/api/storage/switch', { mode: $event, confirmed: true })"
      @backup-create="post('backup-create', '/api/backup/create', { includeCache: $event })"
      @backup-pick="post('backup-pick', '/api/backup/pick')"
      @backup-apply="post('backup-apply', '/api/backup/apply')"
      @backup-clear="post('backup-clear', '/api/backup/clear')"
      @backup-open="post('backup-open', '/api/backup/open')"
      @local-open-file="post('local-open-file', '/api/local-media/open-file')"
      @local-add-folder="post('local-add-folder', '/api/local-media/add-folder')"
      @local-rescan="post('local-rescan', '/api/local-media/rescan', $event ? { rootId: $event } : {})"
      @local-cancel-scan="post('local-cancel-scan', '/api/local-media/cancel-scan', $event ? { rootId: $event } : {})"
      @local-remove-folder="post('local-remove-folder', '/api/local-media/remove-folder', { rootId: $event })"
      @local-remove-item="post('local-remove-item', '/api/local-media/remove-item', { itemId: $event })"
      @local-remove-history="post('local-remove-history', '/api/history/delete', { identity: $event })"
      @local-locate="post('local-locate', '/api/local-media/locate', { itemId: $event })"
      @local-play="playLocal"
      @local-drop="post('local-drop', '/api/local-media/drop', { paths: $event })"
      @local-player-detach="detachPlayer"
      @local-player-stop="stopPlayer"
      @local-player-sync="syncPlayer"
      @download-select-folder="post('download-select-folder', '/api/downloads/select-folder')"
      @download-add="post('download-add', '/api/downloads/add', { title: $event.title, url: $event.url, filename: $event.filename, targetDirectoryId: $event.targetDirectoryId })"
      @download-refresh="post('download-refresh', '/api/downloads/refresh')"
      @download-pause="post('download-pause', '/api/downloads/pause', { taskId: $event })"
      @download-resume="post('download-resume', '/api/downloads/resume', { taskId: $event })"
      @download-cancel="post('download-cancel', '/api/downloads/cancel', { taskId: $event })"
      @download-retry="post('download-retry', '/api/downloads/retry', { taskId: $event })"
      @download-remove="post('download-remove', '/api/downloads/remove', { taskId: $event })"
      @download-open-folder="post('download-open-folder', '/api/downloads/open-folder', { targetDirectoryId: $event })"
      @push-settings="post('push-settings', '/api/push/settings', $event)"
      @push-confirm="post('push-confirm', '/api/push/confirm', { id: $event })"
      @push-reject="post('push-reject', '/api/push/reject', { id: $event })"
      @push-cancel="post('push-cancel', '/api/push/cancel', { id: $event })"
      @push-clear="post('push-clear', '/api/push/clear')"
      @cast-discover="post('cast-discover', '/api/cast/discover')"
      @cast="post('cast', '/api/cast/play', { deviceId: $event })"
      @cast-stop="post('cast-stop', '/api/cast/stop')"
      @cast-disconnect="post('cast-disconnect', '/api/cast/disconnect')"
    />
  </div>
</template>
