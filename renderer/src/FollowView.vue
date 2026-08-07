<script setup lang="ts">
import { computed, ref } from "vue";

import type { FollowItem, FollowUiState } from "../../src/follow/follow-types.js";

const props = defineProps<{
  state: FollowUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  refresh: [];
  open: [identity: string];
  delete: [identity: string];
  markWatched: [identity: string];
  markUnwatched: [identity: string];
}>();

const query = ref("");
const sort = ref<"updated" | "recent" | "title">("updated");
const deleting = ref<FollowItem | null>(null);

const visibleItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return [...props.state.items]
    .filter((item) => !needle || `${item.title} ${item.latestEpisodeName ?? ""} ${item.checkError ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => {
      if (sort.value === "title") return left.title.localeCompare(right.title) || (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0);
      if (sort.value === "recent") return (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0);
      return Number(right.updateAvailable) - Number(left.updateAvailable)
        || (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0)
        || left.title.localeCompare(right.title);
    });
});

function statusLabel(item: FollowItem): string {
  if (!item.sourceAvailable) return "来源不可用";
  if (item.status === "checking") return "检查中";
  if (item.status === "error") return "来源失败";
  return item.updateAvailable ? "有更新" : "已追平";
}

function statusKind(item: FollowItem): string {
  if (!item.sourceAvailable || item.status === "error") return "warning";
  if (item.status === "checking") return "loading";
  return item.updateAvailable ? "accent" : "success";
}

function formatCheckedAt(value: number | null): string {
  return value && value > 0 ? new Date(value).toLocaleString() : "尚未检查";
}

function episodeLabel(id: string | null, name: string | null): string {
  return name ?? id ?? "暂无集数信息";
}

function requestDelete(item: FollowItem): void {
  deleting.value = item;
}

function confirmDelete(): void {
  const item = deleting.value;
  deleting.value = null;
  if (item) emit("delete", item.identity);
}
</script>

<template>
  <section class="follow-page" data-testid="follow-page" data-od-id="follow-page">
    <section class="panel follow-toolbar" aria-label="追更筛选">
      <label class="follow-search">
        <span>搜索追更</span>
        <input v-model="query" type="search" placeholder="搜索标题或最新集" data-testid="follow-search" />
      </label>
      <label>
        <span>排序</span>
        <select v-model="sort" data-testid="follow-sort">
          <option value="updated">有更新优先</option>
          <option value="recent">最近更新</option>
          <option value="title">标题</option>
        </select>
      </label>
      <button type="button" class="button-primary" data-action="follow-refresh" :disabled="props.pending !== null || props.state.checking" @click="emit('refresh')">
        {{ props.state.checking ? "检查中…" : "手动刷新" }}
      </button>
    </section>

    <div class="follow-heading">
      <div>
        <span class="section-kicker">应用内提示</span>
        <h2>追更列表</h2>
      </div>
      <span class="status-chip" :data-status="props.state.updateCount > 0 ? 'accent' : 'success'">{{ props.state.updateCount }} 个有更新</span>
    </div>

    <section v-if="visibleItems.length > 0" class="follow-list" data-testid="follow-list">
      <article v-for="item in visibleItems" :key="item.identity" class="panel follow-item" :data-status="statusKind(item)">
        <div class="follow-cover" aria-hidden="true">
          <img v-if="item.poster" :src="item.poster" :alt="`${item.title} 海报`" />
          <span v-else>{{ item.title.slice(0, 1) }}</span>
        </div>
        <div class="follow-item-content">
          <div class="follow-item-heading">
            <div>
              <span class="context-kicker">{{ item.sourceAvailable ? "当前来源" : "原来源" }}</span>
              <h3>{{ item.title }}</h3>
            </div>
            <span class="status-chip" :data-status="statusKind(item)">{{ statusLabel(item) }}</span>
          </div>
          <p class="meta">最新：{{ episodeLabel(item.latestEpisodeId, item.latestEpisodeName) }} · 已看：{{ episodeLabel(item.watchedEpisodeId, item.watchedEpisodeName) }}</p>
          <p v-if="item.checkError" class="follow-error">{{ item.checkError }}</p>
          <p class="follow-checked">最后检查：{{ formatCheckedAt(item.lastCheckedAt) }}</p>
          <div class="button-row">
            <button v-if="item.sourceAvailable" type="button" class="button-primary" data-action="follow-open" :disabled="props.pending !== null" @click="emit('open', item.identity)">打开详情</button>
            <button v-if="item.latestEpisodeId || item.latestEpisodeName" type="button" class="button-secondary" :disabled="props.pending !== null || item.status === 'checking'" :data-action="item.updateAvailable ? 'follow-mark-watched' : 'follow-mark-unwatched'" @click="emit(item.updateAvailable ? 'markWatched' : 'markUnwatched', item.identity)">
              {{ item.updateAvailable ? "标记已看" : "标记未看" }}
            </button>
            <button type="button" class="button-secondary" data-action="follow-delete" :disabled="props.pending !== null" @click="requestDelete(item)">取消追更</button>
          </div>
        </div>
      </article>
    </section>
    <section v-else class="state-card empty-state" data-testid="follow-empty">
      <span class="state-mark">—</span>
      <h3>还没有追更内容</h3>
      <p>在详情页选择“追更”，更新会在这里显示。</p>
    </section>

    <div v-if="deleting" class="dialog-backdrop" role="presentation">
      <section class="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="follow-confirm-title" data-testid="follow-confirm">
        <span class="section-kicker">请确认</span>
        <h2 id="follow-confirm-title">取消追更？</h2>
        <p>取消后不会删除历史记录或收藏。</p>
        <div class="button-row">
          <button type="button" class="button-secondary" @click="deleting = null">取消</button>
          <button type="button" class="button-primary" data-action="follow-confirm" @click="confirmDelete">确认取消</button>
        </div>
      </section>
    </div>
  </section>
</template>
