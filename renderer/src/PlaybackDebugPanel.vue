<script setup lang="ts">
import { computed, ref } from "vue";

import {
  formatPlaybackDebugJson,
  formatPlaybackDebugText,
  type PlaybackDebugSnapshot,
} from "./playback-debug.js";

const props = defineProps<{ snapshot: PlaybackDebugSnapshot }>();
const emit = defineEmits<{ close: [] }>();
const actionState = ref<"idle" | "copied" | "exported" | "unavailable">("idle");

const fields = computed(() => [
  ["source", "Source", props.snapshot.source],
  ["engine", "Engine", props.snapshot.engine],
  ["site", "Site", props.snapshot.site],
  ["playbackSession", "Playback Session", props.snapshot.playbackSession],
  ["line", "线路", props.snapshot.line],
  ["episode", "剧集", props.snapshot.episode],
  ["playerContent", "playerContent", props.snapshot.playerContent],
  ["parse", "parse", props.snapshot.parse],
  ["rules", "Rules", props.snapshot.rules],
  ["sniff", "sniff", props.snapshot.sniff],
  ["localProxy", "LocalProxy", props.snapshot.localProxy],
  ["backend", "后端", props.snapshot.backend],
  ["startupMs", "起播时间", props.snapshot.startupMs === null ? "未报告" : `${props.snapshot.startupMs} ms`],
  ["buffering", "缓冲", props.snapshot.buffering],
  ["error", "错误", props.snapshot.error || "无"],
  ["fallback", "回退", props.snapshot.fallback],
  ["capability", "capability", props.snapshot.capability],
] as const);

async function copySnapshot(): Promise<void> {
  const text = formatPlaybackDebugText(props.snapshot);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "true");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("clipboard unavailable");
    }
    actionState.value = "copied";
  } catch {
    actionState.value = "unavailable";
  }
}

function exportSnapshot(format: "json" | "text"): void {
  try {
    const content = format === "json"
      ? formatPlaybackDebugJson(props.snapshot)
      : formatPlaybackDebugText(props.snapshot);
    const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qx-playback-debug.${format === "json" ? "json" : "txt"}`;
    link.click();
    URL.revokeObjectURL(url);
    actionState.value = "exported";
  } catch {
    actionState.value = "unavailable";
  }
}
</script>

<template>
  <section class="panel playback-debug-panel" data-testid="playback-debug-panel" data-od-id="playback-debug-panel">
    <header class="playback-debug-header">
      <div>
        <span class="section-kicker">Playback diagnostics</span>
        <h2>播放调试</h2>
        <p class="meta">仅显示当前会话的脱敏摘要；快捷键 D 可开关。</p>
      </div>
      <button type="button" class="button-secondary" data-action="close-playback-debug" @click="emit('close')">关闭</button>
    </header>

    <div class="playback-debug-actions button-row">
      <button type="button" class="button-primary" data-action="copy-playback-debug" @click="copySnapshot">复制脱敏文本</button>
      <button type="button" class="button-secondary" data-action="export-playback-debug-json" @click="exportSnapshot('json')">导出 JSON</button>
      <button type="button" class="button-secondary" data-action="export-playback-debug-text" @click="exportSnapshot('text')">导出文本</button>
      <span v-if="actionState === 'copied'" class="meta" data-testid="playback-debug-action-status">已复制</span>
      <span v-else-if="actionState === 'exported'" class="meta" data-testid="playback-debug-action-status">已导出</span>
      <span v-else-if="actionState === 'unavailable'" class="meta" data-testid="playback-debug-action-status">当前环境无法完成此操作</span>
    </div>

    <dl class="playback-debug-summary" data-testid="playback-debug-summary">
      <div v-for="field in fields" :key="field[0]" :data-debug-field="field[0]">
        <dt>{{ field[1] }}</dt>
        <dd>{{ field[2] }}</dd>
      </div>
    </dl>

    <section class="playback-debug-timeline-section">
      <div class="playback-debug-section-heading">
        <h3>Timeline</h3>
        <span class="meta">{{ props.snapshot.events.length }} / 200 events</span>
      </div>
      <ol class="playback-debug-timeline" data-testid="playback-debug-timeline">
        <li v-for="event in props.snapshot.events" :key="`${event.timestamp}-${event.type}-${event.sessionId}`" data-debug-event>
          <div class="playback-debug-event-heading">
            <strong>{{ event.type }}</strong>
            <span class="meta">{{ event.timestamp }}</span>
          </div>
          <span class="playback-debug-event-meta">{{ event.phase }} · {{ event.source }} · {{ event.sessionId }}<template v-if="event.durationMs !== undefined"> · {{ event.durationMs }} ms</template></span>
          <dl v-if="Object.keys(event.safeDetails).length > 0" class="playback-debug-event-details">
            <div v-for="(value, key) in event.safeDetails" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></div>
          </dl>
        </li>
        <li v-if="props.snapshot.events.length === 0" class="meta">暂无播放事件。</li>
      </ol>
    </section>
  </section>
</template>
