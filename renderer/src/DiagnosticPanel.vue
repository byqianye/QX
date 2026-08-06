<script setup lang="ts">
import { computed } from "vue";

import AppErrorDetails from "./AppErrorDetails.vue";
import { toAppError } from "./error.js";
import { displaySource } from "./safe-display.js";
import type { AppError, RendererError } from "./state.js";

const props = withDefaults(defineProps<{
  code?: string | null;
  message?: string | null;
  source?: string;
  playerStatus?: string;
  error?: AppError;
  diagnostic?: RendererError | null;
}>(), { code: null, source: "当前来源", playerStatus: "idle" });

const effectiveError = computed(() => props.error ?? toAppError(props.diagnostic));
const diagnosticSteps = computed(() => [
  { label: "来源请求", value: props.source ? "当前来源" : "未提供" },
  { label: "线路解析", value: props.code?.startsWith("PLAYBACK_") ? "请查看错误码" : "未提供" },
  { label: "CDN 响应", value: "未提供" },
  { label: "LocalProxy", value: props.code === "PLAYBACK_PROXY_REQUIRED" ? "需要确认" : "未提供" },
  { label: "播放器能力", value: props.playerStatus },
]);
</script>

<template>
  <AppErrorDetails v-if="effectiveError" :error="effectiveError" test-id="diagnostic-panel" />
  <details v-else class="diagnostic-panel" data-testid="diagnostic-panel" data-od-id="diagnostic-panel">
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
