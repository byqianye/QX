<script setup lang="ts">
import { computed } from "vue";

import AppErrorDetails from "./AppErrorDetails.vue";
import type { AppError } from "./state.js";

const props = withDefaults(defineProps<{
  error: AppError;
  pending?: boolean;
  showRetry?: boolean;
  showSwitchLine?: boolean;
  showBack?: boolean;
  showSettings?: boolean;
}>(), {
  pending: false,
  showRetry: true,
  showSwitchLine: true,
  showBack: true,
  showSettings: true,
});
const emit = defineEmits<{
  retry: [];
  switchLine: [];
  back: [];
  settings: [];
}>();

const isProxyRequired = computed(() => props.error.code === "PLAYBACK_PROXY_REQUIRED");
const isPlayback = computed(() => props.error.source === "player" || props.error.source === "proxy");
const primaryLabel = computed(() => isPlayback.value ? "重试当前线路" : "重试刚才操作");
const secondaryLabel = computed(() => isPlayback.value ? "切换线路" : "切换来源");
const guidance = computed(() => {
  if (isProxyRequired.value) return "此线路需要本机 LocalProxy 才能继续播放，请切换线路或检查设置。";
  if (props.error.code === "PLAYBACK_UNAVAILABLE") return "当前线路暂时无法播放，可以选择其他线路。";
  if (props.error.source === "config") return "配置没有被应用，修正输入后可以重新导入。";
  if (props.error.source === "persistence") return "当前会话仍可继续使用，后续操作会再次尝试保存。";
  return "应用保留了当前上下文，你可以重试、返回或切换来源。";
});
</script>

<template>
  <section class="state-card error-state" data-testid="error-state" data-od-id="error-state" :data-error-code="props.error.code" role="alert">
    <div class="state-card-heading">
      <span class="state-mark" aria-hidden="true">!</span>
      <div><span class="section-kicker">{{ props.error.title }}</span><h3>{{ props.error.message }}</h3></div>
    </div>
    <p>{{ guidance }}</p>
    <div class="state-actions">
      <button v-if="props.showRetry && props.error.retryable" type="button" class="button-primary" data-action="error-retry" :disabled="props.pending" @click="emit('retry')">{{ primaryLabel }}</button>
      <button v-if="props.showSwitchLine" type="button" class="button-secondary" data-action="switch-line" :disabled="props.pending" @click="emit('switchLine')">{{ secondaryLabel }}</button>
      <button v-if="props.showBack" type="button" class="button-secondary" data-action="error-back" :disabled="props.pending" @click="emit('back')">返回</button>
      <button v-if="props.showSettings" type="button" class="button-secondary" data-action="error-settings" :disabled="props.pending" @click="emit('settings')">打开设置</button>
    </div>
    <span class="error-code">{{ props.error.code }}</span>
    <AppErrorDetails :error="props.error" />
  </section>
</template>
