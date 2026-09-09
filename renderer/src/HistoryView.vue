<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import type { HistoryItem, HistoryUiState } from "../../src/history/history-types.js";

const props = defineProps<{
  state: HistoryUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  open: [identity: string];
  delete: [identity: string];
  deleteProgress: [identity: string];
  clear: [identities: string[]];
  pause: [paused: boolean];
}>();

const query = ref("");
const filter = ref<"all" | "continue" | "completed">("all");
const sort = ref<"updated" | "title">("updated");
const selected = ref<string[]>([]);
const confirmation = ref<{ kind: "delete" | "progress" | "clear"; identities: string[] } | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

function onDialogKeydown(event: KeyboardEvent): void {
  if (!confirmation.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    confirmation.value = null;
    return;
  }
  if (event.key !== "Tab") return;
  const focusables = [cancelButton.value, confirmButton.value]
    .filter((element): element is HTMLButtonElement => element !== null);
  if (focusables.length === 0) return;
  const current = focusables.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.shiftKey
    ? (current - 1 + focusables.length) % focusables.length
    : (current + 1) % focusables.length;
  event.preventDefault();
  focusables[next]?.focus();
}

watch(confirmation, (action) => {
  if (action) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.addEventListener("keydown", onDialogKeydown);
    void nextTick(() => confirmButton.value?.focus());
  } else {
    window.removeEventListener("keydown", onDialogKeydown);
    previousFocus?.focus();
    previousFocus = null;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onDialogKeydown);
});

const visibleItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return [...props.state.items]
    .filter((item) => filter.value === "all"
      || (filter.value === "completed" && item.completed)
      || (filter.value === "continue" && !item.completed && item.position > 0))
    .filter((item) => !needle || `${item.title} ${item.episodeName ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => sort.value === "updated"
      ? right.updatedAt - left.updatedAt
      : left.title.localeCompare(right.title));
});

function formatPosition(item: HistoryItem): string {
  if (item.completed) return "已看完";
  if (item.duration <= 0) return item.position > 0 ? formatSeconds(item.position) : "尚未开始";
  return `${formatSeconds(item.position)} / ${formatSeconds(item.duration)}`;
}

function formatSeconds(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "时间未知";
  return new Date(value).toLocaleString();
}

function isSelected(identity: string): boolean {
  return selected.value.includes(identity);
}

function toggleSelected(identity: string): void {
  selected.value = isSelected(identity)
    ? selected.value.filter((value) => value !== identity)
    : [...selected.value, identity];
}

function requestDelete(identity: string): void {
  confirmation.value = { kind: "delete", identities: [identity] };
}

function requestDeleteProgress(identity: string): void {
  confirmation.value = { kind: "progress", identities: [identity] };
}

function requestClear(): void {
  const identities = selected.value.length > 0
    ? [...selected.value]
    : props.state.items.map((item) => item.identity);
  if (identities.length > 0) confirmation.value = { kind: "clear", identities };
}

function confirm(): void {
  const action = confirmation.value;
  confirmation.value = null;
  if (!action) return;
  if (action.kind === "delete") emit("delete", action.identities[0] ?? "");
  else if (action.kind === "progress") emit("deleteProgress", action.identities[0] ?? "");
  else emit("clear", action.identities);
  selected.value = selected.value.filter((identity) => !action.identities.includes(identity));
}
</script>

<template>
  <section class="history-page" data-testid="history-page" data-od-id="history-page">
    <section class="panel history-toolbar" aria-label="历史筛选">
      <label class="history-search">
        <span>搜索历史</span>
        <input v-model="query" type="search" placeholder="搜索标题或集数" data-testid="history-search" />
      </label>
      <label>
        <span>状态</span>
        <select v-model="filter" data-testid="history-filter">
          <option value="all">全部</option>
          <option value="continue">继续观看</option>
          <option value="completed">已看完</option>
        </select>
      </label>
      <label>
        <span>排序</span>
        <select v-model="sort" data-testid="history-sort">
          <option value="updated">最近更新</option>
          <option value="title">标题</option>
        </select>
      </label>
    </section>

    <section class="settings-section history-privacy" data-testid="history-privacy">
      <div>
        <h2>隐私与记录</h2>
        <p>暂停后不会为新的播放静默写入历史；已有记录会保留。</p>
      </div>
      <label class="settings-control">
        <span>{{ props.state.paused ? "已暂停记录" : "记录播放进度" }}</span>
        <input
          type="checkbox"
          :checked="!props.state.paused"
          :disabled="props.pending !== null"
          data-action="history-pause"
          @change="emit('pause', !($event.target as HTMLInputElement).checked)"
        />
      </label>
    </section>

    <div class="history-heading">
      <div>
        <span class="section-kicker">最近播放</span>
        <h2>历史记录</h2>
      </div>
      <div class="button-row">
        <button
          type="button"
          class="button-secondary"
          data-action="history-clear"
          :disabled="props.pending !== null || props.state.items.length === 0"
          @click="requestClear"
        >{{ selected.length > 0 ? `删除选中（${selected.length}）` : "清空全部" }}</button>
      </div>
    </div>

    <section v-if="visibleItems.length > 0" class="history-list" data-testid="history-list">
      <article v-for="item in visibleItems" :key="item.identity" class="panel history-item">
        <label class="history-select">
          <input
            type="checkbox"
            :checked="isSelected(item.identity)"
            :aria-label="`选择 ${item.title}`"
            @change="toggleSelected(item.identity)"
          />
        </label>
        <div class="history-item-cover" aria-hidden="true">{{ item.title.slice(0, 1) }}</div>
        <div class="history-item-content">
          <div class="history-item-heading">
            <div>
              <h3>{{ item.title }}</h3>
            </div>
            <span class="status-chip" :data-status="item.completed ? 'success' : 'ready'">{{ item.completed ? "已看完" : "继续观看" }}</span>
          </div>
          <p class="meta">{{ item.episodeName ?? (item.episode === null ? "当前集数" : `第 ${item.episode} 集`) }} · {{ formatPosition(item) }}</p>
          <p class="history-updated">{{ formatUpdatedAt(item.updatedAt) }}</p>
          <div class="button-row">
            <button type="button" class="button-primary" data-action="history-open" @click="emit('open', item.identity)">{{ item.completed ? "从头播放" : "继续播放" }}</button>
            <button v-if="!item.completed && item.position > 0" type="button" class="button-secondary" data-action="history-delete-progress" @click="requestDeleteProgress(item.identity)">删除进度</button>
            <button type="button" class="button-secondary" data-action="history-delete" @click="requestDelete(item.identity)">删除</button>
          </div>
        </div>
      </article>
    </section>
    <section v-else class="state-card empty-state" data-testid="history-empty">
      <span class="state-mark">—</span>
      <h3>暂无符合条件的历史</h3>
      <p>播放成功后，进度会出现在这里。</p>
    </section>

    <div v-if="confirmation" class="dialog-backdrop" role="presentation">
      <section class="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="history-confirm-title" data-testid="history-confirm">
        <span class="section-kicker">请确认</span>
        <h2 id="history-confirm-title">{{ confirmation.kind === "clear" ? "删除所选历史？" : confirmation.kind === "progress" ? "删除这条播放进度？" : "删除这条历史？" }}</h2>
        <p>{{ confirmation.kind === "clear" ? "删除后无法恢复播放进度。" : confirmation.kind === "progress" ? "历史记录会保留，但播放位置将清零。" : "这条历史及其播放进度会被删除。" }}</p>
        <div class="button-row">
          <button ref="cancelButton" type="button" class="button-secondary" @click="confirmation = null">取消</button>
          <button ref="confirmButton" type="button" class="button-primary" data-action="history-confirm" @click="confirm">确认删除</button>
        </div>
      </section>
    </div>
  </section>
</template>
