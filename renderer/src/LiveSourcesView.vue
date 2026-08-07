<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import type { PlayerMediaSync, PlayerState } from "./state.js";
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
  play: [channelId: string, streamId?: string];
  line: [streamId: string];
  stop: [];
  sync: [value: PlayerMediaSync];
}>();

const name = ref("我的直播源");
const sourceType = ref<"m3u-url" | "m3u-file" | "txt-url" | "txt-file">("m3u-url");
const location = ref("");
const fileName = ref("");
const fileContent = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const localError = ref<string | null>(null);
const selectedGroupId = ref("__all__");
const focusedChannelIndex = ref(0);
const channelWindow = ref(40);

const filteredChannels = computed(() => {
  if (selectedGroupId.value === "__all__") return props.state.catalog.channels;
  if (selectedGroupId.value === "__ungrouped__") {
    return props.state.catalog.channels.filter((channel) => !channel.group);
  }
  return props.state.catalog.channels.filter((channel) => channel.group === selectedGroupId.value);
});

const visibleChannels = computed(() => filteredChannels.value.slice(0, channelWindow.value));
const livePlayerState = computed(() => props.state.player as PlayerState | null);
const selectedChannel = computed(() => {
  const id = props.state.session?.channelId;
  return props.state.catalog.channels.find((channel) => channel.id === id) ?? null;
});

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

function playChannel(channelId: string, streamId?: string): void {
  const index = filteredChannels.value.findIndex((channel) => channel.id === channelId);
  if (index >= 0) focusedChannelIndex.value = index;
  emit("play", channelId, streamId);
}

function chooseGroup(groupId: string): void {
  selectedGroupId.value = groupId;
  focusedChannelIndex.value = 0;
  channelWindow.value = 40;
}

function handleChannelScroll(event: Event): void {
  const element = event.currentTarget as HTMLElement;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 120) {
    channelWindow.value = Math.min(filteredChannels.value.length, channelWindow.value + 40);
  }
}

function handleChannelKeydown(event: KeyboardEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
  if (filteredChannels.value.length === 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    focusedChannelIndex.value = Math.max(0, Math.min(filteredChannels.value.length - 1, focusedChannelIndex.value + delta));
    channelWindow.value = Math.max(channelWindow.value, focusedChannelIndex.value + 1);
    const channel = filteredChannels.value[focusedChannelIndex.value];
    if (channel) {
      [...document.querySelectorAll<HTMLElement>("[data-channel-id]")]
        .find((element) => element.dataset.channelId === channel.id)
        ?.focus();
    }
  } else if (event.key === "Enter") {
    const channel = filteredChannels.value[focusedChannelIndex.value];
    if (channel) {
      event.preventDefault();
      playChannel(channel.id);
    }
  }
}

onMounted(() => window.addEventListener("keydown", handleChannelKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", handleChannelKeydown));
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

    <section class="live-browser" data-testid="live-browser">
      <aside class="panel live-channel-groups" data-testid="live-channel-groups">
        <div class="panel-header">
          <div>
            <span class="section-kicker">频道目录</span>
            <h2>分组</h2>
          </div>
        </div>
        <p v-if="props.state.catalog.channels.length === 0" class="meta">启用直播源后，这里会显示频道。</p>
        <button
          v-for="group in props.state.catalog.groups"
          :key="group.id"
          type="button"
          class="live-group-button"
          :class="{ selected: group.id === selectedGroupId }"
          :data-action="`live-group-${group.id}`"
          @click="chooseGroup(group.id)"
        >
          <span>{{ group.name }}</span><small>{{ group.channelCount }}</small>
        </button>
      </aside>

      <section class="live-channel-workspace">
        <div class="panel live-channel-list-panel">
          <div class="panel-header">
            <div>
              <span class="section-kicker">频道</span>
              <h2>{{ filteredChannels.length }} 个频道</h2>
            </div>
            <span class="meta">窗口显示 {{ visibleChannels.length }} 个</span>
          </div>
          <div
            class="live-channel-list"
            data-testid="live-channel-list"
            :data-rendered-count="visibleChannels.length"
            @scroll="handleChannelScroll"
          >
            <button
              v-for="channel in visibleChannels"
              :key="channel.id"
              type="button"
              class="live-channel-row"
              :class="{ selected: channel.id === props.state.session?.channelId }"
              :data-channel-id="channel.id"
              :disabled="props.pending !== null"
              @click="playChannel(channel.id)"
            >
              <span class="live-channel-logo">
                <img v-if="channel.logo" :src="channel.logo" :alt="`${channel.name} logo`" loading="lazy" />
                <span v-else aria-hidden="true">{{ channel.name.slice(0, 1) }}</span>
              </span>
              <span class="live-channel-copy">
                <strong>{{ channel.name }}</strong>
                <small v-if="channel.currentProgramme" data-testid="live-current-programme">节目单：{{ channel.currentProgramme.title }} · {{ Math.round((channel.currentProgramme.progress ?? 0) * 100) }}%</small>
                <small v-else data-testid="live-current-programme">节目单：暂无 · {{ channel.epgStatus }}</small>
                <small v-if="channel.nextProgramme">下一档：{{ channel.nextProgramme.title }}</small>
                <small>{{ channel.sourceName }} · {{ channel.group || "未分组" }}</small>
                <small>线路：{{ channel.streamCount }} 条 · EPG：{{ channel.epgStatus }}</small>
              </span>
              <span v-if="channel.streamCount > 1" class="status-chip">{{ channel.streamCount }} 线路</span>
            </button>
            <p v-if="visibleChannels.length === 0" class="meta">当前分组没有可用频道。</p>
          </div>
        </div>

        <section class="panel live-player-panel" data-testid="live-player-panel">
          <div class="panel-header">
            <div>
              <span class="section-kicker">直播播放</span>
              <h2>{{ selectedChannel?.name ?? "选择频道" }}</h2>
              <p v-if="selectedChannel" class="meta">{{ selectedChannel.sourceName }} · 节目单：暂无</p>
            </div>
            <span v-if="props.state.session" class="status-chip" :data-status="props.state.session.state">{{ props.state.session.state }}</span>
          </div>
          <EmbeddedPlayer
            v-if="livePlayerState"
            :state="livePlayerState"
            :detachable="false"
            @stop="emit('stop')"
            @sync="emit('sync', $event)"
          />
          <p v-else class="meta">从左侧选择频道开始播放。</p>
          <p v-if="props.state.session?.error" class="error-message" data-testid="live-playback-error">
            {{ props.state.session.error.code }}：{{ props.state.session.error.message }}
          </p>
          <div v-if="selectedChannel && selectedChannel.streams.length > 0" class="live-line-row" data-testid="live-line-selector">
            <span class="meta">线路</span>
            <button
              v-for="stream in selectedChannel.streams"
              :key="stream.id"
              type="button"
              class="button-secondary"
              :class="{ selected: stream.id === props.state.session?.streamId }"
              :disabled="props.pending !== null || stream.status === 'unsupported'"
              :data-stream-id="stream.id"
              @click="emit('line', stream.id)"
            >
              {{ stream.label }} · {{ stream.protocol }}
            </button>
          </div>
        </section>

        <section class="panel live-recent-panel" data-testid="live-recent-channels">
          <div class="panel-header"><h2>最近频道</h2><span class="meta">仅保存频道标识与时间</span></div>
          <button
            v-for="recent in props.state.catalog.recent"
            :key="`${recent.sourceId}:${recent.channelId}`"
            type="button"
            class="text-button live-recent-button"
            @click="playChannel(recent.channelId, recent.lastStreamId ?? undefined)"
          >{{ recent.channelName }} · {{ recent.sourceName }} · {{ formatTime(recent.lastPlayedAt) }}</button>
          <p v-if="props.state.catalog.recent.length === 0" class="meta">还没有播放记录。</p>
        </section>
      </section>
    </section>
  </div>
</template>
