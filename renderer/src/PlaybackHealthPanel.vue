<script setup lang="ts">
import { computed } from "vue";
import type { PlaybackFallbackMode, PlaybackFallbackState, PlaybackHealthMetric, PlaybackHealthSnapshot } from "../../src/health/playback-health.js";

const props = defineProps<{
  health: PlaybackHealthSnapshot;
  fallback: PlaybackFallbackState;
}>();

const emit = defineEmits<{
  cancel: [];
  approve: [];
  mode: [value: PlaybackFallbackMode];
  back: [];
  debug: [];
}>();

const metrics = computed(() => [
  ["解析成功", props.health.resolveSuccess, "boolean"],
  ["首帧", props.health.firstFrameMs, "ms"],
  ["缓冲", props.health.bufferingCount, "次"],
  ["缓冲时长", props.health.bufferingDuration, "ms"],
  ["分片失败", props.health.segmentFailure, "次"],
  ["播放时长", props.health.playbackDuration, "秒"],
] as const);

function metricLabel(metric: PlaybackHealthMetric<unknown>, unit: string): string {
  if (metric.samples === 0 || metric.value === null) return "unknown";
  if (unit === "boolean") return metric.value ? "是" : "否";
  return `${metric.value}${unit}`;
}

function modeChanged(value: string): void {
  if (value === "off" || value === "prompt" || value === "auto") emit("mode", value);
}
</script>

<template>
  <section class="panel playback-health-panel" data-testid="playback-health-panel">
    <div class="playback-health-heading">
      <div>
        <span class="section-kicker">流健康</span>
        <h3>播放健康与线路回退</h3>
      </div>
      <label class="playback-health-mode">
        <span>回退模式</span>
        <select data-action="playback-fallback-mode" :value="props.fallback.mode" @change="modeChanged(($event.target as HTMLSelectElement).value)">
          <option value="off">关闭</option>
          <option value="prompt">仅提示</option>
          <option value="auto">自动</option>
        </select>
      </label>
    </div>

    <div class="playback-health-metrics" data-testid="playback-health-metrics">
      <div v-for="metric in metrics" :key="metric[0]" class="playback-health-metric">
        <span>{{ metric[0] }}</span>
        <strong>{{ metricLabel(metric[1] as PlaybackHealthMetric<unknown>, metric[2]) }}</strong>
      </div>
      <div class="playback-health-metric">
        <span>健康评分</span>
        <strong>{{ props.health.score.value === null ? "unknown" : props.health.score.value }}</strong>
      </div>
      <div class="playback-health-metric">
        <span>连续失败</span>
        <strong>{{ props.health.consecutiveFailures.samples === 0 ? "unknown" : props.health.consecutiveFailures.value }}</strong>
      </div>
    </div>

    <div v-if="props.fallback.status !== 'idle' && props.fallback.status !== 'disabled'" class="playback-fallback-status" data-testid="playback-fallback-status">
      <strong>当前失败：{{ props.fallback.trigger ?? "播放异常" }}</strong>
      <span v-if="props.fallback.reason">原因：{{ props.fallback.reason }}</span>
      <span v-if="props.fallback.next">即将尝试线路：{{ props.fallback.next.label }}</span>
      <span v-else-if="props.fallback.status === 'trying'">正在尝试下一条线路…</span>
      <span v-if="props.fallback.status === 'stopped'">回退已停止。</span>
      <span v-if="props.fallback.status === 'recovered'">线路已恢复。</span>
    </div>

    <div class="button-row">
      <button v-if="props.fallback.status === 'prompt'" type="button" class="button-primary" data-action="playback-fallback-approve" @click="emit('approve')">尝试下一条</button>
      <button v-if="props.fallback.status === 'prompt' || props.fallback.status === 'trying'" type="button" class="button-secondary" data-action="playback-fallback-cancel" @click="emit('cancel')">取消</button>
      <button type="button" class="button-secondary" data-action="playback-fallback-back" @click="emit('back')">返回</button>
      <button type="button" class="button-secondary" data-action="playback-fallback-debug" @click="emit('debug')">查看调试</button>
    </div>
  </section>
</template>
