<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { RendererApi } from "./api.js";
import ConfigImportView from "./ConfigImportView.vue";
import SpiderView from "./SpiderView.vue";
import {
  applyRendererEnvelope,
  createRendererState,
  type RendererEnvelope,
  type RendererState,
} from "./state.js";

const api = new RendererApi();
const state = ref<RendererState>(createRendererState());
const pending = ref<string | null>(null);
const lineIndex = ref(0);
const order = ref<"forward" | "reverse">("forward");

const showImport = computed(() => state.value.import.status !== "ready" || !state.value.import.sessionReady);

onMounted(() => {
  void request("state", () => api.getState());
});

async function request(operation: string, call: () => Promise<RendererEnvelope>): Promise<void> {
  pending.value = operation;
  try {
    state.value = applyRendererEnvelope(state.value, await call());
    const selection = state.value.detail.playbackSelection;
    lineIndex.value = selection?.lineIndex ?? state.value.detail.playbackCatalog?.lines[0]?.index ?? 0;
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

function selectSite(siteKey: string): void {
  post("select", "/api/import/select", { siteKey });
}

function play(line: number, episode: number): void {
  lineIndex.value = line;
  post("player", "/api/player", { lineIndex: line, episodeIndex: episode, vipFlags: [] });
}
</script>

<template>
  <div id="vue-renderer" data-testid="vue-renderer" :data-ready="String(state.ready)">
    <ConfigImportView
      v-if="showImport"
      :state="state.import"
      :pending="pending"
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
    />
  </div>
</template>
