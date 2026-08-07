<script setup lang="ts">
import Icon from "./Icon.vue";
import { displaySource } from "./safe-display.js";

defineProps<{
  activePage: string;
  source: string;
  status: string;
  canStart: boolean;
  pending: boolean;
  theme: "system" | "light" | "dark";
  followUpdates: number;
}>();

const emit = defineEmits<{
  navigate: [route: "home" | "category" | "history" | "favorites" | "follow" | "settings"];
  open: [];
  switch: [];
  close: [];
  theme: [theme: "system" | "light" | "dark"];
}>();
</script>

<template>
  <aside class="app-sidebar" data-testid="app-sidebar" data-od-id="app-sidebar" aria-label="主导航">
    <div class="sidebar-brand">
      <span class="brand-mark" aria-hidden="true">Q</span>
      <div>
        <strong>QX 影视</strong>
        <span>媒体工作台</span>
      </div>
    </div>

    <div class="sidebar-source" data-testid="sidebar-source">
      <span class="status-dot" :data-status="status" aria-hidden="true" />
      <div>
        <span class="sidebar-label">当前来源</span>
        <strong>{{ displaySource(source) }}</strong>
      </div>
    </div>

    <nav class="sidebar-nav" aria-label="工作区">
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'home' }"
        type="button"
        data-action="home"
        :disabled="pending"
        @click="emit('navigate', 'home')"
      >
        <Icon name="home" /><span>点播首页</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'category' }"
        type="button"
        data-action="category"
        data-type-id="hot_gaia"
        data-page="1"
        :disabled="pending"
        @click="emit('navigate', 'category')"
      >
        <Icon name="grid" /><span>分类浏览</span>
      </button>
      <button class="sidebar-nav-item sidebar-nav-placeholder" type="button" data-action="live-placeholder" disabled>
        <Icon name="play" /><span>直播（占位）</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'history' }"
        type="button"
        data-action="history"
        :disabled="pending"
        @click="emit('navigate', 'history')"
      >
        <Icon name="grid" /><span>历史记录</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'favorites' }"
        type="button"
        data-action="favorites"
        :disabled="pending"
        @click="emit('navigate', 'favorites')"
      >
        <Icon name="home" /><span>收藏</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'follow' }"
        type="button"
        data-action="follow"
        :disabled="pending"
        @click="emit('navigate', 'follow')"
      >
        <Icon name="grid" /><span>追更</span><span v-if="followUpdates > 0" class="sidebar-badge">{{ followUpdates }}</span>
      </button>
      <button class="sidebar-nav-item sidebar-nav-placeholder" type="button" data-action="downloads-placeholder" disabled>
        <Icon name="grid" /><span>下载（占位）</span>
      </button>
      <button class="sidebar-nav-item sidebar-nav-placeholder" type="button" data-action="console-placeholder" disabled>
        <Icon name="settings" /><span>控制台（占位）</span>
      </button>
      <button
        v-if="canStart"
        class="sidebar-nav-item"
        type="button"
        data-action="open"
        :disabled="pending"
        @click="emit('open')"
      >
        <Icon name="play" /><span>启动 Spider</span>
      </button>
      <button
        class="sidebar-nav-item"
        type="button"
        data-action="switch"
        :disabled="pending"
        @click="emit('switch')"
      >
        <Icon name="switch" /><span>切换来源</span>
      </button>
    </nav>

    <div class="sidebar-spacer" />

    <nav class="sidebar-nav sidebar-nav-secondary" aria-label="工具">
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'settings' }"
        type="button"
        data-action="settings"
        @click="emit('navigate', 'settings')"
      >
        <Icon name="settings" /><span>设置</span>
      </button>
      <button
        class="sidebar-nav-item"
        type="button"
        data-action="theme-toggle"
        :aria-label="theme === 'dark' ? '切换浅色' : '切换深色'"
        @click="emit('theme', theme === 'dark' ? 'light' : 'dark')"
      >
        <Icon :name="theme === 'dark' ? 'sun' : 'moon'" />
        <span>{{ theme === "system" ? "跟随系统" : (theme === "dark" ? "浅色主题" : "深色主题") }}</span>
      </button>
      <button
        class="sidebar-nav-item"
        type="button"
        data-action="close"
        :disabled="pending"
        @click="emit('close')"
      >
        <Icon name="close" /><span>关闭连接</span>
      </button>
    </nav>
  </aside>
</template>
