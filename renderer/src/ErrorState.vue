<script setup lang="ts">
import { computed } from "vue";

import AppErrorDetails from "./AppErrorDetails.vue";
import { isOfflineError } from "./error.js";
import type { AppError } from "./state.js";

const props = withDefaults(defineProps<{
  error: AppError;
  pending?: boolean;
  showRetry?: boolean;
  showSwitchLine?: boolean;
  showBack?: boolean;
  showSettings?: boolean;
  showTechnical?: boolean;
}>(), {
  pending: false,
  showRetry: true,
  showSwitchLine: true,
  showBack: false,
  showSettings: true,
  showTechnical: true,
});
const emit = defineEmits<{
  retry: [];
  switchLine: [];
  back: [];
  settings: [];
  openDebug: [];
}>();

const isProxyRequired = computed(() => props.error.code === "PLAYBACK_PROXY_REQUIRED");
const isPlayback = computed(() => props.error.source === "player" || props.error.source === "proxy");
const isOffline = computed(() => isOfflineError(props.error));
const primaryLabel = computed(() => isOffline.value ? "重新连接" : isPlayback.value ? "重试当前线路" : "重试刚才操作");
const secondaryLabel = computed(() => isPlayback.value ? "切换线路" : "切换来源");
const guidance = computed(() => {
  if (isProxyRequired.value) return "此线路需要本机 LocalProxy 才能继续播放，请切换线路或检查设置。";
  if (isOffline.value) return "当前来源暂不可用；你仍然可以使用本地媒体和已经下载的内容。";
  if (props.error.code === "PLAYBACK_UNAVAILABLE") return "当前线路暂时无法播放，可以选择其他线路。";
  if (props.error.source === "config") return "配置没有被应用，修正输入后可以重新导入。";
  if (props.error.source === "persistence") return "当前会话仍可继续使用，后续操作会再次尝试保存。";
  return "应用保留了当前上下文，你可以重试或切换来源。";
});
const displayMessage = computed(() => {
  const message = props.error.message.trim();
  if (props.showTechnical || (message !== props.error.code && !/^[A-Z0-9_:-]+$/u.test(message))) return props.error.message;
  return "当前操作未完成。";
});
</script>

<template>
  <section class="state-card error-state" :class="{ 'offline-state': isOffline }" data-testid="error-state" data-od-id="error-state" :data-state="isOffline ? 'offline' : 'error'" :data-error-code="props.error.code" role="alert">
    <div class="state-card-heading">
      <span class="state-mark" aria-hidden="true">!</span>
      <div><span class="section-kicker">{{ props.error.title }}</span><h3>{{ displayMessage }}</h3></div>
    </div>
    <p>{{ guidance }}</p>
    <div class="state-actions">
      <button v-if="props.showRetry && props.error.retryable" type="button" class="button-primary" data-action="error-retry" :disabled="props.pending" @click="emit('retry')">{{ primaryLabel }}</button>
      <button v-if="props.showSwitchLine" type="button" class="button-secondary" data-action="switch-line" :disabled="props.pending" @click="emit('switchLine')">{{ secondaryLabel }}</button>
      <button v-if="props.showBack" type="button" class="button-secondary" data-action="error-back" :disabled="props.pending" @click="emit('back')">返回</button>
      <button v-if="props.showSettings" type="button" class="button-secondary" data-action="error-settings" :disabled="props.pending" @click="emit('settings')">打开设置</button>
    </div>
    <span v-if="props.showTechnical" class="error-code">{{ props.error.code }}</span>
    <AppErrorDetails
      v-if="props.showTechnical"
      :error="props.error"
      :show-debug="isPlayback"
      @open-debug="emit('openDebug')"
    />
  </section>
</template>
