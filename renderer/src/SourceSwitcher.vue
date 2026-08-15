<script setup lang="ts">
import { computed } from "vue";

const emit = defineEmits<{ change: [] }>();
const props = defineProps<{
  source: string;
  sourceName?: string;
  api: string | null;
  sourceCount?: number;
  status: string;
  pending: boolean;
}>();

const hasAlternatives = computed(() => props.sourceCount === undefined || props.sourceCount > 1);
const statusLabel = computed(() => ({
  ready: "已连接",
  loading: "连接中",
  initializing: "准备中",
  error: "暂不可用",
}[props.status] ?? "未检测"));
</script>

<template>
  <section class="source-switcher" data-testid="source-switcher" data-od-id="source-switcher" aria-label="来源切换">
    <div class="source-switcher-copy">
      <span class="section-kicker">当前来源</span>
      <strong>{{ props.sourceName ?? "当前来源" }}</strong>
      <span class="meta">{{ props.api ? (hasAlternatives ? "可切换其他来源" : "当前仅有一个已导入来源") : "请选择一个已授权来源" }}</span>
    </div>
    <span class="status-chip" :data-status="props.status">{{ statusLabel }}</span>
    <button type="button" data-action="switch" :disabled="props.pending" @click="emit('change')">{{ hasAlternatives ? "切换来源" : "查看来源" }}</button>
  </section>
</template>
