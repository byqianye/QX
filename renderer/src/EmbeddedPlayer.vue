<script setup lang="ts">
import Hls from "hls.js";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { PlayerState } from "./state.js";

const windowWithHls = window as Window & { Hls?: typeof Hls };
windowWithHls.Hls ??= Hls;

const props = defineProps<{ state: PlayerState }>();

const video = ref<HTMLVideoElement | null>(null);
const localStatus = ref(props.state.status);
const localError = ref<string | null>(props.state.error?.message ?? null);
const currentTime = ref(props.state.currentTime);
const duration = ref(props.state.duration);
const muted = ref(props.state.muted);
let hls: Hls | null = null;
const cleanups: Array<() => void> = [];

watch(() => props.state.source?.url, () => {
  loadSource();
});

watch(() => props.state.volume, (volume) => {
  if (video.value) video.value.volume = volume;
});

watch(() => props.state.muted, (mutedValue) => {
  if (video.value) video.value.muted = mutedValue;
  muted.value = mutedValue;
});

watch(() => props.state.status, (status) => {
  if (!props.state.source) localStatus.value = status;
});

watch(() => props.state.error?.message, (message) => {
  localError.value = message ?? null;
});

onMounted(() => {
  loadSource();
});

onBeforeUnmount(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  destroyHls();
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
});

function loadSource(): void {
  const element = video.value;
  if (!element) return;
  cleanups.splice(0).forEach((cleanup) => cleanup());
  destroyHls();
  element.pause();
  element.removeAttribute("src");
  element.load();
  localError.value = props.state.error?.message ?? null;
  const source = props.state.source;
  if (!source) {
    localStatus.value = props.state.status;
    return;
  }
  localStatus.value = "loading";
  if (isHls(source.url)
    && element.canPlayType("application/vnd.apple.mpegurl") === ""
    && Hls.isSupported()) {
    hls = new Hls({ enableWorker: false });
    hls.loadSource(source.url);
    hls.attachMedia(element);
  } else {
    element.src = source.url;
    element.load();
  }
  listen(element, "loadstart", () => { localStatus.value = "loading"; });
  listen(element, "playing", () => { localStatus.value = "playing"; });
  listen(element, "pause", () => { if (!element.ended) localStatus.value = "paused"; });
  listen(element, "ended", () => { localStatus.value = "ended"; });
  listen(element, "durationchange", () => {
    duration.value = Number.isFinite(element.duration) ? element.duration : 0;
  });
  listen(element, "timeupdate", () => {
    currentTime.value = element.currentTime;
  });
  listen(element, "error", () => {
    localStatus.value = "error";
    localError.value = "播放失败";
  });
}

function setVolume(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && video.value) video.value.volume = Number(target.value);
}

function setSeek(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && video.value) {
    video.value.currentTime = Number(target.value);
    currentTime.value = video.value.currentTime;
  }
}

function toggleMute(): void {
  muted.value = !muted.value;
  if (video.value) video.value.muted = muted.value;
}

function stopPlayback(): void {
  destroyHls();
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
  localStatus.value = "stopped";
  localError.value = null;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function destroyHls(): void {
  if (hls) hls.destroy();
  hls = null;
}

function listen<K extends keyof HTMLMediaElementEventMap>(
  element: HTMLVideoElement,
  event: K,
  handler: (event: HTMLMediaElementEventMap[K]) => void,
): void {
  element.addEventListener(event, handler as EventListener);
  cleanups.push(() => element.removeEventListener(event, handler as EventListener));
}

function isHls(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

function statusLabel(state: PlayerState, status: string, error: string | null): string {
  if (error) return error;
  if (status === state.status && state.error) return state.error.message;
  const labels: Record<PlayerState["status"], string> = {
    idle: "等待播放",
    resolving: "正在解析",
    loading: "正在加载",
    playing: "播放中",
    paused: "已暂停",
    ended: "播放结束",
    stopped: "已停止",
    error: "播放失败",
  };
  return labels[status as PlayerState["status"]] ?? labels.idle;
}
</script>

<template>
  <section
    data-testid="embedded-player-panel"
    class="panel embedded-player-panel"
    :data-player-status="localStatus"
  >
    <strong>内嵌播放器</strong>
    <template v-if="props.state.source">
      <video ref="video" data-testid="embedded-player" playsinline controls preload="metadata" />
      <div class="player-controls" aria-label="播放器控制">
        <button data-action="player-play" data-testid="player-play" type="button" @click="void video?.play()">播放</button>
        <button data-action="player-pause" type="button" @click="video?.pause()">暂停</button>
        <button data-action="player-resume" type="button" @click="void video?.play()">恢复</button>
        <button data-action="player-stop" type="button" @click="stopPlayback">停止</button>
        <button data-action="player-reload" type="button" @click="loadSource">重新加载</button>
        <label>进度
          <input data-action="player-seek" data-testid="player-seek" type="range" min="0" :max="duration" step="0.1" :value="currentTime" @input="setSeek">
        </label>
        <span data-testid="player-time">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
        <label>音量 <input data-action="player-volume" type="range" min="0" max="1" step="0.01" :value="props.state.volume" @input="setVolume"></label>
        <button data-action="player-mute" type="button" @click="toggleMute">{{ muted ? "取消静音" : "静音" }}</button>
        <button data-action="player-fullscreen" type="button" @click="void video?.requestFullscreen?.()">全屏</button>
      </div>
    </template>
    <p data-testid="player-status">{{ statusLabel(props.state, localStatus, localError) }}</p>
    <p v-if="localError" class="player-error" data-testid="player-error">{{ localError }}</p>
  </section>
</template>
