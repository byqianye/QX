<script setup lang="ts">
import { displaySource } from "./safe-display.js";

defineProps<{
  source: string;
  api: string | null;
  status: string;
  pending: boolean;
}>();

const emit = defineEmits<{ change: [] }>();
</script>

<template>
  <section class="source-switcher" data-testid="source-switcher" data-od-id="source-switcher" aria-label="来源切换">
    <div class="source-switcher-copy">
      <span class="section-kicker">当前来源</span>
      <strong>{{ displaySource(source) }}</strong>
      <span class="meta">{{ api ? displaySource(api) : "请选择一个已授权来源" }}</span>
    </div>
    <span class="status-chip" :data-status="status">{{ status === "ready" ? "已连接" : status }}</span>
    <button type="button" data-action="switch" :disabled="pending" @click="emit('change')">切换来源</button>
  </section>
</template>
