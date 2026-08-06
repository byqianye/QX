<script setup lang="ts">
defineProps<{ title: string; description: string; status?: "idle" | "success" | "error" }>();
</script>

<template>
  <section class="settings-section" data-testid="settings-section" data-od-id="settings-section">
    <div>
      <span class="section-kicker">设置</span>
      <h2>{{ title }}</h2>
      <p class="meta">{{ description }}</p>
    </div>
    <span v-if="status === 'success'" class="status-chip" data-status="success">已保存</span>
    <slot />
  </section>
</template>
