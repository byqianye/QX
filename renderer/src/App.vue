<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { RendererApi } from "./api.js";
import ConfigImportView from "./ConfigImportView.vue";
import PlayerWindow from "./PlayerWindow.vue";
import SpiderView from "./SpiderView.vue";
import {
  applyRendererEnvelope,
  createRendererState,
  type RendererPersistenceState,
  type RendererEnvelope,
  type RendererState,
  type PlayerMediaSync,
  type RendererViewStatePatch,
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
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let playerSyncTimer: ReturnType<typeof setTimeout> | undefined;
let latestPlayerSync: PlayerMediaSync | null = null;

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
  persistView({ scrollTop: window.scrollY });
  void flushPlayerSync();
});

async function request(operation: string, call: () => Promise<RendererEnvelope>): Promise<void> {
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
    state.value = {
      ...state.value,
      ready: true,
      error: { error: { code: "RENDERER_REQUEST_ERROR", message: error instanceof Error ? error.message : String(error) } },
    };
  } finally {
    pending.value = null;
  }
}

function post(operation: string, path: string, body: Record<string, unknown> = {}): void {
  void request(operation, () => api.post(path, body));
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

function refreshAfterPlayerWindow(): void {
  void request("player-window", () => api.getState());
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
  if (!candidate || !candidate.siteKey || candidate.navigation === "settings") {
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

function play(line: number, episode: number): void {
  lineIndex.value = line;
  post("player", "/api/player", { lineIndex: line, episodeIndex: episode, vipFlags: [] });
}
</script>

<template>
  <PlayerWindow v-if="isPlayerWindow" />
  <div
    v-else
    id="vue-renderer"
    data-testid="vue-renderer"
    :data-ready="String(state.ready)"
    :data-pending="pending ?? ''"
  >
    <ConfigImportView
      v-if="showImport"
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
      @retry="state.detail.playbackSelection && play(state.detail.playbackSelection.lineIndex, state.detail.playbackSelection.episodeIndex)"
      @line="lineIndex = $event"
      @order="order = $event"
      @switch="post('switch', '/api/switch')"
      @close="post('close', '/api/close')"
      @view-state="persistView"
      @player-detach="detachPlayer"
      @player-attach="attachPlayer"
      @player-stop="stopPlayer"
      @player-sync="syncPlayer"
    />
  </div>
</template>
