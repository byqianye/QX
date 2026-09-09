<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import Icon from "./Icon.vue";

const props = defineProps<{
  status?: "idle" | "resolving" | "loading" | "playing" | "paused" | "ended" | "stopped" | "error";
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  fullscreen?: boolean;
  qualityOptions?: readonly { id: string; label: string }[];
  qualityId?: string;
  detachable?: boolean;
  previewUrl?: string | null;
  playbackRate?: number;
}>();
const emit = defineEmits<{
  play: [];
  pause: [];
  resume: [];
  stop: [];
  reload: [];
  seek: [value: number];
  volume: [value: number];
  mute: [];
  quality: [value: string];
  fullscreen: [];
  detach: [];
  rate: [value: number];
}>();

const previewVideo = ref<HTMLVideoElement | null>(null);
const previewVisible = ref(false);
const previewReady = ref(false);
const previewTime = ref(0);
const previewLeft = ref(0);
let previewFrameTimer: ReturnType<typeof requestAnimationFrame> | undefined;

const playbackAction = computed(() => {
  if (props.status === "playing") return "pause" as const;
  if (props.status === "paused") return "resume" as const;
  return "play" as const;
});
const playbackLabel = computed(() => playbackAction.value === "pause" ? "暂停" : "播放");
const silent = computed(() => props.muted || props.volume <= 0);

function numberValue(event: Event): number | null {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return null;
  const value = Number(target.value);
  return Number.isFinite(value) ? value : null;
}

function seek(event: Event): void {
  const value = numberValue(event);
  if (value !== null) emit("seek", value);
}

function volume(event: Event): void {
  const value = numberValue(event);
  if (value !== null) emit("volume", value);
}

function quality(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  emit("quality", target.value);
}

function togglePlayback(): void {
  emit(playbackAction.value);
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function hoverSeek(event: PointerEvent): void {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || props.duration <= 0) return;
  const bounds = input.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
  previewTime.value = ratio * props.duration;
  previewLeft.value = Math.max(10, Math.min(90, ratio * 100));
  previewVisible.value = true;
  previewReady.value = false;
  if (previewFrameTimer !== undefined) cancelAnimationFrame(previewFrameTimer);
  previewFrameTimer = requestAnimationFrame(() => {
    previewFrameTimer = undefined;
    seekPreviewFrame();
  });
}

function seekPreviewFrame(): void {
  const element = previewVideo.value;
  if (!element || !props.previewUrl || !Number.isFinite(previewTime.value)) return;
  try {
    element.currentTime = Math.max(0, Math.min(previewTime.value, element.duration || previewTime.value));
  } catch {
    previewReady.value = false;
  }
}

function previewLoaded(): void {
  seekPreviewFrame();
}

function previewFrameReady(): void {
  previewReady.value = true;
}

function leaveSeek(): void {
  previewVisible.value = false;
  previewReady.value = false;
}

watch(() => props.previewUrl, () => {
  previewVisible.value = false;
  previewReady.value = false;
});

onBeforeUnmount(() => {
  if (previewFrameTimer !== undefined) cancelAnimationFrame(previewFrameTimer);
});
</script>

<template>
  <div data-component="PlayerControls" data-od-id="player-controls" class="player-controls" aria-label="播放器控制">
    <label class="player-seek-control">
      <span class="sr-only">进度</span>
      <span
        v-if="previewVisible"
        class="player-seek-preview"
        :style="{ left: `${previewLeft}%` }"
        data-testid="player-seek-preview"
        aria-hidden="true"
      >
        <video
          v-if="props.previewUrl"
          ref="previewVideo"
          class="player-seek-preview-video"
          :src="props.previewUrl"
          muted
          playsinline
          preload="metadata"
          crossorigin="anonymous"
          @loadedmetadata="previewLoaded"
          @seeked="previewFrameReady"
        />
        <span v-else class="player-seek-preview-empty">当前源不提供预览帧</span>
        <strong>{{ formatTime(previewTime) }}</strong>
      </span>
      <input data-action="player-seek" data-testid="player-seek" type="range" min="0" :max="props.duration" step="0.1" :value="props.currentTime" @input="seek" @pointermove="hoverSeek" @pointerleave="leaveSeek">
    </label>
    <div class="player-command-row">
      <div class="player-primary-controls">
        <button
          class="player-icon-button player-playback-toggle"
          :data-action="`player-${playbackAction}`"
          data-testid="player-play"
          type="button"
          :aria-label="playbackLabel"
          :title="playbackLabel"
          @click="togglePlayback"
        >
          <span v-if="playbackAction === 'pause'" class="player-pause-icon" aria-hidden="true"><i></i><i></i></span>
          <Icon v-else name="play" :size="21" />
        </button>
        <button
          data-action="player-mute"
          class="player-icon-button"
          type="button"
          :aria-label="silent ? '取消静音' : '静音'"
          :title="silent ? '取消静音' : '静音'"
          @click="emit('mute')"
        >
          <span class="player-volume-icon" :class="{ 'is-muted': silent }" aria-hidden="true"></span>
          <span class="sr-only">{{ silent ? "取消静音" : "静音" }}</span>
        </button>
        <label class="player-volume-control">
          <span class="sr-only">音量</span>
          <input data-action="player-volume" type="range" min="0" max="1" step="0.01" :value="props.volume" aria-label="音量" @input="volume">
        </label>
        <span data-testid="player-time" class="player-time">{{ formatTime(props.currentTime) }} / {{ formatTime(props.duration) }}</span>
      </div>
      <div class="player-trailing-controls">
        <label v-if="(props.qualityOptions?.length ?? 0) > 1" class="player-quality-control">
          <span class="sr-only">清晰度</span>
          <select data-action="player-quality" aria-label="清晰度" :value="props.qualityId ?? 'auto'" @change="quality">
            <option v-for="option in props.qualityOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
        </label>
        <button
          data-action="player-fullscreen"
          class="player-icon-button"
          type="button"
          :aria-label="props.fullscreen ? '退出全屏' : '全屏'"
          :title="props.fullscreen ? '退出全屏' : '全屏'"
          @click="emit('fullscreen')"
        >
          <span class="player-fullscreen-icon" :class="{ 'is-active': props.fullscreen }" aria-hidden="true">
            <i></i><i></i><i></i><i></i>
          </span>
        </button>
        <details class="player-secondary-controls">
          <summary class="player-icon-button" aria-label="更多" title="更多">
            <span class="player-more-icon" aria-hidden="true"><i></i><i></i><i></i></span>
          </summary>
          <div class="player-secondary-actions">
            <label class="player-rate-control">播放速度
              <select data-action="player-rate" aria-label="播放速度" :value="props.playbackRate ?? 1" @change="emit('rate', Number(($event.target as HTMLSelectElement).value))">
                <option v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="rate" :value="rate">{{ rate }}×</option>
              </select>
            </label>
            <slot name="settings" />
            <button data-action="player-stop" type="button" @click="emit('stop')">停止</button>
            <button data-action="player-reload" type="button" @click="emit('reload')">重新加载</button>
            <button v-if="props.detachable !== false" data-action="player-detach" type="button" @click="emit('detach')">独立窗口</button>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>
