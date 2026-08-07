<script setup lang="ts">
import { ref } from "vue";

import type { EpgSourceType, EpgUiState } from "../../src/epg/epg-types.js";

const props = defineProps<{
  state: EpgUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  preview: [input: Record<string, unknown>];
  apply: [previewId: string];
  refresh: [sourceId: string];
  toggle: [payload: { sourceId: string; enabled: boolean }];
  remove: [sourceId: string];
  clear: [];
  mappingConfirm: [payload: { liveChannelId: string; epgSourceId: string; epgChannelId: string }];
  mappingClear: [payload: { liveChannelId: string; epgSourceId?: string }];
  mappingConfirmHigh: [];
  aliasSet: [payload: { liveChannelId: string; alias: string }];
  aliasRemove: [payload: { liveChannelId: string; alias: string }];
}>();

const name = ref("我的 EPG");
const type = ref<"xmltv-url" | "xmltv-file">("xmltv-url");
const location = ref("");
const fileName = ref("");
const fileContent = ref<string | null>(null);
const localError = ref<string | null>(null);
const aliasDraft = ref<Record<string, string>>({});

function readFile(event: Event): void {
  localError.value = null;
  fileContent.value = null;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  fileName.value = file.name;
  void file.text().then((value) => { fileContent.value = value; }).catch(() => { localError.value = "读取 EPG 文件失败。"; });
}

function preview(): void {
  localError.value = null;
  const trimmedName = name.value.trim();
  if (!trimmedName) { localError.value = "请填写 EPG 名称。"; return; }
  if (type.value === "xmltv-file") {
    if (!fileContent.value) { localError.value = "请选择 XMLTV 文件。"; return; }
    emit("preview", { name: trimmedName, type: type.value, fileName: fileName.value || "epg.xml", content: fileContent.value });
    return;
  }
  if (!location.value.trim()) { localError.value = "请填写 XMLTV URL。"; return; }
  emit("preview", { name: trimmedName, type: type.value, location: location.value.trim() });
}

function sourceTypeLabel(value: EpgSourceType): string {
  return value === "xmltv-url" ? "XMLTV URL" : value === "xmltv-file" ? "XMLTV 文件" : "fixture";
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "未刷新";
}
function mappingStatusLabel(value: string): string {
  if (value === "mapped") return "已匹配";
  if (value === "suggested") return "待确认建议";
  if (value === "ambiguous") return "多候选冲突";
  if (value === "conflict") return "显式映射冲突";
  return "未匹配";
}

function aliasValue(liveChannelId: string): string {
  return aliasDraft.value[liveChannelId] ?? "";
}

function setAliasValue(liveChannelId: string, value: string): void {
  aliasDraft.value[liveChannelId] = value;
}

function saveAlias(liveChannelId: string): void {
  const alias = aliasValue(liveChannelId).trim();
  if (!alias) return;
  emit("aliasSet", { liveChannelId, alias });
  setAliasValue(liveChannelId, "");
}
</script>

<template>
  <section class="settings-section epg-management" data-testid="epg-sources" data-od-id="epg-management">
    <div>
      <span class="section-kicker">EPG</span>
      <h2>节目单来源</h2>
      <p class="meta">导入 XMLTV 节目单；当前版本只管理数据与来源，不自动匹配直播频道。</p>
    </div>
    <div class="button-row"><button type="button" class="button-primary" data-action="epg-source-preview" :disabled="props.pending !== null || props.state.loading" @click="preview">预览</button></div>
    <label class="settings-control"><span>名称</span><input v-model="name" type="text" maxlength="80" autocomplete="off" /></label>
    <label class="settings-control"><span>来源</span><select v-model="type"><option value="xmltv-url">XMLTV URL</option><option value="xmltv-file">XMLTV 文件</option></select></label>
    <label v-if="type === 'xmltv-url'" class="settings-control"><span>URL</span><input v-model="location" type="url" autocomplete="off" placeholder="https://example.invalid/guide.xml" /></label>
    <label v-else class="settings-control"><span>文件</span><input type="file" accept=".xml,.xmltv,.gz,application/xml,text/xml" @change="readFile" /></label>
    <p v-if="fileName" class="meta">已选择：{{ fileName }}</p>
    <p v-if="localError" class="error-message" data-testid="epg-local-error">{{ localError }}</p>
    <p v-if="props.state.error" class="error-message" data-testid="epg-error">{{ props.state.error.code }}：{{ props.state.error.message }}</p>
  </section>

  <section v-if="props.state.preview" class="panel epg-preview" data-testid="epg-preview">
    <div class="panel-header"><div><span class="section-kicker">导入预览</span><h2>{{ props.state.preview.source.name }}</h2></div><span class="status-chip">{{ props.state.preview.stats.programmeCount }} 个节目</span></div>
    <div class="settings-row"><span>频道 / 节目</span><strong>{{ props.state.preview.stats.channelCount }} / {{ props.state.preview.stats.programmeCount }}</strong></div>
    <div class="settings-row"><span>无效条目</span><strong>{{ props.state.preview.stats.invalidCount }}</strong></div>
    <p v-if="props.state.preview.channelNames.length" class="meta">频道：{{ props.state.preview.channelNames.slice(0, 24).join("、") }}</p>
    <div class="button-row"><button type="button" class="button-primary" data-action="epg-source-apply" :disabled="props.pending !== null" @click="emit('apply', props.state.preview!.id)">确认导入</button><button type="button" class="button-secondary" data-action="epg-preview-clear" :disabled="props.pending !== null" @click="emit('clear')">清除预览</button></div>
  </section>

  <section class="panel epg-source-list" data-testid="epg-source-list">
    <div class="panel-header"><div><span class="section-kicker">已保存</span><h2>EPG 来源</h2></div><span class="meta">{{ props.state.sources.length }} 个来源</span></div>
    <p v-if="props.state.sources.length === 0" class="meta">还没有已确认的 XMLTV 来源。</p>
    <article v-for="source in props.state.sources" :key="source.id" class="live-source-card" :data-epg-source-id="source.id">
      <div><h3>{{ source.name }}</h3><p class="meta">{{ sourceTypeLabel(source.type) }} · {{ source.location }}</p><p class="meta">{{ source.channelCount }} 个频道 · {{ source.programmeCount }} 个节目 · {{ formatTime(source.lastSuccessAt) }}</p><p v-if="source.lastError" class="error-message">最近刷新失败：{{ source.lastError }}</p></div>
      <div class="button-row"><button type="button" class="button-secondary" data-action="epg-source-toggle" :disabled="props.pending !== null" @click="emit('toggle', { sourceId: source.id, enabled: !source.enabled })">{{ source.enabled ? "停用" : "启用" }}</button><button type="button" class="button-secondary" data-action="epg-source-refresh" :disabled="props.pending !== null || !source.enabled" @click="emit('refresh', source.id)">刷新</button><button type="button" class="text-button" data-action="epg-source-remove" :disabled="props.pending !== null" @click="emit('remove', source.id)">移除</button></div>
    </article>
  </section>
  <section class="panel epg-mapping-list" data-testid="epg-mappings">
    <div class="panel-header">
      <div><span class="section-kicker">EPG Mapping</span><h2>频道匹配</h2></div>
      <button type="button" class="button-secondary" data-action="epg-mapping-confirm-high" :disabled="props.pending !== null" @click="emit('mappingConfirmHigh')">确认高置信度</button>
    </div>
    <p v-if="props.state.mappings.length === 0" class="meta">启用直播源后，这里会显示频道匹配建议。</p>
    <article v-for="mapping in props.state.mappings" :key="mapping.liveChannelId" class="epg-mapping-card" :data-live-channel-id="mapping.liveChannelId">
      <div class="panel-header">
        <div><h3>{{ mapping.liveChannelName }}</h3><p class="meta">{{ mapping.liveSourceName }} · {{ mappingStatusLabel(mapping.status) }}</p></div>
        <span class="status-chip" :data-status="mapping.status">{{ mapping.status }}</span>
      </div>
      <p v-if="mapping.mapping" class="meta">当前：{{ mapping.mappingSourceName }} · {{ mapping.mappingChannelName }} · {{ mapping.mapping.method }} / {{ mapping.mapping.confidence }}</p>
      <div v-if="mapping.aliases.length" class="epg-aliases">
        <span class="meta">Alias：{{ mapping.aliases.join("、") }}</span>
        <button
          v-for="alias in mapping.aliases"
          :key="alias"
          type="button"
          class="text-button"
          data-action="epg-alias-remove"
          :disabled="props.pending !== null"
          @click="emit('aliasRemove', { liveChannelId: mapping.liveChannelId, alias })"
        >移除 {{ alias }}</button>
      </div>
      <div v-if="mapping.candidates.length" class="button-row" data-testid="epg-mapping-suggestions">
        <button
          v-for="candidate in mapping.candidates"
          :key="`${candidate.epgSourceId}:${candidate.epgChannelId}`"
          type="button"
          class="button-secondary"
          data-action="epg-mapping-confirm"
          :disabled="props.pending !== null"
          @click="emit('mappingConfirm', { liveChannelId: mapping.liveChannelId, epgSourceId: candidate.epgSourceId, epgChannelId: candidate.epgChannelId })"
        >{{ candidate.epgSourceName }} · {{ candidate.epgChannelName }} · {{ candidate.confidence }}</button>
      </div>
      <div class="button-row">
        <input
          :value="aliasValue(mapping.liveChannelId)"
          type="text"
          maxlength="120"
          placeholder="添加 alias / call sign"
          @input="setAliasValue(mapping.liveChannelId, ($event.target as HTMLInputElement).value)"
        />
        <button type="button" class="button-secondary" data-action="epg-alias-save" :disabled="props.pending !== null" @click="saveAlias(mapping.liveChannelId)">保存 Alias</button>
        <button
          v-if="mapping.status === 'conflict' || mapping.mapping?.userConfirmed"
          type="button"
          class="text-button"
          data-action="epg-mapping-clear"
          :disabled="props.pending !== null"
          @click="emit('mappingClear', { liveChannelId: mapping.liveChannelId, ...(mapping.status === 'conflict' ? {} : { epgSourceId: mapping.mapping!.epgSourceId }) })"
        >清除匹配</button>
      </div>
    </article>
  </section>

  <section v-if="props.state.timeline" class="panel epg-timeline" data-testid="epg-timeline">
    <div class="panel-header"><div><span class="section-kicker">Programme Timeline</span><h2>节目时间线</h2></div><span class="meta">窗口 {{ formatTime(props.state.timeline.fromAt) }} — {{ formatTime(props.state.timeline.toAt) }}</span></div>
    <p v-if="props.state.timeline.items.length === 0" class="meta">当前窗口暂无节目。</p>
    <article v-for="item in props.state.timeline.items" :key="item.id" class="settings-row">
      <span>{{ formatTime(item.startAt) }} — {{ formatTime(item.endAt) }}</span>
      <strong>{{ item.title }}<small v-if="item.progress !== null"> · {{ Math.round(item.progress * 100) }}%</small></strong>
    </article>
  </section>
</template>
