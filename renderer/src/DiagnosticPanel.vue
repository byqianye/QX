<script setup lang="ts">
import { computed } from "vue";

import { displaySource } from "./safe-display.js";

const props = withDefaults(defineProps<{
  code?: string | null;
  message?: string | null;
  source?: string;
  playerStatus?: string;
}>(), { code: null, source: "当前来源", playerStatus: "idle" });

const diagnosticSteps = computed(() => [
  { label: "来源请求", value: props.source ? "当前来源" : "未提供" },
  { label: "线路解析", value: props.code?.startsWith("PLAYBACK_") ? "请查看错误码" : "未提供" },
  { label: "CDN 响应", value: "未提供" },
  { label: "LocalProxy", value: props.code === "PLAYBACK_PROXY_REQUIRED" ? "需要确认" : "未提供" },
  { label: "播放器能力", value: props.playerStatus },
]);
</script>

<template>
  <details class="diagnostic-panel" data-testid="diagnostic-panel" data-od-id="diagnostic-panel">
    <summary>查看诊断</summary>
    <dl>
      <div><dt>来源</dt><dd>{{ displaySource(source) }}</dd></div>
      <div><dt>播放器</dt><dd>{{ playerStatus }}</dd></div>
      <div v-if="code"><dt>错误码</dt><dd>{{ code }}</dd></div>
      <div v-if="message"><dt>说明</dt><dd>{{ message }}</dd></div>
      <div v-for="step in diagnosticSteps" :key="step.label" data-diagnostic-step><dt>{{ step.label }}</dt><dd>{{ step.value }}</dd></div>
    </dl>
    <p class="meta">诊断摘要已脱敏，不包含 token、Cookie、完整播放地址或本机路径。</p>
  </details>
</template>
