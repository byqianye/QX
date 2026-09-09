<script setup lang="ts">
withDefaults(defineProps<{
  name: "home" | "grid" | "play" | "switch" | "source" | "settings" | "sun" | "moon" | "close" | "search" | "tv" | "folder" | "history" | "heart" | "bell" | "download" | "panel" | "chevron-left" | "chevron-right" | "chevron-up" | "chevron-down";
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
    <path v-if="name === 'home'" d="M3 10.5 12 3l9 7.5V20a2 2 0 0 1-2 2h-3v-7h-4v7H7a2 2 0 0 1-2-2v-9.5Z" />
    <template v-else-if="name === 'grid'">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </template>
    <path v-else-if="name === 'play'" d="M6 4v16l14-8L6 4Z" />
    <template v-else-if="name === 'switch'">
      <path d="M17 3v18M21 7l-4-4M3 17l4 4M21 17l-4 4M3 7l4-4" />
    </template>
    <template v-else-if="name === 'source'">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.2 7.3 10.5 16M15.8 7.3 13.5 16M8.5 6h7" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </template>
    <path v-else-if="name === 'moon'" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    <path v-else-if="name === 'close'" d="M18 6 6 18M6 6l12 12" />
    <template v-else-if="name === 'tv'">
      <rect x="2" y="7" width="20" height="13" rx="2" />
      <path d="m17 2-5 5-5-5" />
    </template>
    <path v-else-if="name === 'folder'" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    <template v-else-if="name === 'history'">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </template>
    <path v-else-if="name === 'heart'" d="M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 17.5 4a4.8 4.8 0 0 0-3.5 1.4A4.8 4.8 0 0 0 10.5 4 4.5 4.5 0 0 0 6 8.5c0 2.3 1.5 4 3 5.5l3 3 3-3Z" />
    <template v-else-if="name === 'bell'">
      <path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v13" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </template>
    <template v-else-if="name === 'panel'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </template>
    <path v-else-if="name === 'chevron-left'" d="m14.5 5-7 7 7 7" />
    <path v-else-if="name === 'chevron-right'" d="m9.5 5 7 7-7 7" />
    <path v-else-if="name === 'chevron-up'" d="m5 14.5 7-7 7 7" />
    <path v-else-if="name === 'chevron-down'" d="m5 9.5 7 7 7-7" />
    <template v-else>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </template>
  </svg>
</template>
