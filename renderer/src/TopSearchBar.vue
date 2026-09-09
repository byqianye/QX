<script setup lang="ts">
import { computed, ref, watch } from "vue";

import Icon from "./Icon.vue";

const emit = defineEmits<{ search: [query: string]; back: []; toggleSidebar: [] }>();
const props = defineProps<{
  source: string;
  sourceName?: string;
  api: string | null;
  pending: boolean;
  searchAvailable?: boolean | null;
  initialQuery?: string;
  canBack?: boolean;
  sidebarCollapsed?: boolean;
}>();
const query = ref(props.initialQuery ?? "");

watch(() => props.initialQuery, (value) => {
  query.value = value ?? "";
});
const searchDisabled = computed(() => props.pending || props.searchAvailable === false);

function submit(): void {
  emit("search", query.value.trim());
}
</script>

<template>
  <header class="top-search-bar" data-testid="top-search-bar" data-od-id="top-search-bar">
    <nav class="top-history-controls" aria-label="页面历史">
      <button type="button" class="top-back-button" data-action="router-back" aria-label="返回" :disabled="!props.canBack" @click="emit('back')"><Icon name="chevron-left" /><span>返回</span></button>
      <button type="button" class="icon-button shell-sidebar-toggle" data-action="toggle-sidebar" :aria-expanded="String(!props.sidebarCollapsed)" :aria-label="props.sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'" @click="emit('toggleSidebar')">
        <Icon name="panel" />
        <span class="top-sidebar-toggle-label">{{ props.sidebarCollapsed ? "显示侧栏" : "隐藏侧栏" }}</span>
      </button>
    </nav>
    <form data-testid="search-form" data-action="search-form" class="top-search-form" @submit.prevent="submit">
      <label class="sr-only" for="search-key">搜索影视内容</label>
      <Icon name="search" class="search-icon" />
      <input id="search-key" v-model="query" name="key" autocomplete="off" placeholder="搜索影视或剧集" :disabled="searchDisabled" />
      <button type="submit" :disabled="searchDisabled || !query.trim()">搜索</button>
      <span v-if="props.searchAvailable === false" class="search-capability-hint">当前来源不支持搜索</span>
    </form>
    <div class="top-context" data-testid="source-context">
      <span class="context-kicker">来源</span>
      <strong>{{ props.sourceName ?? "当前来源" }}</strong>
      <span v-if="!api" class="context-status">等待选择</span>
    </div>
  </header>
</template>
