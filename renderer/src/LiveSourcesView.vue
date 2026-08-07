<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import EmbeddedPlayer from "./EmbeddedPlayer.vue";
import type { PlayerMediaSync, PlayerState } from "./state.js";
import type {
  LiveSourceType,
  LiveUiState,
  SmartChannelSuggestionUiState,
  SmartChannelUiState,
} from "../../src/live/live-types.js";

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
  smartCreate: [payload: { name: string; group?: string | null; memberIds: string[] }];
  smartUpdate: [payload: { smartChannelId: string; name?: string; group?: string | null; sortOrder?: number }];
  smartDelete: [smartChannelId: string];
  smartAddMember: [payload: { smartChannelId: string; liveChannelId: string; priority?: number }];
  smartRemoveMember: [payload: { smartChannelId: string; memberId: string }];
  smartMemberUpdate: [payload: { smartChannelId: string; memberId: string; priority?: number; enabled?: boolean }];
  smartMemberReorder: [payload: { smartChannelId: string; memberIds: string[] }];
  smartSelect: [payload: { smartChannelId: string; memberId: string | null }];
  smartPlay: [payload: { smartChannelId: string; memberId?: string }];
  smartEpg: [payload: { smartChannelId: string; epgSourceId: string | null; epgChannelId: string | null }];
  failoverMode: [mode: "off" | "ask" | "auto"];
  failoverApprove: [];
  failoverCancel: [];
  failoverStay: [];
  failoverReturn: [];
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
const viewMode = ref<"sources" | "smart">("sources");
const smartName = ref("");
const smartGroup = ref("");
const selectedSmartMemberIds = ref<string[]>([]);
const renameValues = ref<Record<string, string>>({});
const liveDebugOpen = ref(true);

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

const selectedSmartChannels = computed(() => new Set(selectedSmartMemberIds.value));

function toggleSmartMember(channelId: string): void {
  const next = new Set(selectedSmartMemberIds.value);
  if (next.has(channelId)) next.delete(channelId);
  else next.add(channelId);
  selectedSmartMemberIds.value = [...next];
}

function createSmart(): void {
  localError.value = null;
  const trimmedName = smartName.value.trim();
  if (!trimmedName) {
    localError.value = "请填写 Smart Channel 名称。";
    return;
  }
  if (selectedSmartMemberIds.value.length < 2) {
    localError.value = "请至少选择两个来源频道后再合并。";
    return;
  }
  emit("smartCreate", {
    name: trimmedName,
    group: smartGroup.value.trim() || null,
    memberIds: [...selectedSmartMemberIds.value],
  });
  selectedSmartMemberIds.value = [];
  smartName.value = "";
}

function createSuggestion(suggestion: SmartChannelSuggestionUiState): void {
  emit("smartCreate", {
    name: suggestion.name,
    group: null,
    memberIds: [...suggestion.memberIds],
  });
}

function renameSmart(channel: SmartChannelUiState): void {
  const name = (renameValues.value[channel.id] ?? channel.name).trim();
  if (!name) return;
  emit("smartUpdate", { smartChannelId: channel.id, name });
}

function renameInput(smartChannelId: string, event: Event): void {
  renameValues.value[smartChannelId] = (event.target as HTMLInputElement).value;
}

function priorityChange(smartChannelId: string, memberId: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  emit("smartMemberUpdate", { smartChannelId, memberId, priority: Math.max(0, Math.floor(value)) });
}

function smartEpgOptions(channel: SmartChannelUiState): Array<{ sourceId: string; channelId: string; label: string }> {
  const options = new Map<string, { sourceId: string; channelId: string; label: string }>();
  for (const member of channel.members) {
    const mapping = props.state.epg.mappings.find((candidate) => candidate.liveChannelId === member.liveChannelId);
    if (mapping?.mapping && mapping.mappingSourceName && mapping.mappingChannelName) {
      const key = `${mapping.mapping.epgSourceId}|${mapping.mapping.epgChannelId}`;
      options.set(key, {
        sourceId: mapping.mapping.epgSourceId,
        channelId: mapping.mapping.epgChannelId,
        label: `${mapping.mappingSourceName} · ${mapping.mappingChannelName}`,
      });
    }
    for (const candidate of mapping?.candidates ?? []) {
      const key = `${candidate.epgSourceId}|${candidate.epgChannelId}`;
      options.set(key, {
        sourceId: candidate.epgSourceId,
        channelId: candidate.epgChannelId,
        label: `${candidate.epgSourceName} · ${candidate.epgChannelName}`,
      });
    }
  }
  if (channel.epg.sourceId && channel.epg.channelId && channel.epg.sourceName && channel.epg.channelName) {
    const key = `${channel.epg.sourceId}|${channel.epg.channelId}`;
    options.set(key, { sourceId: channel.epg.sourceId, channelId: channel.epg.channelId, label: `${channel.epg.sourceName} · ${channel.epg.channelName}` });
  }
  return [...options.values()];
}

function setSmartEpg(channel: SmartChannelUiState, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) {
    emit("smartEpg", { smartChannelId: channel.id, epgSourceId: null, epgChannelId: null });
    return;
  }
  const [epgSourceId, epgChannelId] = value.split("|", 2);
  if (!epgSourceId || !epgChannelId) return;
  emit("smartEpg", { smartChannelId: channel.id, epgSourceId, epgChannelId });
}

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

function metric(value: { value: number | boolean | null; samples: number }, suffix = ""): string {
  if (value.samples === 0 || value.value === null) return "unknown";
  return `${String(value.value)}${suffix}`;
}

function failoverCandidateLabel(candidate: LiveUiState["failover"]["current"]): string {
  if (!candidate) return "未知线路";
  return `${candidate.sourceName} · ${candidate.channelName} · ${candidate.streamLabel}`;
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
    <div class="live-mode-tabs" data-testid="live-mode-tabs" role="tablist" aria-label="频道视图">
      <button
        type="button"
        class="live-mode-tab"
        :class="{ selected: viewMode === 'sources' }"
        data-action="live-tab-sources"
        :aria-selected="viewMode === 'sources'"
        @click="viewMode = 'sources'"
      >Sources</button>
      <button
        type="button"
        class="live-mode-tab"
        :class="{ selected: viewMode === 'smart' }"
        data-action="live-tab-smart"
        :aria-selected="viewMode === 'smart'"
        @click="viewMode = 'smart'"
      >Smart Channels <span class="meta">{{ props.state.smartChannels.length }}</span></button>
    </div>

    <template v-if="viewMode === 'sources'">
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
          <section class="live-failover-panel" data-testid="live-failover-panel">
            <div class="panel-header">
              <div>
                <span class="section-kicker">播放健康</span>
                <h3>可解释故障转移</h3>
              </div>
              <label class="live-failover-mode">模式
                <select
                  data-action="live-failover-mode"
                  :value="props.state.failover.mode"
                  @change="emit('failoverMode', ($event.target as HTMLSelectElement).value as 'off' | 'ask' | 'auto')"
                >
                  <option value="off">关闭</option>
                  <option value="ask">询问</option>
                  <option value="auto">自动</option>
                </select>
              </label>
            </div>
            <p class="meta" data-testid="live-health-summary">
              评分 {{ props.state.health?.score ?? "unknown" }} · 首帧 {{ props.state.health ? metric(props.state.health.firstFrameMs, "ms") : "unknown" }} · 播放列表失败 {{ props.state.health ? metric(props.state.health.playlistRefreshFailure, " 次") : "unknown" }} · 分片失败 {{ props.state.health ? metric(props.state.health.segmentFailure, " 次") : "unknown" }} · 缓冲 {{ props.state.health ? metric(props.state.health.bufferCount, " 次") : "unknown" }}
            </p>
            <div v-if="props.state.failover.status !== 'idle' && props.state.failover.status !== 'disabled' && props.state.failover.status !== 'recovered'" class="live-failover-notice" data-testid="live-failover-prompt">
              <strong>{{ props.state.failover.status === 'prompt' ? '当前线路异常，需要确认' : '正在处理线路故障' }}</strong>
              <span>{{ props.state.failover.reason || props.state.failover.trigger || "直播播放异常" }}</span>
              <span v-if="props.state.failover.next">下一候选：{{ failoverCandidateLabel(props.state.failover.next) }}</span>
              <div class="button-row">
                <button v-if="props.state.failover.status === 'prompt'" type="button" class="button-primary" data-action="live-failover-approve" @click="emit('failoverApprove')">尝试下一条</button>
                <button v-if="props.state.failover.status === 'prompt' || props.state.failover.status === 'trying'" type="button" class="button-secondary" data-action="live-failover-cancel" @click="emit('failoverCancel')">取消</button>
                <button v-if="props.state.failover.status === 'prompt' || props.state.failover.status === 'trying'" type="button" class="button-secondary" data-action="live-failover-stay" @click="emit('failoverStay')">保持当前</button>
                <button v-if="props.state.failover.status === 'prompt'" type="button" class="text-button" data-action="live-failover-return" @click="emit('failoverReturn')">返回稳定线路</button>
                <button type="button" class="text-button" data-action="live-failover-debug" @click="liveDebugOpen = !liveDebugOpen">查看详情</button>
              </div>
            </div>
            <div v-if="liveDebugOpen" class="live-debug-panel" data-testid="live-debug-panel">
              <p>Live Session：{{ props.state.session?.sessionId ?? "none" }}</p>
              <p>Channel：{{ selectedChannel?.name ?? "none" }}</p>
              <p>Smart Channel：{{ props.state.session?.smartChannelId ?? "none" }}</p>
              <p>Member：{{ props.state.session?.smartMemberId ?? "none" }}</p>
              <p>Stream：{{ props.state.session?.streamId ?? "none" }}</p>
              <p>Health Score：{{ props.state.health?.score ?? "unknown" }}</p>
              <p>Failure：{{ props.state.failover.reason ?? "none" }}</p>
              <p>Failover attempts：{{ props.state.failover.attempts }} / {{ props.state.failover.maxAttempts }}</p>
              <p>Cooldown：{{ props.state.health?.cooldownUntil ?? "none" }}</p>
              <p>Manual override：{{ props.state.failover.manualOverrideUntil ?? "none" }}</p>
              <p v-if="props.state.health?.scoreReasons.length" class="meta">原因：{{ props.state.health.scoreReasons.join("；") }}</p>
            </div>
          </section>
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
    </template>

    <template v-else>
      <section class="settings-section smart-channel-create" data-testid="smart-channel-create">
        <div>
          <span class="section-kicker">用户控制</span>
          <h2>创建 Smart Channel</h2>
          <p class="meta">只合并你明确选择的来源频道；建议仅供确认，不会自动合并。</p>
        </div>
        <div class="smart-channel-form">
          <label class="settings-control"><span>名称</span><input v-model="smartName" type="text" maxlength="120" autocomplete="off" data-action="smart-name" /></label>
          <label class="settings-control"><span>分组</span><input v-model="smartGroup" type="text" maxlength="120" autocomplete="off" data-action="smart-group" /></label>
          <div class="smart-channel-picker" data-testid="smart-channel-picker">
            <span class="meta">选择来源频道（{{ selectedSmartMemberIds.length }}）</span>
            <label v-for="channel in props.state.catalog.channels" :key="channel.id" class="smart-channel-option">
              <input
                type="checkbox"
                :checked="selectedSmartChannels.has(channel.id)"
                :data-channel-id="channel.id"
                @change="toggleSmartMember(channel.id)"
              />
              <span>{{ channel.name }} · {{ channel.sourceName }}</span>
            </label>
            <p v-if="props.state.catalog.channels.length === 0" class="meta">暂无可用来源频道。</p>
          </div>
          <button type="button" class="button-primary" data-action="smart-channel-create" :disabled="props.pending !== null" @click="createSmart">创建</button>
        </div>
      </section>

      <section v-if="props.state.smartSuggestions.length" class="panel smart-channel-suggestions" data-testid="smart-channel-suggestions">
        <div class="panel-header"><div><span class="section-kicker">建议</span><h2>可合并的高置信频道</h2></div><span class="meta">请确认后创建</span></div>
        <article v-for="suggestion in props.state.smartSuggestions" :key="suggestion.id" class="smart-suggestion-row">
          <div><strong>{{ suggestion.name }}</strong><p class="meta">{{ suggestion.reason }} · {{ suggestion.confidence }} · {{ suggestion.memberIds.length }} 个来源</p></div>
          <button type="button" class="button-secondary" data-action="smart-suggestion-create" :data-suggestion-id="suggestion.id" :disabled="props.pending !== null" @click="createSuggestion(suggestion)">确认创建</button>
        </article>
      </section>

      <section class="panel smart-channel-list" data-testid="smart-channel-list">
        <div class="panel-header"><div><span class="section-kicker">频道集合</span><h2>Smart Channels</h2></div><span class="meta">{{ props.state.smartChannels.length }} 个</span></div>
        <p v-if="props.state.smartChannels.length === 0" class="meta">还没有 Smart Channel。可以从上方选择来源频道创建。</p>
        <article v-for="channel in props.state.smartChannels" :key="channel.id" class="smart-channel-card" :data-smart-channel-id="channel.id">
          <div class="smart-channel-card-header">
            <div>
              <h3>{{ channel.name }}</h3>
              <p class="meta">{{ channel.group || "未分组" }} · {{ channel.available ? "有可用来源" : "频道来源不可用" }} · {{ channel.members.length }} 个成员</p>
            </div>
            <span class="status-chip" :data-status="channel.available ? 'ready' : 'error'">{{ channel.available ? "可播放" : "不可用" }}</span>
          </div>
          <div class="smart-channel-actions">
            <input
              :value="renameValues[channel.id] ?? channel.name"
              type="text"
              maxlength="120"
              aria-label="Smart Channel 名称"
              @input="renameInput(channel.id, $event)"
            />
            <button type="button" class="button-secondary" data-action="smart-channel-rename" @click="renameSmart(channel)">重命名</button>
            <button type="button" class="text-button" data-action="smart-channel-delete" @click="emit('smartDelete', channel.id)">删除</button>
          </div>
          <div class="smart-channel-epg">
            <span class="meta">EPG：{{ channel.epg.channelName ? `${channel.epg.sourceName} · ${channel.epg.channelName}` : channel.epg.mode }}</span>
            <select :value="channel.epg.sourceId && channel.epg.channelId ? `${channel.epg.sourceId}|${channel.epg.channelId}` : ''" aria-label="Smart Channel EPG" @change="setSmartEpg(channel, $event)">
              <option value="">不指定 EPG</option>
              <option v-for="option in smartEpgOptions(channel)" :key="`${option.sourceId}|${option.channelId}`" :value="`${option.sourceId}|${option.channelId}`">{{ option.label }}</option>
            </select>
          </div>
          <div class="smart-channel-members">
            <div v-for="member in channel.members" :key="member.id" class="smart-channel-member" :class="{ unavailable: !member.available }">
              <div class="smart-channel-member-copy">
                <strong>{{ member.channelName }}</strong>
                <span class="meta">{{ member.sourceName }} · {{ member.available ? "可用" : "不可用" }} · 健康 {{ member.healthScore ?? "unknown" }}</span>
              </div>
              <label class="smart-priority"><span class="meta">优先级</span><input type="number" min="0" max="1000000" :value="member.priority" @change="priorityChange(channel.id, member.id, $event)" /></label>
              <button type="button" class="button-secondary" :disabled="props.pending !== null || !member.available" data-action="smart-channel-play" @click="emit('smartPlay', { smartChannelId: channel.id, memberId: member.id })">{{ channel.currentMemberId === member.id ? "当前来源" : "播放" }}</button>
              <button type="button" class="button-secondary" data-action="smart-channel-member-enable" @click="emit('smartMemberUpdate', { smartChannelId: channel.id, memberId: member.id, enabled: !member.enabled })">{{ member.enabled ? "停用成员" : "启用成员" }}</button>
              <button type="button" class="text-button" data-action="smart-channel-member-remove" @click="emit('smartRemoveMember', { smartChannelId: channel.id, memberId: member.id })">移除</button>
            </div>
            <p v-if="channel.members.length === 0" class="meta">暂无来源成员。添加来源频道后才能播放。</p>
          </div>
        </article>
      </section>
    </template>
  </div>
</template>
