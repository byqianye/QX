<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  source: string | null;
  alt: string;
  fallbackText: string;
  testId?: string;
  loading?: "lazy" | "eager";
}>();

const failed = ref(false);

watch(() => props.source, () => {
  failed.value = false;
});
</script>

<template>
  <img
    v-if="props.source && !failed"
    :data-testid="props.testId"
    :src="props.source"
    :alt="props.alt"
    :loading="props.loading"
    @error="failed = true"
  />
  <span v-else aria-hidden="true">{{ props.fallbackText.slice(0, 1) }}</span>
</template>
