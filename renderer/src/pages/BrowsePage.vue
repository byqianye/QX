<script setup lang="ts">
import { computed, inject } from "vue";
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
const query = computed(() => typeof route.query.q === "string" ? route.query.q : "");
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
const hero = computed(() => {
  if (page.value !== "home") return null;
  return items.value.find((item) => backdropFor(item) !== null) ?? null;
});
const heroSource = computed(() => hero.value ? backdropFor(hero.value) : null);
const continueItems = computed(() => state.value.history.items
  .filter((item) => item.sourceType !== "local" && !item.completed && item.position > 0 && item.vodId.trim().length > 0)
  .slice(0, 5));
const title = computed(() => page.value === "category" ? "分类浏览" : page.value === "search" ? "搜索结果" : "首页");
const status = computed(() => context.pending.value || context.state.value.browse.loading ? "正在读取内容" : "");

const categoryUnavailable = computed(() => page.value === "category" && state.value.spider.capabilities?.category === false);
const searchUnavailable = computed(() => page.value === "search" && state.value.spider.capabilities?.search === false);

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
    <header class="core-page-header">
      <div>
        <span class="section-kicker">{{ page === "search" ? "媒体检索" : "媒体工作台" }}</span>
        <h2>{{ title }}</h2>
        <p v-if="page === 'search' && query" class="meta">关键词：{{ query }}</p>
        <p v-else-if="status" class="meta loading">{{ status }}</p>
      </div>
      <button v-if="page === 'search'" type="button" class="button-secondary" data-action="core-clear-search" @click="context.navigate('home')">清除搜索</button>
    </header>

    <CategoryTabs :active="page" :category-available="state.spider.capabilities?.category ?? null" @select="selectTab" />

    <EmptyState
      v-if="categoryUnavailable"
      title="当前来源不支持分类浏览"
      message="请切换支持该能力的来源或返回首页。"
      action-label="返回首页"
      @action="context.navigate('home')"
    />

    <EmptyState
      v-else-if="searchUnavailable"
      title="当前来源不支持搜索"
      message="请切换支持搜索能力的来源，或返回首页。"
      action-label="返回首页"
      @action="context.navigate('home')"
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
      />
      <div class="core-hero-overlay">
        <span class="section-kicker">真实来源内容</span>
        <h3>{{ heroTitle() }}</h3>
        <p v-if="heroSummary()">{{ heroSummary() }}</p>
        <button type="button" class="button-primary" data-action="core-hero-detail" @click="openHero">查看详情</button>
      </div>
    </section>

    <section v-if="!categoryUnavailable && !searchUnavailable && page === 'home' && continueItems.length > 0" class="core-section continue-watching" data-testid="core-continue-watching">
      <div class="core-section-heading">
        <div><span class="section-kicker">观看进度</span><h3>继续观看</h3></div>
      </div>
      <div class="continue-grid">
        <button v-for="item in continueItems" :key="item.identity" type="button" class="continue-card" data-action="core-continue-detail" @click="context.openDetail(item.vodId)">
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
      <div><span class="section-kicker">真实来源列表</span><h3>推荐</h3></div>
    </div>

    <MediaGrid
      v-if="!categoryUnavailable && !searchUnavailable"
      :items="items"
      :loading="state.browse.loading || pending !== null"
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
      @back="context.navigate('home')"
      @settings="context.navigate('sources')"
    />
  </section>
</template>
