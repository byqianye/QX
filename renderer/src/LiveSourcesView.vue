<script setup lang="ts">
import { ref } from "vue";

import type { LiveSourceType, LiveUiState } from "../../src/live/live-types.js";

const props = defineProps<{
  state: LiveUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  preview: [input: Record<string, unknown>];
  apply: [previewId: string];
  refresh: [sourceId: string];
  toggle: [payload: { sourceId: string; enabled: boolean }];
  remove: [sourceId: string];
  clear: [];
}>();

const name = ref("我的直播源");
const sourceType = ref<"m3u-url" | "m3u-file" | "txt-url" | "txt-file">("m3u-url");
const location = ref("");
const fileName = ref("");
const fileContent = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const localError = ref<string | null>(null);

function sourceLabel(type: LiveSourceType): string {
  if (type === "m3u-url") return "M3U URL";
  if (type === "txt-url") return "TXT URL";
  if (type === "m3u-file") return "M3U 文件";
  if (type === "txt-file") return "TXT 文件";
  return "测试 fixture";
}

function isFileType(): boolean {
  return sourceType.value === "m3u-file" || sourceType.value === "txt-file";
}

async function readFile(event: Event): Promise<void> {
  localError.value = null;
  fileContent.value = null;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  fileName.value = file.name;
  try {
    fileContent.value = await file.text();
  } catch {
    localError.value = "读取本地直播源文件失败。";
  }
}

function preview(): void {
  localError.value = null;
  const trimmedName = name.value.trim();
  if (!trimmedName) {
    localError.value = "请填写直播源名称。";
    return;
  }
  if (isFileType()) {
    if (!fileContent.value) {
      localError.value = "请选择一个直播源文件。";
      return;
    }
    emit("preview", {
      name: trimmedName,
      type: sourceType.value,
      fileName: fileName.value || "playlist",
      content: fileContent.value,
    });
    return;
  }
  if (!location.value.trim()) {
    localError.value = "请填写直播源 URL。";
    return;
  }
  emit("preview", {
    name: trimmedName,
    type: sourceType.value,
    location: location.value.trim(),
  });
}

function formatTime(value: number | null): string {
  if (!value) return "未刷新";
  return new Date(value).toLocaleString();
}
</script>

<template>
  <div class="live-sources" data-testid="live-sources" data-od-id="live-source-management">
    <section class="settings-section">
      <div>
        <span class="section-kicker">导入与预览</span>
        <h2>添加直播源</h2>
        <p class="meta">支持用户提供的 M3U/M3U8/TXT URL 或本地文件。预览确认后才会替换已保存频道。</p>
      </div>
      <div class="button-row">
        <button type="button" class="button-primary" data-action="live-source-preview" :disabled="props.pending !== null || props.state.loading" @click="preview">预览</button>
      </div>
      <label class="settings-control">
        <span>名称</span>
        <input v-model="name" type="text" maxlength="80" autocomplete="off" />
      </label>
      <label class="settings-control">
        <span>格式与来源</span>
        <select v-model="sourceType">
          <option value="m3u-url">M3U URL</option>
          <option value="txt-url">TXT URL</option>
          <option value="m3u-file">M3U 文件</option>
          <option value="txt-file">TXT 文件</option>
        </select>
      </label>
      <label v-if="!isFileType()" class="settings-control">
        <span>URL</span>
        <input v-model="location" type="url" inputmode="url" autocomplete="off" placeholder="https://example.invalid/playlist.m3u" />
      </label>
      <label v-else class="settings-control">
        <span>文件</span>
        <input ref="fileInput" type="file" accept=".m3u,.m3u8,.txt,text/plain,audio/x-mpegurl" @change="readFile" />
      </label>
      <p v-if="fileName" class="meta">已选择：{{ fileName }}</p>
      <p v-if="localError" class="error-message" data-testid="live-local-error">{{ localError }}</p>
      <p v-if="props.state.error" class="error-message" data-testid="live-source-error">{{ props.state.error.message }}</p>
    </section>

    <section v-if="props.state.preview" class="panel live-preview" data-testid="live-preview">
      <div class="panel-header">
        <div>
          <span class="section-kicker">导入预览</span>
          <h2>{{ props.state.preview.source.name }}</h2>
        </div>
        <span class="status-chip">{{ props.state.preview.stats.channelCount }} 个频道</span>
      </div>
      <div class="settings-row"><span>分组 / 播放线路</span><strong>{{ props.state.preview.stats.groupCount }} / {{ props.state.preview.stats.streamCount }}</strong></div>
      <div class="settings-row"><span>新增 / 删除 / 变化</span><strong>{{ props.state.preview.stats.addedCount }} / {{ props.state.preview.stats.removedCount }} / {{ props.state.preview.stats.changedCount }}</strong></div>
      <div class="settings-row"><span>无效条目</span><strong>{{ props.state.preview.stats.invalidCount }}</strong></div>
      <p v-if="props.state.preview.channelNames.length" class="meta">频道：{{ props.state.preview.channelNames.slice(0, 24).join("、") }}</p>
      <ul v-if="props.state.preview.issues.length" class="live-issues" data-testid="live-import-issues">
        <li v-for="issue in props.state.preview.issues" :key="`${issue.line}-${issue.code}-${issue.message}`">第 {{ issue.line }} 行 · {{ issue.code }} · {{ issue.message }}</li>
      </ul>
      <div class="button-row">
        <button type="button" class="button-primary" data-action="live-source-apply" :disabled="props.pending !== null" @click="emit('apply', props.state.preview!.id)">确认导入</button>
        <button type="button" class="button-secondary" data-action="live-preview-clear" :disabled="props.pending !== null" @click="emit('clear')">清除预览</button>
      </div>
    </section>

    <section class="panel live-source-list" data-testid="live-source-list">
      <div class="panel-header">
        <div>
          <span class="section-kicker">已保存</span>
          <h2>直播源</h2>
        </div>
        <span class="meta">{{ props.state.sources.length }} 个来源</span>
      </div>
      <p v-if="props.state.sources.length === 0" class="meta">还没有已确认的直播源。</p>
      <article v-for="source in props.state.sources" :key="source.id" class="live-source-card" :data-source-id="source.id">
        <div>
          <h3>{{ source.name }}</h3>
          <p class="meta">{{ sourceLabel(source.type) }} · {{ source.location }}</p>
          <p class="meta">{{ source.channelCount }} 个频道 · {{ source.groupCount }} 个分组 · {{ source.streamCount }} 条线路 · {{ formatTime(source.lastSuccessAt) }}</p>
          <p v-if="source.lastError" class="error-message">最近刷新失败：{{ source.lastError }}</p>
        </div>
        <div class="button-row">
          <button type="button" class="button-secondary" data-action="live-source-toggle" :disabled="props.pending !== null" @click="emit('toggle', { sourceId: source.id, enabled: !source.enabled })">{{ source.enabled ? "停用" : "启用" }}</button>
          <button type="button" class="button-secondary" data-action="live-source-refresh" :disabled="props.pending !== null || !source.enabled" @click="emit('refresh', source.id)">刷新</button>
          <button type="button" class="text-button" data-action="live-source-remove" :disabled="props.pending !== null" @click="emit('remove', source.id)">移除</button>
        </div>
      </article>
    </section>
  </div>
</template>
