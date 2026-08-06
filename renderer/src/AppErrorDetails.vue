<script setup lang="ts">
import { ref } from "vue";

import { formatDiagnostic } from "./error.js";
import type { AppError } from "./state.js";

const props = withDefaults(defineProps<{ error: AppError; testId?: string; showDebug?: boolean }>(), { showDebug: false });
const emit = defineEmits<{ openDebug: [] }>();
const copyState = ref<"idle" | "copied" | "unavailable">("idle");

async function copyDiagnostic(): Promise<void> {
  const text = formatDiagnostic(props.error);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "true");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("clipboard unavailable");
    }
    copyState.value = "copied";
  } catch {
    copyState.value = "unavailable";
  }
}
</script>

<template>
  <details class="diagnostic-panel error-diagnostic" :data-testid="props.testId ?? 'error-diagnostic'" data-od-id="diagnostic-panel">
    <summary>查看诊断</summary>
    <dl>
      <div><dt>错误码</dt><dd>{{ props.error.code }}</dd></div>
      <div><dt>诊断 ID</dt><dd>{{ props.error.diagnosticId }}</dd></div>
      <div><dt>来源</dt><dd>{{ props.error.source }}</dd></div>
      <div><dt>时间</dt><dd>{{ props.error.timestamp }}</dd></div>
      <div v-if="props.error.causeCode"><dt>原因码</dt><dd>{{ props.error.causeCode }}</dd></div>
      <div v-for="(value, key) in props.error.safeDetails" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></div>
    </dl>
    <div class="diagnostic-actions">
      <button type="button" class="button-secondary" data-action="copy-diagnostic" @click="copyDiagnostic">复制诊断</button>
      <button v-if="props.showDebug" type="button" class="button-secondary" data-action="open-playback-debug" @click="emit('openDebug')">播放调试</button>
      <span v-if="copyState === 'copied'" class="meta" data-testid="diagnostic-copy-status">已复制</span>
      <span v-else-if="copyState === 'unavailable'" class="meta" data-testid="diagnostic-copy-status">当前环境无法访问剪贴板</span>
    </div>
    <p class="meta">诊断内容已脱敏，不包含凭据、完整地址、本机路径或原始堆栈。</p>
  </details>
</template>
