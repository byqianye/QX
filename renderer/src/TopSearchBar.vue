<script setup lang="ts">
import { ref } from "vue";

import Icon from "./Icon.vue";
import { displaySource } from "./safe-display.js";

defineProps<{
  source: string;
  api: string | null;
  pending: boolean;
}>();

const emit = defineEmits<{ search: [query: string] }>();
const query = ref("");

function submit(): void {
  emit("search", query.value.trim());
}
</script>

<template>
  <header class="top-search-bar" data-testid="top-search-bar" data-od-id="top-search-bar">
    <form data-testid="search-form" data-action="search-form" class="top-search-form" @submit.prevent="submit">
      <label class="sr-only" for="search-key">搜索影视内容</label>
      <Icon name="search" class="search-icon" />
      <input id="search-key" v-model="query" name="key" autocomplete="off" placeholder="搜索影视、剧集或来源" :disabled="pending" />
      <button type="submit" :disabled="pending || !query.trim()">搜索</button>
    </form>
    <div class="top-context" data-testid="source-context">
      <span class="context-kicker">来源</span>
      <strong>{{ displaySource(source) }}</strong>
      <span class="context-divider" aria-hidden="true">/</span>
      <span>{{ api ? displaySource(api) : "等待选择" }}</span>
    </div>
  </header>
</template>
