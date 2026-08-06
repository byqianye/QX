<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: "正在加载" });
</script>

<template>
  <section class="state-card loading-state" data-testid="loading-state" data-od-id="loading-state" aria-live="polite">
    <span class="loading-bar" aria-hidden="true" /><strong>{{ label }}</strong>
  </section>
</template>
