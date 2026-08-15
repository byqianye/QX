<script setup lang="ts">
import { computed, ref } from "vue";

import Icon from "./Icon.vue";

const emit = defineEmits<{ search: [query: string]; back: []; forward: [] }>();
const props = defineProps<{
  source: string;
  sourceName?: string;
  api: string | null;
  pending: boolean;
  searchAvailable?: boolean | null;
  initialQuery?: string;
  canBack?: boolean;
  canForward?: boolean;
}>();
const query = ref(props.initialQuery ?? "");
const searchDisabled = computed(() => props.pending || props.searchAvailable === false);

function submit(): void {
  emit("search", query.value.trim());
}
</script>

<template>
  <header class="top-search-bar" data-testid="top-search-bar" data-od-id="top-search-bar">
    <nav class="top-history-controls" aria-label="页面历史">
      <button type="button" class="icon-button" data-action="router-back" aria-label="返回上一页" :disabled="!props.canBack" @click="emit('back')">←</button>
      <button type="button" class="icon-button" data-action="router-forward" aria-label="前进到下一页" :disabled="!props.canForward" @click="emit('forward')">→</button>
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
