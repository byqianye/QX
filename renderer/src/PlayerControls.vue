<script setup lang="ts">
const props = defineProps<{
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  detachable?: boolean;
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
  fullscreen: [];
  detach: [];
}>();

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

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
</script>

<template>
  <div data-component="PlayerControls" data-od-id="player-controls" class="player-controls" aria-label="播放器控制">
    <button data-action="player-play" data-testid="player-play" type="button" @click="emit('play')">播放</button>
    <button data-action="player-pause" type="button" @click="emit('pause')">暂停</button>
    <button data-action="player-resume" type="button" @click="emit('resume')">恢复</button>
    <button data-action="player-stop" type="button" @click="emit('stop')">停止</button>
    <button data-action="player-reload" type="button" @click="emit('reload')">重新加载</button>
    <label>进度
      <input data-action="player-seek" data-testid="player-seek" type="range" min="0" :max="props.duration" step="0.1" :value="props.currentTime" @input="seek">
    </label>
    <span data-testid="player-time">{{ formatTime(props.currentTime) }} / {{ formatTime(props.duration) }}</span>
    <label>音量
      <input data-action="player-volume" type="range" min="0" max="1" step="0.01" :value="props.volume" @input="volume">
    </label>
    <button data-action="player-mute" type="button" @click="emit('mute')">{{ props.muted ? "取消静音" : "静音" }}</button>
    <button data-action="player-fullscreen" type="button" @click="emit('fullscreen')">全屏</button>
    <button v-if="props.detachable !== false" data-action="player-detach" type="button" @click="emit('detach')">独立窗口</button>
  </div>
</template>
