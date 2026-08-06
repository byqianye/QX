<script setup lang="ts">
withDefaults(defineProps<{ title?: string; message?: string; actionLabel?: string }>(), {
  title: "暂无内容",
  message: "当前来源没有返回可显示的内容。",
  actionLabel: "返回首页",
});
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <section class="state-card empty-state" data-testid="empty-state" data-od-id="empty-state">
    <span class="state-mark" aria-hidden="true">—</span>
    <h3>{{ title }}</h3>
    <p>{{ message }}</p>
    <button type="button" class="button-secondary" @click="emit('action')">{{ actionLabel }}</button>
  </section>
</template>
