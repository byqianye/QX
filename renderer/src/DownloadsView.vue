<script setup lang="ts">
import { computed, ref } from "vue";

import type { DownloadStatus, DownloadUiState } from "../../src/downloads/download-types.js";

const props = defineProps<{
  state: DownloadUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  selectFolder: [];
  add: [payload: { title: string; url: string; filename: string; targetDirectoryId: string }];
  refresh: [];
  pause: [taskId: string];
  resume: [taskId: string];
  cancel: [taskId: string];
  retry: [taskId: string];
  remove: [taskId: string];
  openFolder: [targetDirectoryId: string];
}>();

const tab = ref<"active" | "completed" | "failed">("active");
const title = ref("");
const url = ref("");
const filename = ref("");
const targetDirectoryId = ref("");

const activeStatuses: readonly DownloadStatus[] = ["queued", "starting", "downloading", "paused"];
const visibleTasks = computed(() => props.state.tasks.filter((task) => (
  tab.value === "active"
    ? activeStatuses.includes(task.status)
    : tab.value === "completed"
      ? task.status === "completed"
      : task.status === "failed" || task.status === "cancelled"
)));

function submit(): void {
  if (!url.value.trim() || !targetDirectoryId.value) return;
  emit("add", {
    title: title.value.trim(),
    url: url.value.trim(),
    filename: filename.value.trim(),
    targetDirectoryId: targetDirectoryId.value,
  });
  title.value = "";
  url.value = "";
  filename.value = "";
}

function formatBytes(value: number | null): string {
  if (value === null || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatSpeed(value: number | null): string {
  return value && value > 0 ? `${formatBytes(value)}/s` : "—";
}

function statusLabel(status: DownloadStatus): string {
  return {
    queued: "排队中",
    starting: "准备中",
    downloading: "下载中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    removed: "已移除",
  }[status];
}
</script>

<template>
  <section class="panel downloads-page" data-testid="downloads-page">
    <div class="panel-header">
      <div>
        <span class="section-kicker">aria2 下载任务管理</span>
        <h2>下载</h2>
        <p class="meta">只接受用户明确添加的 HTTP/HTTPS 文件地址；播放地址和 HLS 不会自动变成下载入口。</p>
      </div>
      <span class="status-chip" :data-status="props.state.aria2Available ? 'ready' : 'warning'">
        {{ props.state.aria2Available ? "aria2 已配置" : "aria2 未配置" }}
      </span>
    </div>

    <div class="settings-row download-folder-row">
      <div>
        <span>下载目录</span>
        <strong>{{ props.state.targetDirectories[0]?.displayName ?? "尚未选择" }}</strong>
      </div>
      <div class="button-row">
        <button type="button" class="button-secondary" data-action="download-select-folder" :disabled="props.pending !== null" @click="emit('selectFolder')">选择下载目录</button>
        <button type="button" class="button-secondary" data-action="download-refresh" :disabled="props.pending !== null" @click="emit('refresh')">刷新</button>
      </div>
    </div>

    <form class="download-add-form" data-testid="download-add-form" @submit.prevent="submit">
      <label class="settings-control"><span>标题</span><input v-model="title" data-action="download-title" maxlength="200" placeholder="可选" /></label>
      <label class="settings-control"><span>HTTP/HTTPS 地址</span><input v-model="url" data-action="download-url" type="url" required placeholder="https://example.test/file.mp4" /></label>
      <label class="settings-control"><span>文件名</span><input v-model="filename" data-action="download-filename" maxlength="180" placeholder="留空自动取名" /></label>
      <label class="settings-control"><span>目标目录</span><select v-model="targetDirectoryId" data-action="download-target" required>
        <option value="">请选择</option>
        <option v-for="directory in props.state.targetDirectories" :key="directory.id" :value="directory.id">{{ directory.displayName }}</option>
      </select></label>
      <button type="submit" class="button-primary" data-action="download-add" :disabled="props.pending !== null || !targetDirectoryId">添加下载</button>
    </form>

    <div v-if="props.state.error" class="error-state" data-testid="download-error">
      {{ props.state.error.code }} · {{ props.state.error.message }}
    </div>

    <div class="tab-row" role="tablist" aria-label="下载状态">
      <button type="button" :class="{ selected: tab === 'active' }" data-action="downloads-active" @click="tab = 'active'">进行中</button>
      <button type="button" :class="{ selected: tab === 'completed' }" data-action="downloads-completed" @click="tab = 'completed'">已完成</button>
      <button type="button" :class="{ selected: tab === 'failed' }" data-action="downloads-failed" @click="tab = 'failed'">失败</button>
    </div>

    <div v-if="visibleTasks.length === 0" class="empty-state" data-testid="downloads-empty">暂无任务</div>
    <div v-else class="download-list" data-testid="download-list">
      <article v-for="task in visibleTasks" :key="task.id" class="download-row" :data-status="task.status">
        <div class="download-row-main">
          <strong>{{ task.title }}</strong>
          <span class="meta">{{ task.suggestedFilename }} · {{ statusLabel(task.status) }}</span>
        </div>
        <div class="download-row-progress">
          <span>{{ formatBytes(task.completedBytes) }} / {{ formatBytes(task.totalBytes) }}</span>
          <span>{{ formatSpeed(task.speed) }}</span>
        </div>
        <div class="button-row">
          <button v-if="task.status === 'downloading' || task.status === 'starting' || task.status === 'queued'" type="button" class="text-button" :data-action="`download-pause-${task.id}`" @click="emit('pause', task.id)">暂停</button>
          <button v-else-if="task.status === 'paused'" type="button" class="text-button" :data-action="`download-resume-${task.id}`" @click="emit('resume', task.id)">继续</button>
          <button v-if="task.status === 'failed' || task.status === 'cancelled'" type="button" class="text-button" :data-action="`download-retry-${task.id}`" @click="emit('retry', task.id)">重试</button>
          <button v-if="task.status !== 'completed' && task.status !== 'removed'" type="button" class="text-button" :data-action="`download-cancel-${task.id}`" @click="emit('cancel', task.id)">取消</button>
          <button type="button" class="text-button" :data-action="`download-remove-${task.id}`" @click="emit('remove', task.id)">移除</button>
          <button type="button" class="text-button" :data-action="`download-open-folder-${task.id}`" @click="emit('openFolder', task.targetDirectoryId)">打开目录</button>
        </div>
      </article>
    </div>
  </section>
</template>
