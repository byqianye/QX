<script setup lang="ts">
import { ref, watch } from "vue";
import { isTauriRuntime, requestDesktopService } from "./tauri-rpc.js";

const props = defineProps<{
  source: string | null;
  alt: string;
  fallbackText: string;
  testId?: string;
  loading?: "lazy" | "eager";
  cacheType?: "poster" | "backdrop";
}>();

const failed = ref(false);
const resolvedSource = ref<string | null>(props.source);
let requestGeneration = 0;

watch(() => [props.source, props.cacheType] as const, async ([source]) => {
  const generation = ++requestGeneration;
  failed.value = false;
  resolvedSource.value = source;
  if (!source || !/^https?:\/\//i.test(source) || !isTauriRuntime()) return;
  try {
    const snapshot = await requestDesktopService({
      action: "cache-image",
      value: { type: props.cacheType ?? "poster", url: source },
    });
    if (generation !== requestGeneration) return;
    const assetUrl = snapshot.state.assetUrl;
    if (typeof assetUrl === "string" && assetUrl) resolvedSource.value = assetUrl;
  } catch {
    // The original remote image remains the safe fallback when caching fails.
  }
}, { immediate: true });

function handleError(): void {
  if (resolvedSource.value !== props.source && props.source) {
    resolvedSource.value = props.source;
    return;
  }
  failed.value = true;
}
</script>

<template>
  <img
    v-if="resolvedSource && !failed"
    :data-testid="props.testId"
    :src="resolvedSource"
    :alt="props.alt"
    :loading="props.loading"
    @error="handleError"
  />
  <span v-else aria-hidden="true">{{ props.fallbackText.slice(0, 1) }}</span>
</template>
