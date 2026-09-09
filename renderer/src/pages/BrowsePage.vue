<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { useRoute } from "vue-router";

import CategoryTabs from "../CategoryTabs.vue";
import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import MediaGrid from "../MediaGrid.vue";
import PosterImage from "../PosterImage.vue";
import { useCoreRouteContext } from "../core-route-context.js";
import type { HistoryItem } from "../../../src/history/history-types.js";

const route = useRoute();
const context = useCoreRouteContext(inject);
const state = context.state;
const pending = context.pending;

const page = computed<"home" | "category" | "search">(() => {
  if (route.name === "category") return "category";
  if (route.name === "search") return "search";
  return "home";
});
const activeTypeId = computed(() => typeof route.query.type === "string" ? route.query.type.trim() : "");
const activeFilters = computed<Record<string, string>>(() => {
  if (typeof route.query.filter !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(route.query.filter);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string"));
  } catch {
    return {};
  }
});
const items = computed(() => context.state.value.browse.items);
const categories = computed(() => context.state.value.browse.categories);
const filters = computed(() => context.state.value.browse.filters);
interface SearchSourceGroup {
  key: string;
  name: string;
  items: Record<string, unknown>[];
  status?: string;
  errorCode?: string;
}
const expandedSources = ref(new Set<string>());
watch(() => route.query.q, () => { expandedSources.value = new Set(); });
function toggleSource(key: string): void {
  const next = new Set(expandedSources.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedSources.value = next;
}
function sourceStatusLabel(status?: string, errorCode?: string): string {
  if (errorCode?.includes("CHALLENGE_REQUIRED")) return "此来源要求滑块验证，暂不能搜索";
  if (errorCode?.includes("AUTH_REQUIRED")) return "此来源需要登录";
  if (errorCode?.includes("TIMEOUT")) return "查询超时，下次搜索会重试";
  return ({ queued: "等待查询", running: "查询中", success: "已返回", empty: "没有匹配内容", failed: "连接失败，下次搜索会重试", unsupported: "当前安装不支持此源搜索", cancelled: "已取消" } as Record<string, string>)[status ?? ""] ?? "";
}

const searchSourceGroups = computed<SearchSourceGroup[]>(() => {
  if (page.value !== "search") return [];
  const sites = new Map(state.value.import.sites.map((site) => [site.key, site.name]));
  const groups = new Map<string, SearchSourceGroup>();
  for (const source of state.value.browse.searchProgress?.sources ?? []) groups.set(source.key, { key: source.key, name: source.name, status: source.status, ...(source.errorCode ? { errorCode: source.errorCode } : {}), items: [] });
  for (const item of items.value) {
    const sourceKeys = sourceKeysForItem(item);
    for (const sourceKey of sourceKeys) {
      const sourceName = sourceNameForItem(item, sourceKey, sites);
      const group = groups.get(sourceKey) ?? { key: sourceKey, name: sourceName, items: [] };
      const itemKey = searchItemKey(item);
      if (group.items.some((candidate) => searchItemKey(candidate) === itemKey)) continue;
      group.items.push(sourceKey === String(item.__qx_source_key ?? "")
        ? item
        : { ...item, __qx_source_key: sourceKey, __qx_source_name: sourceName });
      groups.set(sourceKey, group);
    }
  }
  return [...groups.values()];
});
const hero = computed(() => {
  if (page.value !== "home") return null;
  return items.value.find((item) => backdropFor(item) !== null) ?? null;
});
const heroSource = computed(() => hero.value ? backdropFor(hero.value) : null);
const continueItems = computed(() => {
  const latest = new Map<string, HistoryItem>();
  for (const item of state.value.history.items) {
    if (item.sourceType === "local" || item.completed || item.position <= 0 || !item.vodId.trim()) continue;
    const key = `${item.sourceId}:${item.vodId}`;
    const previous = latest.get(key);
    if (!previous || item.updatedAt > previous.updatedAt) latest.set(key, item);
  }
  return [...latest.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 5);
});
const status = computed(() => context.pending.value || context.state.value.browse.loading ? "正在读取内容" : "");

const categoryUnavailable = computed(() => page.value === "category" && state.value.spider.capabilities?.category === false);
const searchUnavailable = computed(() => page.value === "search" && state.value.import.sites.length < 2 && state.value.spider.capabilities?.search === false);

function progressPercent(item: HistoryItem): number {
  if (item.duration <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((item.position / item.duration) * 100)));
}

function backdropFor(item: Record<string, unknown>): string | null {
  const candidates = [item.vod_pic_slide, item.vod_pic_background, item.vod_pic_bg];
  const source = candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return source?.trim() ?? null;
}

function heroTitle(): string {
  return String(hero.value?.vod_name ?? "").trim();
}

function heroSummary(): string {
  return String(hero.value?.vod_blurb ?? hero.value?.vod_content ?? "").trim();
}

function openHero(): void {
  const id = String(hero.value?.vod_id ?? "").trim();
  if (id) context.openDetail(id);
}

function openContinue(identity: string): void {
  context.historyOpen(identity);
}

function sourceKeysForItem(item: Record<string, unknown>): string[] {
  const explicit = typeof item.__qx_source_key === "string" ? item.__qx_source_key.trim() : "";
  if (explicit) return [explicit];
  const sourceIds = Array.isArray(item.source_ids)
    ? item.source_ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : [];
  if (sourceIds.length > 0) return [...new Set(sourceIds)];
  return [state.value.import.selectedSiteKey ?? "current"];
}

function sourceNameForItem(item: Record<string, unknown>, sourceKey: string, sites: Map<string, string>): string {
  const explicit = typeof item.__qx_source_name === "string" ? item.__qx_source_name.trim() : "";
  return explicit || sites.get(sourceKey) || (sourceKey === "current" ? "当前来源" : sourceKey);
}

function searchItemKey(item: Record<string, unknown>): string {
  const title = normalizeSearchTitle(item.vod_name);
  if (title) return `title:${title}`;
  const id = String(item.vod_id ?? "").trim();
  return id ? `id:${id}` : "empty";
}

function normalizeSearchTitle(value: unknown): string {
  let title = String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:立刻播放|立即播放)\s*/u, "")
    .replace(/[\[【(（]\s*(?:4k|8k|高清|超清|蓝光|臻彩|原画|完整版|全集)\s*[\]】)）]/giu, "")
    .replace(/(?:\s*[\[【(（]?\s*(?:4k|8k|高清|超清|蓝光|臻彩|原画|完整版|全集)\s*[\]】)）]?)+$/giu, "")
    .replace(/[\s._·|\/\\-]*(?:19|20)\d{2}\s*$/u, "")
    .replace(/[\s._·|\/\\-]+/gu, "")
    .trim();
  return title;
}

function selectTab(value: "home" | "category"): void {
  context.navigate(value);
}

function selectCategory(typeId: string): void {
  context.selectCategory(typeId, activeFilters.value);
}

function updateFilter(filterId: string, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const next = { ...activeFilters.value };
  if (target.value) next[filterId] = target.value;
  else delete next[filterId];
  context.selectCategory(activeTypeId.value || categories.value[0]?.id || "", next);
}
</script>

<template>
  <section class="core-page browse-page" :data-route="page" data-testid="core-browse-page">
    <CategoryTabs :active="page" :category-available="state.spider.capabilities?.category ?? null" @select="selectTab" />

    <details
      v-if="state.spider.warning"
      class="source-warning"
      data-testid="source-warning"
      role="status"
    ><summary v-if="state.spider.warning === 'CONFIG_HTTP_UNAUTHENTICATED'">此来源使用 HTTP 连接</summary><p>{{ state.spider.warning }}</p></details>

    <EmptyState
      v-if="categoryUnavailable"
      title="当前来源不支持分类浏览"
      message="请切换支持该能力的来源。"
      :show-action="false"
    />

    <EmptyState
      v-else-if="searchUnavailable"
      title="当前来源不支持搜索"
      message="请切换支持搜索能力的来源。"
      :show-action="false"
    />

    <section v-if="!categoryUnavailable && !searchUnavailable && page === 'category' && categories.length > 0" class="category-capability-panel" data-testid="core-category-options">
      <div class="core-section-heading">
        <div><span class="section-kicker">来源返回的分类</span><h3>分类</h3></div>
        <span class="meta">{{ categories.length }} 个可用分类</span>
      </div>
      <div class="category-option-list" role="listbox" aria-label="来源分类">
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="category-option"
          :class="{ selected: activeTypeId === category.id }"
          :aria-selected="activeTypeId === category.id"
          :data-type-id="category.id"
          data-action="source-category"
          @click="selectCategory(category.id)"
        >{{ category.name }}</button>
      </div>
      <div v-if="filters.length > 0" class="category-filter-list" data-testid="core-category-filters">
        <label v-for="filter in filters" :key="filter.id" class="category-filter-control">
          <span>{{ filter.name }}</span>
          <select :value="activeFilters[filter.id] ?? ''" :aria-label="filter.name" :data-filter-id="filter.id" @change="updateFilter(filter.id, $event)">
            <option value="">全部</option>
            <option v-for="option in filter.options" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
        </label>
      </div>
    </section>

    <p v-if="!categoryUnavailable && !searchUnavailable && page === 'category' && categories.length === 0 && !status" class="meta category-capability-gap" data-testid="core-category-options-empty">当前来源没有返回可用分类选项。</p>

    <section v-if="hero && heroSource" class="core-hero" data-testid="core-hero">
      <PosterImage
        class="core-hero-image"
        :source="heroSource"
        :alt="`${heroTitle()} 背景`"
        :fallback-text="heroTitle()"
        test-id="core-hero-image"
        loading="eager"
        cache-type="backdrop"
      />
      <div class="core-hero-overlay">
        <span class="section-kicker">精选内容</span>
        <h3>{{ heroTitle() }}</h3>
        <p v-if="heroSummary()">{{ heroSummary() }}</p>
        <button type="button" class="button-primary" data-action="core-hero-detail" @click="openHero">查看详情</button>
      </div>
    </section>

    <section v-if="!categoryUnavailable && !searchUnavailable && page === 'home' && continueItems.length > 0" class="core-section continue-watching" data-testid="core-continue-watching">
      <div class="core-section-heading">
        <div><h3>继续观看</h3></div>
      </div>
      <div class="continue-grid">
        <button v-for="item in continueItems" :key="item.identity" type="button" class="continue-card" data-action="core-continue-detail" @click="openContinue(item.identity)">
          <span class="continue-card-cover">
            <PosterImage
              :source="item.poster"
              :alt="`${item.title} 海报`"
              :fallback-text="item.title"
              loading="lazy"
            />
          </span>
          <span class="continue-card-copy">
            <strong>{{ item.title }}</strong>
            <span>{{ item.episodeName || "继续观看" }}</span>
            <span class="continue-progress" aria-hidden="true"><span :style="{ width: `${progressPercent(item)}%` }" /></span>
          </span>
        </button>
      </div>
    </section>

    <div v-if="!categoryUnavailable && !searchUnavailable && page === 'home'" class="core-section-heading recommendation-heading" data-testid="core-recommendations">
      <div><h3>发现好内容</h3></div>
    </div>

    <template v-if="!categoryUnavailable && !searchUnavailable && page === 'search' && items.length > 0">
      <div class="search-source-results" data-testid="core-search-source-results">
        <section
          v-for="group in searchSourceGroups"
          :key="group.key"
          class="search-source-row"
          data-testid="core-search-source-row"
          :data-source-key="group.key"
        >
          <div class="core-section-heading search-source-row-heading">
            <div><span class="section-kicker">搜索来源</span><h3>{{ group.name }}</h3></div>
            <span class="meta">{{ group.items.length }} 条结果</span>
          </div>
          <MediaGrid
            v-if="group.items.length > 0"
            :items="expandedSources.has(group.key) ? group.items : group.items.slice(0, 5)"
            :loading="false"
      :failed="Boolean(state.error.error)"
            :page="page"
            :playing-id="state.detail.detail?.vod_id ? String(state.detail.detail.vod_id) : null"
            @detail="context.openDetail"
            @home="context.navigate('home')"
            @clear-search="context.navigate('home')"
          />
          <p class="meta" :data-source-status="group.status">{{ sourceStatusLabel(group.status, group.errorCode) }}</p>
          <button v-if="group.items.length > 5" type="button" class="button-secondary" data-action="expand-source-results" @click="toggleSource(group.key)">{{ expandedSources.has(group.key) ? "收起" : `查看全部 ${group.items.length} 条` }}</button>
        </section>
      </div>
    </template>
    <MediaGrid
      v-else-if="!categoryUnavailable && !searchUnavailable"
      :items="items"
      :loading="state.browse.loading"
      :failed="Boolean(state.error.error)"
      :page="page"
      :playing-id="state.detail.detail?.vod_id ? String(state.detail.detail.vod_id) : null"
      @detail="context.openDetail"
      @home="context.navigate('home')"
      @clear-search="context.navigate('home')"
    />

    <ErrorState
      v-if="state.error.error"
      :error="state.error.error"
      :show-technical="false"
      :pending="pending !== null"
      @retry="context.retry"
      @switch-line="context.switchSource"
      @settings="context.navigate('sources')"
    />
  </section>
</template>
