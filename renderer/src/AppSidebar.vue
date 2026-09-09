<script setup lang="ts">
import Icon from "./Icon.vue";

const appIcon = new URL("../../build/assets/qx-yingshi-mark.svg", import.meta.url).href;

defineProps<{
  activePage: string;
  source: string;
  sourceName?: string;
  sourceCount?: number;
  status: string;
  categoryAvailable?: boolean | null;
  localAvailable?: boolean | null;
  pending: boolean;
  theme: "system" | "light" | "dark";
  followUpdates: number;
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  navigate: [route: "home" | "category" | "history" | "favorites" | "follow" | "settings" | "local" | "downloads" | "sources"];
  open: [];
  switch: [];
  close: [];
  theme: [theme: "system" | "light" | "dark"];
}>();
</script>

<template>
  <aside
    class="app-sidebar"
    data-testid="app-sidebar"
    data-od-id="app-sidebar"
    aria-label="主导航"
    :aria-hidden="collapsed ? 'true' : undefined"
    :inert="collapsed ? '' : undefined"
  >
    <div class="sidebar-brand">
      <img class="brand-mark brand-mark-image" :src="appIcon" alt="QX影视" />
      <div>
        <strong>QX 影视</strong>
        <span>媒体工作台</span>
      </div>
    </div>

    <nav class="sidebar-nav" aria-label="工作区">
      <span class="sidebar-group-label" aria-hidden="true">浏览</span>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'home' }"
        type="button"
        data-action="home"
        aria-label="点播首页"
        title="点播首页"
        :disabled="pending"
        @click="emit('navigate', 'home')"
      >
        <Icon name="home" /><span>点播首页</span>
      </button>
      <button
        v-if="categoryAvailable !== false"
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'category' }"
        type="button"
        data-action="category"
        aria-label="分类浏览"
        title="分类浏览"
        :disabled="pending"
        @click="emit('navigate', 'category')"
      >
        <Icon name="grid" /><span>分类浏览</span>
      </button>
      <button
        v-if="localAvailable !== false"
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'local' }"
        type="button"
        data-action="local-media"
        aria-label="本地媒体"
        title="本地媒体"
        :disabled="pending"
        @click="emit('navigate', 'local')"
      >
        <Icon name="folder" /><span>本地媒体</span>
      </button>
      <span class="sidebar-group-label" aria-hidden="true">资料库</span>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'history' }"
        type="button"
        data-action="history"
        aria-label="历史记录"
        title="历史记录"
        :disabled="pending"
        @click="emit('navigate', 'history')"
      >
        <Icon name="history" /><span>历史记录</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'favorites' }"
        type="button"
        data-action="favorites"
        aria-label="收藏"
        title="收藏"
        :disabled="pending"
        @click="emit('navigate', 'favorites')"
      >
        <Icon name="heart" /><span>收藏</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'follow' }"
        type="button"
        data-action="follow"
        aria-label="追更"
        title="追更"
        :disabled="pending"
        @click="emit('navigate', 'follow')"
      >
        <Icon name="bell" /><span>追更</span><span v-if="followUpdates > 0" class="sidebar-badge">{{ followUpdates }}</span>
      </button>
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'downloads' }"
        type="button"
        data-action="downloads"
        aria-label="下载"
        title="下载"
        :disabled="pending"
        @click="emit('navigate', 'downloads')"
      >
        <Icon name="download" /><span>下载</span>
      </button>
      <span class="sidebar-group-label" aria-hidden="true">来源</span>
    </nav>

    <div class="sidebar-spacer" />

    <button
      type="button"
      class="sidebar-source"
      data-testid="sidebar-source"
      data-action="sidebar-source-status"
      :aria-label="`当前来源：${sourceName ?? '未选择来源'}`"
      :title="`当前来源：${sourceName ?? '未选择来源'}`"
      :disabled="pending"
      @click="emit('navigate', 'sources')"
    >
      <span class="status-dot" :data-status="status" aria-hidden="true" />
      <span>
        <span class="sidebar-label">当前来源</span>
        <strong>{{ sourceName ?? "当前来源" }}</strong>
      </span>
    </button>

    <nav class="sidebar-nav sidebar-nav-source" aria-label="来源管理">
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'sources' }"
        type="button"
        data-action="sources"
        aria-label="来源中心"
        title="来源中心"
        :disabled="pending"
        @click="emit('navigate', 'sources')"
      >
        <Icon name="source" /><span>来源中心</span>
      </button>
    </nav>

    <nav class="sidebar-nav sidebar-nav-secondary" aria-label="工具">
      <button
        class="sidebar-nav-item"
        :class="{ selected: activePage === 'settings' }"
        type="button"
        data-action="settings"
        aria-label="设置"
        title="设置"
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
        :title="theme === 'dark' ? '切换浅色' : '切换深色'"
      >
        <Icon :name="theme === 'dark' ? 'sun' : 'moon'" />
        <span>{{ theme === "system" ? "跟随系统" : (theme === "dark" ? "浅色主题" : "深色主题") }}</span>
      </button>
      <button
        class="sidebar-nav-item"
        type="button"
        data-action="close"
        aria-label="关闭连接"
        title="关闭连接"
        :disabled="pending"
        @click="emit('close')"
      >
        <Icon name="close" /><span>关闭连接</span>
      </button>
    </nav>
  </aside>
</template>
