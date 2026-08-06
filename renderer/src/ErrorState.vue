<script setup lang="ts">
import { computed } from "vue";

import type { RendererError } from "./state.js";

const props = defineProps<{ error: RendererError; pending?: boolean }>();
const emit = defineEmits<{ retry: []; switchLine: [] }>();

const isProxyRequired = computed(() => props.error.code === "PLAYBACK_PROXY_REQUIRED");
const primaryLabel = computed(() => isProxyRequired.value ? "启用代理并重试" : "重试当前线路");
const secondaryLabel = computed(() => isProxyRequired.value ? "换一条线路" : "切换线路");
</script>

<template>
  <section class="state-card error-state" data-testid="error-state" data-od-id="error-state" :data-error-code="props.error.code" role="alert">
    <div class="state-card-heading">
      <span class="state-mark" aria-hidden="true">!</span>
      <div><span class="section-kicker">{{ isProxyRequired ? "需要前置条件" : "线路结果" }}</span><h3>{{ props.error.message }}</h3></div>
    </div>
    <p v-if="isProxyRequired">此线路需要本机 LocalProxy 才能继续播放。</p>
    <p v-else-if="props.error.code === 'PLAYBACK_UNAVAILABLE'">当前线路暂时无法播放，可以重试或选择其他线路。</p>
    <p v-else>保留当前详情和选集，你可以重试或查看另一条线路。</p>
    <div class="state-actions">
      <button type="button" class="button-primary" :data-action="isProxyRequired ? 'enable-proxy' : 'player-retry'" :disabled="props.pending" @click="emit('retry')">{{ primaryLabel }}</button>
      <button type="button" class="button-secondary" data-action="switch-line" :disabled="props.pending" @click="emit('switchLine')">{{ secondaryLabel }}</button>
    </div>
    <span class="error-code">{{ props.error.code }}</span>
  </section>
</template>
