<script setup lang="ts">
defineProps<{ active: string }>();
const emit = defineEmits<{ select: [key: "home" | "category"] }>();

function moveTab(event: KeyboardEvent): void {
  const tabs = Array.from((event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  const current = tabs.indexOf(event.currentTarget as HTMLButtonElement);
  if (tabs.length === 0 || current < 0) return;
  const next = event.key === "ArrowRight" ? (current + 1) % tabs.length
    : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next]?.focus();
  emit("select", next === 0 ? "home" : "category");
}
</script>

<template>
  <div class="category-tabs" data-testid="category-tabs" data-od-id="category-tabs" role="tablist" aria-label="内容分类">
    <button type="button" role="tab" data-action="home-tab" :aria-selected="active === 'home'" :class="{ selected: active === 'home' }" @keydown="moveTab" @click="emit('select', 'home')">推荐</button>
    <button type="button" role="tab" :aria-selected="active === 'category'" :class="{ selected: active === 'category' }" data-action="category-tab" @keydown="moveTab" @click="emit('select', 'category')">分类</button>
  </div>
</template>
