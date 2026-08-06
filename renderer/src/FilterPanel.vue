<script setup lang="ts">
import { ref } from "vue";

const expanded = ref(false);
const emit = defineEmits<{ clear: [] }>();
</script>

<template>
  <section class="filter-panel" data-testid="filter-panel" data-od-id="filter-panel" :data-expanded="expanded">
    <button type="button" class="filter-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
      <span>筛选</span><span class="meta">{{ expanded ? "收起条件" : "按类型、年份筛选" }}</span>
    </button>
    <div v-if="expanded" class="filter-panel-content">
      <span class="filter-placeholder">当前筛选由来源适配器提供</span>
      <button type="button" class="text-button" @click="emit('clear')">清除筛选</button>
    </div>
  </section>
</template>
