<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { RendererApi } from "./api.js";
import ConfigImportView from "./ConfigImportView.vue";
import { toAppError } from "./error.js";
import LaunchSplash from "./LaunchSplash.vue";
import PlayerWindow from "./PlayerWindow.vue";
import SpiderView from "./SpiderView.vue";
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

const api = new RendererApi();
const state = ref<RendererState>(createRendererState());
const pending = ref<string | null>(null);
const lineIndex = ref(0);
const order = ref<"forward" | "reverse">("forward");
const persistence = ref<RendererPersistenceState | null>(null);
const restoreCandidate = ref<RendererPersistenceState | null>(null);
const restored = ref(false);
const isPlayerWindow = new URL(window.location.href).searchParams.get("player-window") === "1";
const rendererTheme = computed<"light" | "dark">(() => persistence.value?.theme === "dark" ? "dark" : "light");
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let playerSyncTimer: ReturnType<typeof setTimeout> | undefined;
let liveSyncTimer: ReturnType<typeof setTimeout> | undefined;
let latestPlayerSync: PlayerMediaSync | null = null;
let latestLiveSync: PlayerMediaSync | null = null;
let retryAction: { operation: string; call: () => Promise<RendererEnvelope> } | null = null;

const showImport = computed(() => state.value.import.status !== "ready" || !state.value.import.sessionReady);

onMounted(() => {
  if (isPlayerWindow) return;
  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("qx-player-attached", refreshAfterPlayerWindow);
  void request("state", () => api.getState());
});

onBeforeUnmount(() => {
  if (isPlayerWindow) return;
  window.removeEventListener("scroll", handleScroll);
  window.removeEventListener("qx-player-attached", refreshAfterPlayerWindow);
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  if (liveSyncTimer !== undefined) clearTimeout(liveSyncTimer);
  persistView({ scrollTop: window.scrollY });
  void flushPlayerSync();
  void flushLiveSync();
});

async function request(
  operation: string,
  call: () => Promise<RendererEnvelope>,
  remember = true,
): Promise<void> {
  if (remember) retryAction = { operation, call };
  pending.value = operation;
  try {
    const envelope = await call();
    if (envelope.persistence) {
      persistence.value = clonePersistence(envelope.persistence);
      if (!restoreCandidate.value) restoreCandidate.value = clonePersistence(envelope.persistence);
    }
    state.value = applyRendererEnvelope(state.value, envelope);
    const selection = state.value.detail.playbackSelection;
    lineIndex.value = selection?.lineIndex ?? state.value.detail.playbackCatalog?.lines[0]?.index ?? 0;
    if (!restored.value && state.value.import.status === "ready" && state.value.import.sessionReady) {
      await restorePage();
    }
  } catch (error) {
    const appError = toAppError({
      code: "RENDERER_REQUEST_ERROR",
      message: error instanceof Error ? error.message : String(error),
      safeDetails: { operation },
    }, sourceForOperation(operation));
    state.value = {
      ...state.value,
      ready: true,
      import: state.value.import.status === "ready"
        ? state.value.import
        : { ...state.value.import, error: appError },
      error: { error: appError },
    };
  } finally {
    pending.value = null;
  }
}

function post(operation: string, path: string, body: Record<string, unknown> = {}): void {
  void request(operation, () => api.post(path, body));
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
  playerSyncTimer = setTimeout(() => {
    playerSyncTimer = undefined;
    void flushPlayerSync();
  }, 150);
}

async function flushPlayerSync(): Promise<void> {
  const value = latestPlayerSync;
  latestPlayerSync = null;
  if (!value) return;
  try {
    const envelope = await api.post("/api/player/sync", value);
    if (envelope.state) state.value = applyRendererEnvelope(state.value, envelope);
  } catch {
    // Playback cleanup remains local if the host is closing.
  }
}

function syncLive(value: PlayerMediaSync): void {
  latestLiveSync = value;
  if (liveSyncTimer !== undefined) clearTimeout(liveSyncTimer);
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = undefined;
    void flushLiveSync();
  }, 150);
}

async function flushLiveSync(): Promise<void> {
  const value = latestLiveSync;
  latestLiveSync = null;
  const session = state.value.live.session;
  if (!value || !session) return;
  try {
    const envelope = await api.post("/api/live/sync", {
      sessionId: session.sessionId,
      backend: session.backend,
      ...value,
    });
    state.value = applyRendererEnvelope(state.value, envelope);
  } catch {
    // The main process owns live-session cleanup when the window closes.
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

function stopPlayer(): void {
  post("stop-player", "/api/player/stop");
}

function playLive(channelId: string, streamId?: string): void {
  post("live-play", "/api/live/play", { channelId, ...(streamId ? { streamId } : {}) });
}

function switchLiveLine(streamId: string): void {
  post("live-line", "/api/live/line", { streamId });
}

function stopLive(): void {
  post("live-stop", "/api/live/stop");
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
  void request("player-window", () => api.getState(), false);
}

function sourceForOperation(operation: string): AppErrorSource {
  if (operation.includes("import") || operation === "confirm" || operation === "select") return "config";
  if (operation.includes("player")) return "player";
  if (operation.includes("search")) return "search";
  if (operation.includes("detail")) return "detail";
  return "renderer";
}

function handleScroll(): void {
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined;
    persistView({ scrollTop: window.scrollY });
  }, 150);
}

async function restorePage(): Promise<void> {
  restored.value = true;
  const candidate = restoreCandidate.value;
  if (!candidate || candidate.navigation === "local" || !candidate.siteKey || candidate.navigation === "settings" || candidate.navigation === "live") {
    restoreScroll(candidate?.scrollTop ?? 0);
    return;
  }
  if (state.value.import.selectedSiteKey !== candidate.siteKey) return;

  await request("restore-open", () => api.post("/api/open"));
  if (candidate.navigation === "category" && candidate.category) {
    await request("restore-category", () => api.post("/api/category", candidate.category ?? {}));
  } else if (candidate.navigation === "search" && candidate.search) {
    await request("restore-search", () => api.post("/api/search", {
      key: candidate.search.key,
      page: candidate.search.page,
      quick: false,
    }));
  } else if (candidate.navigation === "detail" && candidate.recentDetailId) {
    await request("restore-detail", () => api.post("/api/detail", { vodId: candidate.recentDetailId }));
  } else if (candidate.navigation === "history") {
    restoreScroll(candidate.scrollTop);
    return;
  } else if (candidate.navigation === "favorites") {
    restoreScroll(candidate.scrollTop);
    return;
  } else if (candidate.navigation === "follow") {
    await request("restore-follow", () => api.post("/api/follow/refresh"));
    restoreScroll(candidate.scrollTop);
    return;
  } else {
    await request("restore-home", () => api.post("/api/home"));
  }
  restoreScroll(candidate.scrollTop);
}

function restoreScroll(scrollTop: number): void {
  if (scrollTop <= 0 || typeof window.scrollTo !== "function") return;
  window.setTimeout(() => window.scrollTo(0, scrollTop), 0);
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

function play(line: number, episode: number, resumeMode?: HistoryResumeMode): void {
  lineIndex.value = line;
  post("player", "/api/player", {
    lineIndex: line,
    episodeIndex: episode,
    vipFlags: [],
    ...(resumeMode ? { resume: resumeMode } : {}),
  });
}

function playLocal(itemId: string, resumeMode?: HistoryResumeMode): void {
  post("local-play", "/api/local-media/play", {
    itemId,
    ...(resumeMode ? { resume: resumeMode } : {}),
  });
}
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
    <LaunchSplash v-if="!state.ready" />
    <ConfigImportView
      v-else-if="showImport"
      :state="state.import"
      :pending="pending"
      :persistence-diagnostic="persistence?.diagnostic"
      @load="post('import', '/api/import/load', { input: $event })"
      @select="selectSite"
      @confirm="post('confirm', '/api/import/confirm')"
      @cancel="post('cancel', '/api/import/cancel')"
    />
    <SpiderView
      v-else
      :state="state"
      :pending="pending"
      :line-index="lineIndex"
      :order="order"
      :initial-navigation="persistence?.navigation"
      :initial-theme="persistence?.theme"
      :initial-search-query="persistence?.search?.key"
      :persistence-diagnostic="persistence?.diagnostic"
      @open="post('open', '/api/open')"
      @home="post('home', '/api/home')"
      @category="post('category', '/api/category', { typeId: 'hot_gaia', page: 1 })"
      @search="post('search', '/api/search', { key: $event, page: 1, quick: false })"
      @detail="post('detail', '/api/detail', { vodId: $event })"
      @play="play"
      @retry="retryLast"
      @line="lineIndex = $event"
      @order="order = $event"
      @switch="post('switch', '/api/switch')"
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
      @live-preview="post('live-preview', '/api/live/source/preview', $event)"
      @live-apply="post('live-apply', '/api/live/source/apply', { previewId: $event })"
      @live-refresh="post('live-refresh', '/api/live/source/refresh', { sourceId: $event })"
      @live-toggle="post('live-toggle', '/api/live/source/toggle', { sourceId: $event.sourceId, enabled: $event.enabled })"
      @live-remove="post('live-remove', '/api/live/source/remove', { sourceId: $event })"
      @live-clear="post('live-clear', '/api/live/preview/clear')"
      @live-play="playLive"
      @live-line="switchLiveLine"
      @live-stop="stopLive"
      @live-sync="syncLive"
      @live-failover-mode="post('live-failover-mode', '/api/live/failover/mode', { mode: $event })"
      @live-failover-approve="post('live-failover-approve', '/api/live/failover/approve')"
      @live-failover-cancel="post('live-failover-cancel', '/api/live/failover/cancel')"
      @live-failover-stay="post('live-failover-stay', '/api/live/failover/stay')"
      @live-failover-return="post('live-failover-return', '/api/live/failover/return')"
      @smart-create="post('smart-create', '/api/live/smart/create', $event)"
      @smart-update="post('smart-update', '/api/live/smart/update', $event)"
      @smart-delete="post('smart-delete', '/api/live/smart/delete', { smartChannelId: $event })"
      @smart-add-member="post('smart-add-member', '/api/live/smart/member/add', $event)"
      @smart-remove-member="post('smart-remove-member', '/api/live/smart/member/remove', $event)"
      @smart-member-update="post('smart-member-update', '/api/live/smart/member/update', $event)"
      @smart-member-reorder="post('smart-member-reorder', '/api/live/smart/member/reorder', $event)"
      @smart-select="post('smart-select', '/api/live/smart/select', $event)"
      @smart-play="post('smart-play', '/api/live/smart/play', $event)"
      @smart-epg="post('smart-epg', '/api/live/smart/epg', $event)"
      @epg-preview="post('epg-preview', '/api/epg/source/preview', $event)"
      @epg-apply="post('epg-apply', '/api/epg/source/apply', { previewId: $event })"
      @epg-refresh="post('epg-refresh', '/api/epg/source/refresh', { sourceId: $event })"
      @epg-toggle="post('epg-toggle', '/api/epg/source/toggle', { sourceId: $event.sourceId, enabled: $event.enabled })"
      @epg-remove="post('epg-remove', '/api/epg/source/remove', { sourceId: $event })"
      @epg-clear="post('epg-clear', '/api/epg/preview/clear')"
      @epg-mapping-confirm="post('epg-mapping-confirm', '/api/epg/mapping/confirm', $event)"
      @epg-mapping-clear="post('epg-mapping-clear', '/api/epg/mapping/clear', $event)"
      @epg-mapping-confirm-high="post('epg-mapping-confirm-high', '/api/epg/mapping/confirm-high')"
      @epg-alias-set="post('epg-alias-set', '/api/epg/alias/set', $event)"
      @epg-alias-remove="post('epg-alias-remove', '/api/epg/alias/remove', $event)"
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
