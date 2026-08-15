<script setup lang="ts">
import SettingsSection from "./SettingsSection.vue";
import type { DanmakuSettings, DanmakuType, DanmakuUiState } from "../../src/danmaku/danmaku-types.js";

const props = defineProps<{
  state: DanmakuUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  load: [input: Record<string, unknown>];
  clear: [];
  settings: [patch: Record<string, unknown>];
}>();

const types: readonly DanmakuType[] = ["scroll", "top", "bottom", "reverse"];
const typeLabels: Record<DanmakuType, string> = {
  scroll: "滚动",
  top: "顶部",
  bottom: "底部",
  reverse: "反向",
};

function patch(key: keyof DanmakuSettings, value: unknown): void {
  emit("settings", { [key]: value });
}

function toggleType(type: DanmakuType, checked: boolean): void {
  const next = new Set(props.state.settings.types);
  if (checked) next.add(type);
  else next.delete(type);
  patch("types", [...next]);
}

function toggleSource(source: string, checked: boolean): void {
  const next = new Set(props.state.settings.sources);
  if (checked) next.add(source);
  else next.delete(source);
  patch("sources", [...next]);
}

async function loadFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  emit("load", { format: "auto", data: await file.text(), source: "local file" });
}
</script>

<template>
  <SettingsSection title="弹幕" description="只接收用户提供、本地或自建服务的 JSON/XML；播放器覆盖层不会修改视频内容。">
    <div class="settings-row">
      <span>总条数 / 状态</span>
      <strong data-testid="danmaku-status">{{ props.state.totalCount }} / {{ props.state.status }}</strong>
    </div>
    <label class="settings-control">
      <span>启用覆盖层</span>
      <input type="checkbox" :checked="props.state.settings.enabled" :disabled="props.pending !== null" @change="patch('enabled', ($event.target as HTMLInputElement).checked)">
    </label>
    <label class="settings-control">
      <span>透明度 {{ Math.round(props.state.settings.opacity * 100) }}%</span>
      <input type="range" min="0" max="1" step="0.01" :value="props.state.settings.opacity" :disabled="props.pending !== null" @change="patch('opacity', Number(($event.target as HTMLInputElement).value))">
    </label>
    <label class="settings-control">
      <span>字号 {{ props.state.settings.fontSize }}px</span>
      <input type="range" min="12" max="48" step="1" :value="props.state.settings.fontSize" :disabled="props.pending !== null" @change="patch('fontSize', Number(($event.target as HTMLInputElement).value))">
    </label>
    <label class="settings-control">
      <span>速度 {{ props.state.settings.speed.toFixed(2) }}×</span>
      <input type="range" min="0.25" max="4" step="0.25" :value="props.state.settings.speed" :disabled="props.pending !== null" @change="patch('speed', Number(($event.target as HTMLInputElement).value))">
    </label>
    <label class="settings-control">
      <span>密度 {{ Math.round(props.state.settings.density * 100) }}%</span>
      <input type="range" min="0" max="1" step="0.05" :value="props.state.settings.density" :disabled="props.pending !== null" @change="patch('density', Number(($event.target as HTMLInputElement).value))">
    </label>
    <label class="settings-control">
      <span>显示区域 {{ Math.round(props.state.settings.displayArea * 100) }}%</span>
      <input type="range" min="0.25" max="1" step="0.05" :value="props.state.settings.displayArea" :disabled="props.pending !== null" @change="patch('displayArea', Number(($event.target as HTMLInputElement).value))">
    </label>
    <label class="settings-control">
      <span>关键词屏蔽</span>
      <input type="search" :value="props.state.settings.keyword" maxlength="128" :disabled="props.pending !== null" @change="patch('keyword', ($event.target as HTMLInputElement).value)">
    </label>
    <label class="settings-control">
      <span>安全正则</span>
      <input type="text" :value="props.state.settings.regex" maxlength="128" placeholder="可选" :disabled="props.pending !== null" @change="patch('regex', ($event.target as HTMLInputElement).value)">
    </label>
    <div class="danmaku-type-controls">
      <span>类型</span>
      <label v-for="type in types" :key="type" class="checkbox-control">
        <input type="checkbox" :checked="props.state.settings.types.includes(type)" :disabled="props.pending !== null" @change="toggleType(type, ($event.target as HTMLInputElement).checked)">
        <span>{{ typeLabels[type] }}</span>
      </label>
    </div>
    <div v-if="props.state.sources.length > 0" class="danmaku-source-controls">
      <span>来源</span>
      <label v-for="source in props.state.sources" :key="source" class="checkbox-control">
        <input type="checkbox" :checked="props.state.settings.sources.includes(source)" :disabled="props.pending !== null" @change="toggleSource(source, ($event.target as HTMLInputElement).checked)">
        <span>{{ source }}</span>
      </label>
    </div>
    <div class="button-row">
      <label class="button-secondary danmaku-file-button">
        加载 JSON/XML
        <input type="file" accept=".json,.xml,application/json,text/xml,application/xml" :disabled="props.pending !== null" @change="loadFile">
      </label>
      <button type="button" class="button-secondary" :disabled="props.pending !== null || props.state.totalCount === 0" @click="emit('clear')">清空</button>
    </div>
    <p v-if="props.state.error" class="error-text" data-testid="danmaku-error">{{ props.state.error.message }}</p>
  </SettingsSection>
</template>
