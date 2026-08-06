<script setup lang="ts">
import type { SubtitleEncoding, SubtitleTrack } from "../../src/subtitles.js";

const props = withDefaults(defineProps<{
  tracks: readonly SubtitleTrack[];
  enabled: boolean;
  selectedTrackId: string | null;
  encoding: "auto" | SubtitleEncoding;
  fontSize: number;
  position: "bottom" | "top";
  background: "none" | "box" | "shadow";
  loading?: boolean;
  error?: string | null;
}>(), {
  loading: false,
  error: null,
});

const emit = defineEmits<{
  toggle: [enabled: boolean];
  select: [trackId: string | null];
  encoding: [encoding: "auto" | SubtitleEncoding];
  fontSize: [fontSize: number];
  position: [position: "bottom" | "top"];
  background: [background: "none" | "box" | "shadow"];
  localFile: [file: File];
}>();

function selectTrack(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit("select", value || null);
}

function toggle(event: Event): void {
  emit("toggle", (event.target as HTMLInputElement).checked);
}

function selectEncoding(event: Event): void {
  emit("encoding", (event.target as HTMLSelectElement).value as "auto" | SubtitleEncoding);
}

function selectFontSize(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) emit("fontSize", value);
}

function selectPosition(event: Event): void {
  emit("position", (event.target as HTMLSelectElement).value as "bottom" | "top");
}

function selectBackground(event: Event): void {
  emit("background", (event.target as HTMLSelectElement).value as "none" | "box" | "shadow");
}

function selectLocalFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) emit("localFile", file);
}
</script>

<template>
  <section
    class="subtitle-track-panel"
    data-testid="subtitle-track-panel"
    data-component="SubtitleTrackPanel"
    :data-subtitle-enabled="String(props.enabled)"
  >
    <div class="subtitle-track-heading">
      <strong>字幕</strong>
      <span v-if="props.selectedTrackId && props.tracks.find((track) => track.id === props.selectedTrackId)?.forced" class="subtitle-forced-hint" data-testid="subtitle-forced-hint">强制字幕</span>
    </div>
    <div class="subtitle-track-controls">
      <label class="subtitle-toggle">
        <input data-action="subtitle-toggle" type="checkbox" :checked="props.enabled" @change="toggle">
        开关
      </label>
      <label>
        轨道
        <select data-action="subtitle-track" aria-label="字幕轨道" :value="props.selectedTrackId ?? ''" @change="selectTrack">
          <option value="">关闭</option>
          <option v-for="track in props.tracks" :key="track.id" :value="track.id">
            {{ track.label }}{{ track.forced ? " · forced" : "" }}
          </option>
        </select>
      </label>
      <label>
        编码
        <select data-action="subtitle-encoding" aria-label="字幕编码" :value="props.encoding" @change="selectEncoding">
          <option value="auto">自动识别</option>
          <option value="utf-8">UTF-8</option>
          <option value="utf-16le">UTF-16 LE</option>
          <option value="utf-16be">UTF-16 BE</option>
          <option value="gb18030">GB18030</option>
          <option value="gbk">GBK</option>
          <option value="big5">Big5</option>
        </select>
      </label>
      <label>
        字号
        <input data-action="subtitle-font-size" type="range" min="12" max="48" step="1" :value="props.fontSize" @input="selectFontSize">
      </label>
      <label>
        位置
        <select data-action="subtitle-position" aria-label="字幕位置" :value="props.position" @change="selectPosition">
          <option value="bottom">底部</option>
          <option value="top">顶部</option>
        </select>
      </label>
      <label>
        背景
        <select data-action="subtitle-background" aria-label="字幕背景" :value="props.background" @change="selectBackground">
          <option value="none">无</option>
          <option value="shadow">阴影</option>
          <option value="box">背景框</option>
        </select>
      </label>
      <label class="subtitle-file-picker">
        本地文件
        <input data-action="subtitle-local-file" type="file" accept=".vtt,.srt,.ass,.ssa,text/vtt,text/plain" @change="selectLocalFile">
      </label>
    </div>
    <p v-if="props.loading" class="meta" data-testid="subtitle-loading">正在加载字幕…</p>
    <p v-if="props.error" class="player-error" data-testid="subtitle-error">{{ props.error }}</p>
    <p class="meta">远程字幕通过 LocalProxy；ASS/SSA 仅转换基础 Dialogue，不执行特效或脚本。</p>
  </section>
</template>
