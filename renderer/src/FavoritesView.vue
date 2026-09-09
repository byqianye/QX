<script setup lang="ts">
import { computed, ref, watch } from "vue";

import Icon from "./Icon.vue";
import PosterImage from "./PosterImage.vue";
import type {
  FavoriteGroupItem,
  FavoriteItem,
  FavoritesUiState,
} from "../../src/favorites/favorites-types.js";

const props = defineProps<{
  state: FavoritesUiState;
  pending: string | null;
}>();

const emit = defineEmits<{
  open: [favoriteId: string];
  delete: [favoriteId: string];
  move: [payload: { favoriteId: string; groupId: string }];
  reorder: [payload: { groupId: string; favoriteIds: string[] }];
  createGroup: [name: string];
  renameGroup: [payload: { groupId: string; name: string }];
  deleteGroup: [payload: { groupId: string; disposition?: "default" | "delete" }];
  reorderGroups: [groupIds: string[]];
  search: [query: string];
}>();

const query = ref("");
const selectedGroupId = ref(props.state.defaultGroupId);
const sort = ref<"manual" | "added" | "title" | "recent">("manual");
const layout = ref<"grid" | "list">("grid");
const newGroupName = ref("");
const renameValue = ref("");
const confirmation = ref<{ kind: "favorite" | "group"; id: string; count: number } | null>(null);

watch(() => props.state.groups, (groups) => {
  if (!groups.some((group) => group.groupId === selectedGroupId.value)) {
    selectedGroupId.value = groups[0]?.groupId ?? props.state.defaultGroupId;
  }
}, { deep: true, immediate: true });

const selectedGroup = computed(() => props.state.groups.find((group) => group.groupId === selectedGroupId.value) ?? null);
const groupItems = computed(() => props.state.items.filter((item) => item.groupId === selectedGroupId.value));
const visibleItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return groupItems.value
    .filter((item) => !needle || `${item.title} ${item.category ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => {
      if (sort.value === "title") return left.title.localeCompare(right.title) || right.updatedAt - left.updatedAt;
      if (sort.value === "added") return right.addedAt - left.addedAt;
      if (sort.value === "recent") return (right.recentWatchedAt ?? 0) - (left.recentWatchedAt ?? 0) || right.updatedAt - left.updatedAt;
      return left.sortOrder - right.sortOrder;
    });
});

function selectGroup(groupId: string): void {
  selectedGroupId.value = groupId;
  renameValue.value = props.state.groups.find((group) => group.groupId === groupId)?.name ?? "";
}

function createGroup(): void {
  const name = newGroupName.value.trim();
  if (!name) return;
  emit("createGroup", name);
  newGroupName.value = "";
}

function renameGroup(): void {
  if (!selectedGroup.value || selectedGroup.value.groupId === props.state.defaultGroupId) return;
  const name = renameValue.value.trim();
  if (name) emit("renameGroup", { groupId: selectedGroup.value.groupId, name });
}

function requestDeleteFavorite(item: FavoriteItem): void {
  confirmation.value = { kind: "favorite", id: item.favoriteId, count: 0 };
}

function requestDeleteGroup(group: FavoriteGroupItem): void {
  if (group.groupId === props.state.defaultGroupId) return;
  confirmation.value = { kind: "group", id: group.groupId, count: group.count };
}

function confirmDelete(disposition?: "default" | "delete"): void {
  const action = confirmation.value;
  confirmation.value = null;
  if (!action) return;
  if (action.kind === "favorite") emit("delete", action.id);
  else emit("deleteGroup", { groupId: action.id, disposition });
}

function reorderFavorite(item: FavoriteItem, delta: -1 | 1): void {
  const items = [...groupItems.value];
  const index = items.findIndex((entry) => entry.favoriteId === item.favoriteId);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= items.length) return;
  [items[index], items[next]] = [items[next]!, items[index]!];
  emit("reorder", { groupId: selectedGroupId.value, favoriteIds: items.map((entry) => entry.favoriteId) });
}

function reorderGroup(group: FavoriteGroupItem, delta: -1 | 1): void {
  const groups = [...props.state.groups];
  const index = groups.findIndex((entry) => entry.groupId === group.groupId);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= groups.length) return;
  [groups[index], groups[next]] = [groups[next]!, groups[index]!];
  emit("reorderGroups", groups.map((entry) => entry.groupId));
}

function formatAddedAt(value: number): string {
  return value > 0 ? new Date(value).toLocaleDateString() : "时间未知";
}
</script>

<template>
  <section class="favorites-page" data-testid="favorites-page" data-od-id="favorites-page">
    <div class="favorites-layout">
      <aside class="panel favorites-groups" aria-label="收藏分组">
        <div class="favorites-groups-heading">
          <div>
            <span class="section-kicker">组织收藏</span>
            <h2>分组</h2>
          </div>
        </div>
        <div class="favorites-group-list" data-testid="favorite-groups">
          <div v-for="(group, index) in props.state.groups" :key="group.groupId" class="favorites-group-row">
            <button
              type="button"
              class="favorites-group-button"
              :class="{ selected: selectedGroupId === group.groupId }"
              :disabled="props.pending !== null"
              @click="selectGroup(group.groupId)"
            >
              <span>{{ group.name }}</span><span class="favorites-group-count">{{ group.count }}</span>
            </button>
            <div class="favorites-group-order">
              <button type="button" class="icon-button" aria-label="分组上移" title="分组上移" :disabled="props.pending !== null || index === 0" @click="reorderGroup(group, -1)"><Icon name="chevron-up" /></button>
              <button type="button" class="icon-button" aria-label="分组下移" title="分组下移" :disabled="props.pending !== null || index === props.state.groups.length - 1" @click="reorderGroup(group, 1)"><Icon name="chevron-down" /></button>
            </div>
          </div>
        </div>
        <div class="favorites-group-create">
          <input v-model="newGroupName" type="text" maxlength="64" placeholder="新分组名称" data-testid="favorite-group-name" />
          <button type="button" class="button-secondary" data-action="favorite-group-create" :disabled="props.pending !== null || newGroupName.trim() === ''" @click="createGroup">新建分组</button>
        </div>
      </aside>

      <section class="favorites-content">
        <section class="panel favorites-toolbar" aria-label="收藏筛选">
          <label class="favorites-search">
            <span>搜索收藏</span>
            <input v-model="query" type="search" placeholder="搜索标题或分类" data-testid="favorites-search" />
          </label>
          <label>
            <span>排序</span>
            <select v-model="sort" data-testid="favorites-sort">
              <option value="manual">手动排序</option>
              <option value="added">收藏时间</option>
              <option value="title">标题</option>
              <option value="recent">最近观看</option>
            </select>
          </label>
          <div class="favorites-layout-toggle" role="group" aria-label="布局">
            <button type="button" class="button-secondary" :class="{ selected: layout === 'grid' }" data-action="favorites-grid" @click="layout = 'grid'">网格</button>
            <button type="button" class="button-secondary" :class="{ selected: layout === 'list' }" data-action="favorites-list" @click="layout = 'list'">列表</button>
          </div>
        </section>

        <div class="favorites-heading">
          <div>
            <span class="section-kicker">收藏</span>
            <h2>{{ selectedGroup?.name ?? "收藏" }}</h2>
          </div>
          <div class="button-row">
            <input v-if="selectedGroup && selectedGroup.groupId !== props.state.defaultGroupId" v-model="renameValue" type="text" maxlength="64" aria-label="重命名分组" />
            <button v-if="selectedGroup && selectedGroup.groupId !== props.state.defaultGroupId" type="button" class="button-secondary" data-action="favorite-group-rename" :disabled="props.pending !== null || renameValue.trim() === ''" @click="renameGroup">重命名</button>
            <button v-if="selectedGroup && selectedGroup.groupId !== props.state.defaultGroupId" type="button" class="button-secondary" data-action="favorite-group-delete" :disabled="props.pending !== null" @click="requestDeleteGroup(selectedGroup)">删除分组</button>
          </div>
        </div>

        <section v-if="visibleItems.length > 0" class="favorites-list" :class="`favorites-list-${layout}`" data-testid="favorites-list">
          <article v-for="item in visibleItems" :key="item.favoriteId" class="panel favorite-item" :data-available="item.sourceAvailable">
            <div class="favorite-cover">
              <PosterImage
                :source="item.poster"
                :alt="`${item.title} 海报`"
                :fallback-text="item.title"
                loading="lazy"
              />
            </div>
            <div class="favorite-item-content">
              <div class="favorite-item-heading">
                <div>
                  <h3>{{ item.title }}</h3>
                </div>
                <span class="status-chip" :data-status="item.sourceAvailable ? 'success' : 'warning'">{{ item.sourceAvailable ? "可打开" : "需重新搜索" }}</span>
              </div>
              <p class="meta">{{ item.category ?? "未分类" }}<span v-if="item.year"> · {{ item.year }}</span> · 收藏于 {{ formatAddedAt(item.addedAt) }}</p>
              <p v-if="!item.sourceAvailable" class="favorite-unavailable">原来源不可用；收藏仍保留，可删除或搜索其他来源。</p>
              <div class="button-row">
                <button v-if="item.sourceAvailable" type="button" class="button-primary" data-action="favorite-open" :disabled="props.pending !== null" @click="emit('open', item.favoriteId)">打开详情</button>
                <button v-else type="button" class="button-secondary" data-action="favorite-search" :disabled="props.pending !== null" @click="emit('search', item.title)">搜索其他来源</button>
                <label class="favorite-move-control">
                  <span class="sr-only">移动分组</span>
                  <select :value="item.groupId ?? props.state.defaultGroupId" :disabled="props.pending !== null" data-action="favorite-move" @change="emit('move', { favoriteId: item.favoriteId, groupId: ($event.target as HTMLSelectElement).value })">
                    <option v-for="group in props.state.groups" :key="group.groupId" :value="group.groupId">移动到：{{ group.name }}</option>
                  </select>
                </label>
                <button type="button" class="button-secondary" data-action="favorite-up" :disabled="props.pending !== null || sort !== 'manual'" @click="reorderFavorite(item, -1)">上移</button>
                <button type="button" class="button-secondary" data-action="favorite-down" :disabled="props.pending !== null || sort !== 'manual'" @click="reorderFavorite(item, 1)">下移</button>
                <button type="button" class="button-secondary" data-action="favorite-delete" :disabled="props.pending !== null" @click="requestDeleteFavorite(item)">取消收藏</button>
              </div>
            </div>
          </article>
        </section>
        <section v-else class="state-card empty-state" data-testid="favorites-empty">
          <span class="state-mark">—</span>
          <h3>这个分组还没有收藏</h3>
          <p>在媒体详情中点击“收藏”，或搜索其他来源。</p>
        </section>
      </section>
    </div>

    <div v-if="confirmation" class="dialog-backdrop" role="presentation">
      <section class="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="favorite-confirm-title" data-testid="favorite-confirm">
        <span class="section-kicker">请确认</span>
        <h2 id="favorite-confirm-title">{{ confirmation.kind === "favorite" ? "取消收藏？" : "删除分组？" }}</h2>
        <p v-if="confirmation.kind === 'favorite'">取消后不会影响历史记录。</p>
        <template v-else-if="confirmation.count > 0">
          <p>这个分组还有 {{ confirmation.count }} 条收藏。</p>
          <div class="button-row">
            <button type="button" class="button-secondary" @click="confirmDelete('default')">移到默认组并删除分组</button>
            <button type="button" class="button-primary" @click="confirmDelete('delete')">删除收藏并删除分组</button>
          </div>
        </template>
        <div v-if="confirmation.kind === 'favorite' || confirmation.count === 0" class="button-row">
          <button type="button" class="button-secondary" @click="confirmation = null">取消</button>
          <button type="button" class="button-primary" data-action="favorite-confirm" @click="confirmDelete()">确认</button>
        </div>
        <button v-else type="button" class="text-button" @click="confirmation = null">取消</button>
      </section>
    </div>
  </section>
</template>
