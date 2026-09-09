<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import WindowTitlebar from "./WindowTitlebar.vue";
import { RendererApi } from "./api.js";
import { isTauriRuntime, requestPlayerWindow } from "./tauri-rpc.js";
import {
  applyRendererEnvelope,
  createRendererState,
  type PlayerMediaSync,
  type RendererState,
} from "./state.js";

const api = new RendererApi();
const state = ref<RendererState>(createRendererState());
const pending = ref<string | null>(null);
const theme = ref("dark");
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let latestSync: PlayerMediaSync | null = null;

const session = computed(() => state.value.playback.session);
const active = computed(() => session.value?.host === "detached" && state.value.playback.player.source !== null);

onMounted(() => {
  if (isTauriRuntime()) {
    void requestPlayerWindow({ action: "snapshot", value: {} }).then((snapshot) => {
      const value = snapshot.state as { player?: RendererState["playback"]["player"]; session?: RendererState["playback"]["session"] };
      if (value.player) state.value.playback.player = value.player;
      theme.value = snapshot.state.theme === "light" ? "light" : "dark";
      state.value.playback.session = value.session ?? null;
    }).catch(() => undefined);
  } else {
    void request("state", () => api.getState());
  }
});

onBeforeUnmount(() => {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  void flushSync();
});

async function request(operation: string, call: () => ReturnType<RendererApi["getState"]>): Promise<void> {
  pending.value = operation;
  try {
    const envelope = await call();
    state.value = applyRendererEnvelope(state.value, envelope);
  } catch {
    // The main window remains the recovery surface if the child closes mid-request.
  } finally {
    pending.value = null;
  }
}

function returnToMain(): void {
  void returnToMainAfterFlush();
}

async function returnToMainAfterFlush(): Promise<void> {
  await flushSync();
  if (isTauriRuntime()) {
    await requestPlayerWindow({ action: "attach", value: { notifyMain: true } }).then(() => undefined).catch(() => undefined);
  } else {
    await request("attach", () => api.post("/api/player/attach"));
  }
}

function stop(): void {
  void stopAfterFlush();
}

async function stopAfterFlush(): Promise<void> {
  await flushSync();
  if (isTauriRuntime()) {
    await requestPlayerWindow({ action: "stop", value: {} }).then(() => undefined).catch(() => undefined);
  } else {
    await request("stop", () => api.post("/api/player/stop"));
  }
}

function sync(value: PlayerMediaSync): void {
  latestSync = value;
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  const eventType = value.event?.type;
  if (value.status === "error" || value.status === "paused" || value.status === "ended" || eventType === "first-frame" || eventType === "startup-timeout" || eventType === "user-pause" || eventType === "completion") {
    syncTimer = undefined;
    void flushSync();
    return;
  }
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void flushSync();
  }, 150);
}

async function flushSync(): Promise<void> {
  const value = latestSync;
  latestSync = null;
  if (!value) return;
  try {
    if (isTauriRuntime()) {
      await requestPlayerWindow({ action: "sync", value: value as unknown as Record<string, unknown> });
    } else {
      const envelope = await api.post("/api/player/sync", value);
      if (envelope.state) state.value = applyRendererEnvelope(state.value, envelope);
    }
  } catch {
    // The next media event will retry with a fresh snapshot.
  }
}
</script>

<template>
  <main class="player-window-shell" :data-theme="theme" data-testid="player-window" :data-pending="pending ?? ''">
    <WindowTitlebar />
    <header class="panel player-window-header">
      <span class="section-kicker">独立播放窗口</span>
      <h1>{{ session?.media.title ?? "QX 影视播放" }}</h1>
    </header>

    <section v-if="active" class="panel player-window-stage">
      <div class="player-window-meta">
        <span data-testid="player-window-line">线路：{{ session?.lineName ?? "当前线路" }}</span>
        <span data-testid="player-window-episode">选集：{{ session?.episodeName ?? "当前选集" }}</span>
      </div>
      <EmbeddedPlayer
        :state="state.playback.player"
        :session-id="session?.id"
        :danmaku="state.danmaku"
        :detachable="false"
        @sync="sync"
        @stop="stop"
      />
      <div class="button-row player-window-actions">
        <button type="button" class="button-primary" data-action="player-attach" @click="returnToMain">返回主窗口</button>
        <button type="button" class="button-secondary" data-action="player-stop" @click="stop">停止播放</button>
      </div>
    </section>

    <section v-else class="panel" data-testid="player-window-inactive">
      <h2>播放窗口已返回主窗口</h2>
      <p>当前没有需要在此窗口承载的播放会话。</p>
      <button type="button" class="button-primary" data-action="player-attach" @click="returnToMain">返回主窗口</button>
    </section>
  </main>
</template>
