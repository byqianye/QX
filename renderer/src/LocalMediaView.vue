<script setup lang="ts">
import { computed, ref } from "vue";

import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import type { PlayerMediaSync, PlayerState } from "./state.js";
import type { DanmakuUiState } from "../../src/danmaku/danmaku-types.js";
import type { HistoryUiState } from "../../src/history/history-types.js";
import type { LocalMediaUiState } from "../../src/local-media/local-media-types.js";

const props = defineProps<{
  state: LocalMediaUiState;
  history: HistoryUiState;
  player: PlayerState;
  sessionId?: string | null;
  danmaku: DanmakuUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  openFile: [];
  addFolder: [];
  rescan: [rootId?: string];
  cancelScan: [rootId?: string];
  removeFolder: [rootId: string];
  removeItem: [itemId: string];
  removeHistory: [identity: string];
  locate: [itemId: string];
  play: [itemId: string, resume?: "continue" | "beginning"];
  drop: [paths: string[]];
  playerDetach: [];
  playerStop: [];
  playerSync: [value: PlayerMediaSync];
}>();

const query = ref("");
const section = ref<"continue" | "recent" | "folders" | "all">("all");
const resumeCandidate = ref<string | null>(null);

const localHistory = computed(() => props.history.items.filter((item) => item.sourceType === "local"));
const filteredItems = computed(() => {
  const text = query.value.trim().toLowerCase();
  const historyById = new Map(localHistory.value.map((item) => [item.vodId, item]));
  const items = props.state.items.filter((item) => {
    const history = historyById.get(item.id);
    if (section.value === "continue" && (!history || history.position <= 0 || history.completed)) return false;
    if (section.value === "recent" && !history) return false;
    if (section.value === "folders" && item.rootId === null) return false;
    return !text || item.displayName.toLowerCase().includes(text);
  });
  if (section.value === "recent") {
    items.sort((left, right) => (historyById.get(right.id)?.updatedAt ?? 0) - (historyById.get(left.id)?.updatedAt ?? 0));
  }
  return items;
});

const hasPlayback = computed(() => props.player.source !== null);

function play(itemId: string): void {
  const history = localHistory.value.find((candidate) => candidate.vodId === itemId);
  if (history && (history.position > 0 || history.completed)) {
    resumeCandidate.value = itemId;
    return;
  }
  emit("play", itemId);
}

function continueResume(): void {
  if (!resumeCandidate.value) return;
  emit("play", resumeCandidate.value, "continue");
  resumeCandidate.value = null;
}

function beginResume(): void {
  if (!resumeCandidate.value) return;
  emit("play", resumeCandidate.value, "beginning");
  resumeCandidate.value = null;
}

function localHistoryFor(itemId: string) {
  return localHistory.value.find((item) => item.vodId === itemId) ?? null;
}

function removeHistory(itemId: string): void {
  const history = localHistoryFor(itemId);
  if (history) emit("removeHistory", history.identity);
}

function dropFiles(event: DragEvent): void {
  const files = event.dataTransfer?.files;
  if (!files) return;
  const paths = [...files]
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  if (paths.length > 0) emit("drop", paths);
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <section class="local-media-page" data-testid="local-media-page">
    <section class="panel local-media-intro">
      <div>
        <span class="section-kicker">LOCAL MEDIA</span>
        <h2>本地媒体库</h2>
        <p class="meta">文件只在你选择的文件或目录范围内读取；媒体库不会替你搜索整台电脑。</p>
      </div>
      <div class="button-row">
        <button type="button" class="button-primary" data-action="local-open-file" :disabled="props.pending !== null" @click="emit('openFile')">打开文件</button>
        <button type="button" class="button-secondary" data-action="local-add-folder" :disabled="props.pending !== null" @click="emit('addFolder')">添加目录</button>
      </div>
    </section>

    <section
      class="panel local-media-dropzone"
      data-testid="local-media-dropzone"
      @dragover.prevent
      @drop.prevent="dropFiles"
    >
      <strong>将媒体文件拖到这里</strong>
      <span class="meta">只接受拖到 QX 窗口中的用户文件，不接受网页地址。</span>
    </section>

    <section class="local-media-toolbar">
      <div class="button-row">
        <button type="button" class="text-button" :class="{ selected: section === 'continue' }" @click="section = 'continue'">继续观看</button>
        <button type="button" class="text-button" :class="{ selected: section === 'recent' }" @click="section = 'recent'">最近播放</button>
        <button type="button" class="text-button" :class="{ selected: section === 'folders' }" @click="section = 'folders'">目录</button>
        <button type="button" class="text-button" :class="{ selected: section === 'all' }" @click="section = 'all'">全部媒体</button>
      </div>
      <input v-model="query" class="search-input" type="search" placeholder="搜索本地媒体" aria-label="搜索本地媒体" />
      <button type="button" class="button-secondary" data-action="local-rescan" :disabled="props.pending !== null" @click="emit('rescan')">重新扫描</button>
      <button v-if="props.state.scan.status === 'scanning'" type="button" class="button-secondary" data-action="local-cancel-scan" @click="emit('cancelScan')">取消扫描</button>
    </section>

    <section v-if="props.state.error" class="panel error-panel" data-testid="local-media-error">
      <strong>{{ props.state.error.code }}</strong><p>{{ props.state.error.message }}</p>
    </section>

    <section v-if="props.state.folders.length > 0" class="local-media-folders" data-testid="local-media-folders">
      <article v-for="folder in props.state.folders" :key="folder.id" class="panel local-folder-card">
        <div>
          <strong>{{ folder.displayName }}</strong>
          <span class="meta">{{ folder.itemCount }} 个媒体 · {{ folder.scanStatus }}</span>
        </div>
        <div class="button-row">
          <button type="button" class="text-button" @click="emit('rescan', folder.id)">扫描</button>
          <button type="button" class="text-button" @click="emit('removeFolder', folder.id)">移除目录</button>
        </div>
      </article>
    </section>

    <section v-if="filteredItems.length > 0" class="media-grid local-media-grid" data-testid="local-media-list">
      <article v-for="item in filteredItems" :key="item.id" class="media-card" :data-missing="String(item.missing)">
        <div class="media-card-body">
          <span class="section-kicker">{{ item.extension.toUpperCase() }}</span>
          <h3>{{ item.displayName }}</h3>
          <p class="meta">{{ formatBytes(item.size) }} · {{ item.missing ? "文件缺失" : item.mediaType }}</p>
          <div class="button-row">
            <button type="button" class="button-primary" :disabled="item.missing || props.pending !== null" @click="play(item.id)">播放</button>
            <button type="button" class="text-button" @click="emit('locate', item.id)">定位</button>
            <button type="button" class="text-button" @click="emit('removeItem', item.id)">移除</button>
            <button v-if="item.missing && localHistoryFor(item.id)" type="button" class="text-button" data-action="local-remove-history" @click="removeHistory(item.id)">移除记录</button>
          </div>
        </div>
      </article>
    </section>
    <section v-else class="panel empty-state" data-testid="local-media-empty">
      <h3>还没有本地媒体</h3>
      <p class="meta">打开一个文件或添加目录后，媒体会出现在这里。</p>
    </section>

    <section v-if="resumeCandidate" class="panel history-resume-prompt" data-testid="local-media-resume-prompt">
      <p>检测到上次播放进度，要继续播放吗？</p>
      <div class="button-row">
        <button type="button" class="button-primary" @click="continueResume">继续播放</button>
        <button type="button" class="button-secondary" @click="beginResume">从头播放</button>
      </div>
    </section>

    <section v-if="hasPlayback" class="playback-stage" data-testid="local-media-playback-stage">
      <EmbeddedPlayer
        :state="props.player"
        :session-id="props.sessionId"
        :danmaku="props.danmaku"
        @detach="emit('playerDetach')"
        @stop="emit('playerStop')"
        @sync="emit('playerSync', $event)"
      />
    </section>
  </section>
</template>
