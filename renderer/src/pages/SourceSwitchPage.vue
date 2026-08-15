<script setup lang="ts">
import { computed, inject } from "vue";

import EmptyState from "../EmptyState.vue";
import { useCoreRouteContext } from "../core-route-context.js";
import { sourceDisplayLabel, sourceDisplayStatus } from "../source-status.js";

const context = useCoreRouteContext(inject);
const state = context.state;
const pending = context.pending;
const sites = computed(() => context.state.value.import.sites);
const selectedKey = computed(() => context.state.value.import.selectedSiteKey);
const sourceId = computed(() => context.state.value.spider.sourceId);
const currentStatus = computed(() => sourceDisplayStatus({
  sessionReady: state.value.import.sessionReady,
  spiderStatus: state.value.spider.status,
  errorSource: state.value.error.error?.source,
}));

function statusFor(siteKey: string): "ready" | "error" | "unknown" {
  return siteKey === selectedKey.value ? currentStatus.value : "unknown";
}

function statusLabelFor(siteKey: string): string {
  return sourceDisplayLabel(statusFor(siteKey));
}

function chooseSource(): void {
  context.switchSource();
}

function selectSource(siteKey: string): void {
  if (siteKey === selectedKey.value || pending.value !== null) return;
  context.selectSource(siteKey);
}
</script>

<template>
  <section class="core-page source-switch-page" data-testid="core-source-switch-page">
    <header class="core-page-header">
      <div><span class="section-kicker">来源</span><h2>来源切换</h2><p class="meta">状态只显示当前后端已验证的信息。</p></div>
      <button type="button" class="button-secondary" data-action="core-source-home" @click="context.navigate('home')">返回首页</button>
    </header>

    <EmptyState v-if="sites.length === 0" title="暂无已导入来源" message="请先完成配置导入。" action-label="返回首页" @action="context.navigate('home')" />
    <div v-else class="source-card-grid">
        <article v-for="site in sites" :key="`${sourceId ?? 'unresolved'}-${site.key}`" class="panel source-card" :data-current="site.key === selectedKey">
        <div class="source-card-heading"><div><span class="section-kicker">媒体来源</span><h3>{{ site.name }}</h3></div><span class="status-chip" :data-status="statusFor(site.key)">{{ statusLabelFor(site.key) }}</span></div>
        <p class="meta">{{ site.key === selectedKey ? "当前来源" : "尚未验证" }}</p>
        <button
          v-if="site.key !== selectedKey"
          type="button"
          class="button-secondary"
          data-action="core-select-source"
          :disabled="pending !== null"
          @click="selectSource(site.key)"
        >选择来源</button>
      </article>
    </div>
    <button v-if="sites.length > 1" type="button" class="button-primary" data-action="core-source-switch" :disabled="pending !== null" @click="chooseSource">切换到下一个来源</button>
  </section>
</template>
