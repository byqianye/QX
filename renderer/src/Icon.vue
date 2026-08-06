<script setup lang="ts">
withDefaults(defineProps<{
  name: "home" | "grid" | "play" | "switch" | "settings" | "sun" | "moon" | "close" | "search";
  size?: number;
}>(), {
  size: 18,
});
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-if="name === 'home'" d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10Z" />
    <template v-else-if="name === 'grid'">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </template>
    <path v-else-if="name === 'play'" d="m8 5 11 7-11 7V5Z" />
    <template v-else-if="name === 'switch'">
      <path d="M4 7h13" />
      <path d="m14 4 3 3-3 3" />
      <path d="M20 17H7" />
      <path d="m10 14-3 3 3 3" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="m19.4 15 .1.1-1.6 2.8-.1-.1a2 2 0 0 0-2.3.8v.2h-3.2v-.2a2 2 0 0 0-2.3-.8l-.1.1-1.6-2.8.1-.1a2 2 0 0 0 0-2v-.1a2 2 0 0 0 0-2l-.1-.1 1.6-2.8.1.1a2 2 0 0 0 2.3-.8V7h3.2v.2a2 2 0 0 0 2.3.8l.1-.1 1.6 2.8-.1.1a2 2 0 0 0 0 2v.1a2 2 0 0 0 0 2Z" />
    </template>
    <path v-else-if="name === 'sun'" d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
    <path v-else-if="name === 'moon'" d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />
    <path v-else-if="name === 'close'" d="m6 6 12 12M18 6 6 18" />
    <template v-else>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4.5 4.5" />
    </template>
  </svg>
</template>
