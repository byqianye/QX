<script setup lang="ts">
import type Hls from "hls.js";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import PlayerControls from "./PlayerControls.vue";
import SubtitleTrackPanel from "./SubtitleTrackPanel.vue";
import DanmakuOverlay from "./DanmakuOverlay.vue";
import { PLAYBACK_RESTORE_MAX_DRIFT_SECONDS, type PlayerMediaSync, type PlayerState } from "./state.js";
import {
  SubtitleObjectUrlRegistry,
  SubtitleParseError,
  detectSubtitleFormat,
  isLocalProxySubtitleUrl,
  parseSubtitle,
  subtitleFormatFromName,
  subtitleToWebVtt,
  type SubtitleEncoding,
  type SubtitleTrack,
} from "../../src/subtitles.js";
import type { PlaybackMediaEvent } from "../../src/desktop/playback.js";
import type { DanmakuUiState } from "../../src/danmaku/danmaku-types.js";
import { PlaybackProgressWatchdog } from "./playback-recovery.js";

const PLAYER_CONTROLS_HIDE_DELAY_MS = 2_500;
const HLS_MAX_BUFFER_SIZE_BYTES = 48 * 1000 * 1000;

interface QualityOption {
  id: string;
  label: string;
}

type ShakaPlayer = import("shaka-player").default.Player;
type ShakaVariantTrack = ReturnType<ShakaPlayer["getVariantTracks"]>[number];
type ShakaTextTrack = ReturnType<ShakaPlayer["getTextTracks"]>[number];

const props = withDefaults(defineProps<{
  state: PlayerState;
  sessionId?: string | null;
  playbackKey?: string | null;
  detachable?: boolean;
  danmaku?: DanmakuUiState;
}>(), { detachable: true });
const emit = defineEmits<{
  sync: [value: PlayerMediaSync];
  detach: [];
  stop: [];
}>();

const playerStage = ref<HTMLElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const localStatus = ref(props.state.status);
const localError = ref<string | null>(props.state.error?.message ?? null);
const fullscreenActive = ref(false);
const fullscreenError = ref<string | null>(null);
let localErrorCode: string | null = props.state.error?.code ?? null;
const currentTime = ref(props.state.currentTime);
const duration = ref(props.state.duration);
const localVolume = ref(normalizeVolume(props.state.volume));
const muted = ref(props.state.muted);
let lastNonZeroVolume = localVolume.value > 0 ? localVolume.value : 1;
let hls: Hls | null = null;
let shakaPlayer: ShakaPlayer | null = null;
const qualityOptions = ref<QualityOption[]>([]);
const selectedQualityId = ref("auto");
let shakaTracks = new Map<string, ShakaVariantTrack>();
let shakaTextTracks = new Map<string, ShakaTextTrack>();
const cleanups: Array<() => void> = [];
let positionRestored = false;
let resumeRequested = false;
const subtitleTracks = ref<SubtitleTrack[]>([]);
const localSubtitleBytes = new Map<string, Uint8Array>();
const subtitleSources = ref<Array<{ id: string; url: string; language: string; label: string; forced: boolean }>>([]);
const subtitleElements = ref<HTMLTrackElement[]>([]);
const subtitleEnabled = ref(false);
const selectedSubtitleId = ref<string | null>(null);
const subtitleEncoding = ref<"auto" | SubtitleEncoding>("auto");
const subtitleFontSize = ref(24);
const subtitlePosition = ref<"bottom" | "top">("bottom");
const subtitleBackground = ref<"none" | "box" | "shadow">("shadow");
const subtitleLoading = ref(false);
const subtitleError = ref<string | null>(null);
const previewUrl = computed(() => {
  const source = props.state.source;
  const progressive = source?.mediaType === "mp4" || (source ? /\.(?:mp4|webm)(?:$|[?#])/iu.test(source.url) : false);
  if (!source || !progressive || isHls(source.url) || isDash(source.url)) return null;
  return source.url;
});
const subtitleUrls = new SubtitleObjectUrlRegistry();
let localSubtitleSequence = 0;
let subtitleLoadGeneration = 0;
let startupTimer: ReturnType<typeof setInterval> | undefined;
let controlsHideTimer: ReturnType<typeof setTimeout> | undefined;
let firstFrameReported = false;
let sourceLoadGeneration = 0;
let lastTimeupdateSyncAt = 0;
let deferredSubtitleTrackId: string | null = null;
const controlsVisible = ref(true);
const playbackRate = ref(props.state.playbackRate ?? 1);

function setPlaybackRate(value: number): void {
  if (![0.5, 0.75, 1, 1.25, 1.5, 2].includes(value)) return;
  playbackRate.value = value;
  if (video.value) video.value.playbackRate = value;
  emitSync();
}


const sourcePlaybackKey = computed(() => {
  const source = props.state.source;
  if (!source) return "";
  return `${props.playbackKey ?? props.sessionId ?? ""}|${source.url}`;
});

watch(sourcePlaybackKey, () => {
  void nextTick(() => { void loadSource(); });
}, { flush: "post" });

watch(
  () => {
    const tracks = props.state.source?.subtitles ?? [];
    return `${props.state.source?.url ?? ""}|${tracks.map((track) => `${track.id}:${track.url ?? ""}:${track.format}:${track.default}:${track.forced}`).join(";")}`;
  },
  resetSubtitleCatalog,
  { immediate: true },
);

watch(() => props.state.volume, (volume) => {
  const normalized = normalizeVolume(volume);
  localVolume.value = normalized;
  if (normalized > 0) lastNonZeroVolume = normalized;
  if (video.value) video.value.volume = normalized;
});

watch(() => props.state.muted, (mutedValue) => {
  if (video.value) video.value.muted = mutedValue;
  muted.value = mutedValue;
});

watch(() => props.state.status, (status) => {
  if (!props.state.source) localStatus.value = status;
});

watch(() => props.state.error?.message, (message) => {
  localError.value = message ?? null;
});

watch(() => props.state.error?.code, (code) => {
  localErrorCode = code ?? null;
});

onMounted(() => {
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("fullscreenerror", handleFullscreenError);
  handleFullscreenChange();
  void loadSource();
});

onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.removeEventListener("fullscreenerror", handleFullscreenError);
  if (document.fullscreenElement === playerStage.value) void document.exitFullscreen?.().catch(() => undefined);
  // A resolving placeholder has no media progress to save. Sending idle here
  // would replace the failed playback request with a successful sync envelope.
  if (props.state.source) emitSync(localStatus.value);
  clearStartupTimer();
  clearControlsHideTimer();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  destroyHls();
  destroyShaka();
  clearQualityOptions();
  shakaTextTracks.clear();
  clearSubtitleResources();
  localSubtitleBytes.clear();
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
});

async function loadSource(): Promise<void> {
  const element = video.value;
  if (!element) return;
  const generation = ++sourceLoadGeneration;
  cleanups.splice(0).forEach((cleanup) => cleanup());
  clearStartupTimer();
  destroyHls();
  destroyShaka();
  clearQualityOptions();
  shakaTextTracks.clear();
  clearSubtitleResources();
  keepControlsVisible();
  positionRestored = false;
  resumeRequested = false;
  lastTimeupdateSyncAt = 0;
  element.pause();
  element.removeAttribute("src");
  element.load();
  localError.value = props.state.error?.message ?? null;
  localErrorCode = props.state.error?.code ?? null;
  const source = props.state.source;
  if (!source) {
    localStatus.value = props.state.status;
    return;
  }
  localVolume.value = normalizeVolume(props.state.volume);
  if (localVolume.value > 0) lastNonZeroVolume = localVolume.value;
  element.volume = localVolume.value;
  element.muted = props.state.muted;
  playbackRate.value = props.state.playbackRate ?? playbackRate.value;
  element.playbackRate = playbackRate.value;
  // LocalProxy uses a dynamic localhost port, so opt the media element into
  // CORS before HLS.js attaches its MediaSource buffer.
  element.crossOrigin = "anonymous";
  localStatus.value = "loading";
  firstFrameReported = false;
  const watchdog = new PlaybackProgressWatchdog(performance.now() - Math.max(0, Date.now() - (props.state.startedAt ?? Date.now())));
  let playingIntent = !props.state.resumePaused && ["resolving", "loading", "playing"].includes(props.state.status);
  startupTimer = setInterval(() => {
    if (!video.value || generation !== sourceLoadGeneration) return;
    const failure = watchdog.check(performance.now(), playingIntent, element.seeking);
    if (!failure) return;
    localStatus.value = "error";
    keepControlsVisible();
    localErrorCode = failure === "stalled" ? "PLAYBACK_STALLED" : "PLAYBACK_STARTUP_TIMEOUT";
    localError.value = failure === "stalled" ? "播放停滞，正在恢复" : "起播超时";
    emitSync("error", failure === "stalled" ? { type: "fatal-error", code: localErrorCode } : { type: "startup-timeout", reason: "起播超时" });
  }, 500);
  const decodedFrame = (position: number): void => {
    watchdog.progress(performance.now(), position, !firstFrameReported);
    if (firstFrameReported) return;
    firstFrameReported = true;
    emitSync(localStatus.value, { type: "first-frame" });
  };
  if (typeof element.requestVideoFrameCallback === "function") {
    let frameId = 0;
    const frame: VideoFrameRequestCallback = (_now, metadata) => {
      if (generation !== sourceLoadGeneration) return;
      decodedFrame(metadata.mediaTime);
      frameId = element.requestVideoFrameCallback(frame);
    };
    frameId = element.requestVideoFrameCallback(frame);
    cleanups.push(() => element.cancelVideoFrameCallback(frameId));
  }
  listen(element, "play", () => { playingIntent = true; });
  listen(element, "playing", () => {
    localStatus.value = "playing";
    localError.value = null;
    localErrorCode = null;
    if (deferredSubtitleTrackId && subtitleEnabled.value) {
      deferredSubtitleTrackId = null;
      void loadSelectedSubtitle();
    }
    scheduleControlsHide();
    emitSync("playing");
  });
  const loadsThroughShaka = source.mediaType === "dash" || isDash(source.url) || source.drm;
  if (loadsThroughShaka) {
    void loadWithShaka(element, source);
  } else if (source.mediaType === "hls" || isHls(source.url)) {
    const hlsModule = await import("hls.js");
    const HlsPlayer = hlsModule.default;
    if (generation !== sourceLoadGeneration || !video.value) return;
    if (!HlsPlayer.isSupported()) {
      element.src = source.url;
      element.load();
    } else {
      hls = new HlsPlayer({
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: true,
        maxBufferLength: 30,
        // Keep in-memory HLS media buffering bounded; media segments are not persisted by the app.
        maxBufferSize: HLS_MAX_BUFFER_SIZE_BYTES,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        capLevelToPlayerSize: true,
        ...(Number.isFinite(props.state.currentTime) && props.state.currentTime > 0
          ? { startPosition: props.state.currentTime }
          : {}),
      });
      hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
        if (!hls) return;
        const levels = hls.levels.map((level, index) => ({
          id: String(index),
          label: qualityLabel(level.height, level.bitrate, index),
        }));
        setQualityOptions(levels);
      });
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        const status = typeof data.response?.code === "number" ? data.response.code : undefined;
        if (status !== undefined) emitSync(localStatus.value, { type: "http-status", status });
        const details = String(data.details ?? "");
        if (!data.fatal) {
          if (/manifest|playlist|levelload|level_load/i.test(details)) {
            emitSync(localStatus.value, { type: "playlist-refresh-failure", reason: details || "播放列表刷新失败" });
          } else if (/network|disconnect|timeout/i.test(details)) {
            emitSync(localStatus.value, { type: "disconnect", reason: details || "播放器连接断开" });
          } else if (/frag|segment|buffer/i.test(details)) {
            emitSync(localStatus.value, { type: "segment-failure", reason: details || "分片失败" });
          }
          return;
        }
        localStatus.value = "error";
        keepControlsVisible();
        localErrorCode = `HLS_${details.replace(/[^a-z0-9_-]/gi, "").slice(0, 80).toUpperCase() || "ERROR"}`;
        localError.value = "HLS 播放失败";
        emitSync("error", { type: "fatal-error", code: localErrorCode });
      });
      hls.loadSource(source.url);
      hls.attachMedia(element);
    }
  } else {
    element.src = source.url;
    element.load();
  }
  listen(element, "loadstart", () => { localStatus.value = "loading"; });
  const restorePosition = () => {
    duration.value = Number.isFinite(element.duration) ? element.duration : 0;
    const target = props.state.currentTime;
    if (!positionRestored && target > 0 && Number.isFinite(target)) {
      const boundedTarget = Math.min(target, duration.value || target);
      element.currentTime = boundedTarget;
      currentTime.value = element.currentTime;
      positionRestored = Math.abs(element.currentTime - boundedTarget) <= PLAYBACK_RESTORE_MAX_DRIFT_SECONDS;
    }
    emitSync();
  };
  listen(element, "loadedmetadata", restorePosition);
  listen(element, "durationchange", restorePosition);
  listen(element, "canplay", resumeIfNeeded);
  listen(element, "waiting", () => {
    keepControlsVisible();
    emitSync(localStatus.value, { type: "buffer-start" });
  });
  listen(element, "canplay", () => emitSync(localStatus.value, { type: "buffer-end" }));
  listen(element, "timeupdate", () => {
    if (typeof element.requestVideoFrameCallback !== "function" && element.getVideoPlaybackQuality?.().totalVideoFrames > 0) decodedFrame(element.currentTime);
    currentTime.value = element.currentTime;
    duration.value = Number.isFinite(element.duration) ? element.duration : duration.value;
    const now = performance.now();
    if (now - lastTimeupdateSyncAt >= 250) {
      lastTimeupdateSyncAt = now;
      emitSync();
    }
  });
  listen(element, "volumechange", () => {
    localVolume.value = element.volume;
    if (element.volume > 0) lastNonZeroVolume = element.volume;
    muted.value = element.muted;
    emitSync();
  });
  listen(element, "pause", () => {
    playingIntent = false;
    if (!element.ended) {
      localStatus.value = "paused";
      keepControlsVisible();
      emitSync("paused", { type: "user-pause" });
    }
  });
  listen(element, "seeking", () => emitSync(localStatus.value, { type: "seek" }));
  listen(element, "ended", () => {
    playingIntent = false;
    localStatus.value = "ended";
    keepControlsVisible();
    emitSync("ended", { type: "completion" });
  });
  listen(element, "error", () => {
    localStatus.value = "error";
    keepControlsVisible();
    localErrorCode ??= "HTML_VIDEO_ERROR";
    localError.value = "播放失败";
    emitSync("error", { type: "fatal-error", code: localErrorCode ?? "HTML_VIDEO_ERROR" });
  });
  if (!loadsThroughShaka) resumeIfNeeded();
}

function resumeIfNeeded(): void {
  const element = video.value;
  if (!element || resumeRequested || !props.state.source) return;
  if (props.state.resumePaused) { localStatus.value = "paused"; return; }
  if (props.state.status !== "resolving"
    && props.state.status !== "loading"
    && props.state.status !== "playing") return;
  resumeRequested = true;
  try {
    const result = element.play();
    if (result && typeof result.catch === "function") void result.catch(handleInitialPlayError);
  } catch (error) {
    handleInitialPlayError(error);
  }
}

function handleInitialPlayError(error: unknown): void {
    localStatus.value = "error";
    keepControlsVisible();
    localErrorCode = "HTML_VIDEO_PLAY_ERROR";
    localError.value = error instanceof Error ? error.message : "播放恢复失败";
    emitSync("error", { type: "fatal-error", code: localErrorCode ?? "HTML_VIDEO_PLAY_ERROR" });
}

function setVolume(value: number): void {
  const normalized = normalizeVolume(value);
  localVolume.value = normalized;
  if (normalized > 0) lastNonZeroVolume = normalized;
  if (video.value) {
    video.value.volume = normalized;
    if (normalized > 0 && video.value.muted) video.value.muted = false;
    muted.value = video.value.muted;
  } else if (normalized > 0) {
    muted.value = false;
  }
  emitSync();
}

function setSeek(value: number): void {
  if (video.value) {
    video.value.currentTime = value;
    currentTime.value = video.value.currentTime;
  }
  emitSync();
}

function toggleMute(): void {
  const element = video.value;
  const silent = muted.value || localVolume.value <= 0;
  if (silent) {
    if (localVolume.value <= 0) {
      localVolume.value = lastNonZeroVolume;
      if (element) element.volume = lastNonZeroVolume;
    }
    muted.value = false;
    if (element) element.muted = false;
  } else {
    if (localVolume.value > 0) lastNonZeroVolume = localVolume.value;
    muted.value = true;
    if (element) element.muted = true;
  }
  emitSync();
}

function stopPlayback(): void {
  clearStartupTimer();
  destroyHls();
  destroyShaka();
  clearQualityOptions();
  clearSubtitleResources();
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
  localStatus.value = "stopped";
  keepControlsVisible();
  localErrorCode = null;
  localError.value = null;
  emit("stop");
  emitSync("stopped");
}

function emitSync(status = localStatus.value, event?: PlaybackMediaEvent): void {
  const element = video.value;
  const error = status === "error" && localError
    ? { code: localErrorCode ?? "HTML_VIDEO_ERROR", message: localError }
    : undefined;
  emit("sync", {
    ...(props.sessionId ? { sessionId: props.sessionId } : {}),
    status: status as PlayerState["status"],
    currentTime: element?.currentTime ?? currentTime.value,
    duration: element && Number.isFinite(element.duration) ? element.duration : duration.value,
    volume: element?.volume ?? props.state.volume,
    muted: element?.muted ?? muted.value,
    playbackRate: element?.playbackRate ?? playbackRate.value,
    ...(event ? { event: { ...event, at: event.at ?? Date.now() } } : {}),
    ...(error ? { error } : {}),
  });
}

function clearStartupTimer(): void {
  if (startupTimer !== undefined) clearInterval(startupTimer);
  startupTimer = undefined;
}

function clearControlsHideTimer(): void {
  if (controlsHideTimer !== undefined) clearTimeout(controlsHideTimer);
  controlsHideTimer = undefined;
}

function keepControlsVisible(): void {
  clearControlsHideTimer();
  controlsVisible.value = true;
}

function scheduleControlsHide(): void {
  clearControlsHideTimer();
  controlsVisible.value = true;
  if (localStatus.value !== "playing") return;
  controlsHideTimer = setTimeout(() => {
    controlsHideTimer = undefined;
    const stage = playerStage.value;
    const focusInside = stage !== null && document.activeElement !== null && stage.contains(document.activeElement);
    if (localStatus.value === "playing" && !focusInside) controlsVisible.value = false;
  }, PLAYER_CONTROLS_HIDE_DELAY_MS);
}

function showControls(): void {
  scheduleControlsHide();
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function destroyHls(): void {
  if (hls) hls.destroy();
  hls = null;
}

function clearQualityOptions(): void {
  qualityOptions.value = [];
  selectedQualityId.value = "auto";
  shakaTracks.clear();
}

function setQualityOptions(options: QualityOption[]): void {
  const unique = new Map<string, QualityOption>();
  for (const option of options) unique.set(option.id, option);
  const entries = [...unique.values()];
  qualityOptions.value = entries.length > 1
    ? [{ id: "auto", label: "自动" }, ...entries]
    : [];
  selectedQualityId.value = "auto";
}

function qualityLabel(height: number | undefined, bitrate: number | undefined, index: number): string {
  const resolution = Number.isFinite(height) && height && height > 0 ? `${height}p` : `档位 ${index + 1}`;
  const rate = Number.isFinite(bitrate) && bitrate && bitrate > 0 ? ` · ${Math.round(bitrate / 1000)} kbps` : "";
  return `${resolution}${rate}`;
}

function destroyShaka(): void {
  const player = shakaPlayer;
  shakaPlayer = null;
  if (player) void player.destroy();
}

async function loadWithShaka(element: HTMLVideoElement, source: NonNullable<PlayerState["source"]>): Promise<void> {
  let shakaErrorCode: number | null = null;
  try {
    const shaka = (await import("shaka-player")).default;
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      throw new Error("SHAKA_BROWSER_UNSUPPORTED");
    }
    const player = new shaka.Player(element);
    shakaPlayer = player;
    player.addEventListener("error", (event: Event) => {
      const detail = (event as CustomEvent<{ code?: unknown }>).detail;
      localStatus.value = "error";
      keepControlsVisible();
      localErrorCode = "SHAKA_ERROR";
      if (detail && typeof detail.code === "number") {
        shakaErrorCode = detail.code;
        localErrorCode = `SHAKA_ERROR_${detail.code}`;
        localError.value = `SHAKA_ERROR_${detail.code}`;
      } else {
        localError.value = "SHAKA_ERROR";
      }
      emitSync("error", { type: "fatal-error", code: localErrorCode });
    });
    if (source.drm) {
      player.configure({
        drm: {
          clearKeys: source.drm.clearKeys ?? {},
          servers: source.drm.servers ?? {},
        },
      });
    }
    player.configure({
      streaming: {
        bufferingGoal: 30,
        rebufferingGoal: 5,
        bufferBehind: 30,
        retryParameters: {
          maxAttempts: 4,
          baseDelay: 500,
          backoffFactor: 2,
          fuzzFactor: 0.5,
        },
      },
    });
    await player.load(source.url);
    const tracks = player.getVariantTracks();
    shakaTracks = new Map(tracks.map((track) => [String(track.id), track]));
    setQualityOptions(tracks.map((track) => ({
      id: String(track.id),
      label: qualityLabel(track.height, track.bandwidth, track.id),
    })));
    const textTracks = player.getTextTracks().filter((track) => track.kind !== "metadata");
    shakaTextTracks = new Map(textTracks.map((track) => [`shaka-${track.id}`, track]));
    if (textTracks.length > 0) {
      const existing = subtitleTracks.value.filter((track) => !track.id.startsWith("shaka-"));
      subtitleTracks.value = [
        ...existing,
        ...textTracks.map((track) => ({
          id: `shaka-${track.id}`,
          label: track.label || track.language || `Text ${track.id}`,
          language: track.language || "und",
          format: "vtt" as const,
          default: track.active,
          forced: track.forced,
          source: "source" as const,
        })),
      ];
      const active = textTracks.find((track) => track.active);
      selectedSubtitleId.value = active ? `shaka-${active.id}` : null;
      subtitleEnabled.value = active !== undefined;
    }
    if (shakaPlayer === player) resumeIfNeeded();
  } catch (error) {
    if (shakaPlayer) destroyShaka();
    const caughtErrorCode = error && typeof error === "object" && "code" in error
      && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : null;
    if (shakaErrorCode === null && caughtErrorCode !== null) shakaErrorCode = caughtErrorCode;
    localStatus.value = "error";
    keepControlsVisible();
    localErrorCode = shakaErrorCode !== null
      ? `SHAKA_ERROR_${shakaErrorCode}`
      : error instanceof Error && error.message === "SHAKA_BROWSER_UNSUPPORTED"
      ? "SHAKA_BROWSER_UNSUPPORTED"
      : "SHAKA_LOAD_FAILED";
    localError.value = shakaErrorCode !== null
      ? `SHAKA_ERROR_${shakaErrorCode}`
      : error instanceof Error ? error.message : "Shaka playback failed";
    emitSync("error", { type: "fatal-error", code: localErrorCode });
  }
}

function selectQuality(id: string): void {
  if (hls) {
    if (id === "auto") {
      hls.currentLevel = -1;
    } else {
      const level = Number(id);
      if (!Number.isInteger(level) || level < 0 || level >= hls.levels.length) return;
      hls.currentLevel = level;
    }
    selectedQualityId.value = id;
    return;
  }
  if (shakaPlayer) {
    if (id === "auto") {
      shakaPlayer.configure({ abr: { enabled: true } });
    } else {
      const track = shakaTracks.get(id);
      if (!track) return;
      shakaPlayer.configure({ abr: { enabled: false } });
      shakaPlayer.selectVariantTrack(track, true);
    }
    selectedQualityId.value = id;
  }
}

function resetSubtitleCatalog(): void {
  clearSubtitleResources();
  localSubtitleBytes.clear();
  shakaTextTracks.clear();
  subtitleTracks.value = [...(props.state.source?.subtitles ?? [])];
  const defaultTrack = subtitleTracks.value.find((track) => track.default)
    ?? subtitleTracks.value.find((track) => track.forced);
  selectedSubtitleId.value = defaultTrack?.id ?? null;
  subtitleEnabled.value = defaultTrack !== undefined;
  subtitleEncoding.value = "auto";
  deferredSubtitleTrackId = null;
  if (defaultTrack) {
    if (defaultTrack.forced || firstFrameReported) void loadSelectedSubtitle();
    else deferredSubtitleTrackId = defaultTrack.id;
  }
}

function clearSubtitleResources(): void {
  subtitleLoadGeneration += 1;
  subtitleUrls.revokeAll();
  subtitleSources.value = [];
  subtitleLoading.value = false;
  subtitleError.value = null;
}

function selectSubtitle(trackId: string | null): void {
  selectedSubtitleId.value = trackId;
  subtitleEnabled.value = trackId !== null;
  if (shakaPlayer && (trackId === null || shakaTextTracks.has(trackId))) {
    shakaPlayer.selectTextTrack(trackId === null ? undefined : shakaTextTracks.get(trackId));
    subtitleLoading.value = false;
    subtitleError.value = null;
    return;
  }
  void loadSelectedSubtitle();
}

function toggleSubtitle(enabled: boolean): void {
  subtitleEnabled.value = enabled;
  if (shakaPlayer && selectedSubtitleId.value && shakaTextTracks.has(selectedSubtitleId.value)) {
    shakaPlayer.selectTextTrack(enabled ? shakaTextTracks.get(selectedSubtitleId.value) : undefined);
    return;
  }
  syncNativeTrackModes();
  if (enabled && selectedSubtitleId.value) void loadSelectedSubtitle();
}

function changeSubtitleEncoding(encoding: "auto" | SubtitleEncoding): void {
  subtitleEncoding.value = encoding;
  if (selectedSubtitleId.value) void loadSelectedSubtitle();
}

function changeSubtitlePosition(position: "bottom" | "top"): void {
  subtitlePosition.value = position;
  if (selectedSubtitleId.value) void loadSelectedSubtitle();
}

function addLocalSubtitle(file: File): void {
  void (async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const format = detectSubtitleFormat(bytes, file.name) ?? subtitleFormatFromName(file.name);
      if (!format) throw new SubtitleParseError("SUBTITLE_FORMAT_UNKNOWN", "无法识别本地字幕格式。");
      const id = `local-${++localSubtitleSequence}`;
      localSubtitleBytes.set(id, bytes);
      subtitleTracks.value = [
        ...subtitleTracks.value,
        {
          id,
          label: file.name,
          language: "und",
          format,
          default: false,
          forced: false,
          source: "local",
        },
      ];
      selectedSubtitleId.value = id;
      subtitleEnabled.value = true;
      subtitleEncoding.value = "auto";
      await loadSelectedSubtitle();
    } catch (error) {
      subtitleError.value = subtitleErrorMessage(error, "本地字幕加载失败。");
    }
  })();
}

async function loadSelectedSubtitle(): Promise<void> {
  const generation = ++subtitleLoadGeneration;
  const id = selectedSubtitleId.value;
  subtitleUrls.revokeAll();
  subtitleSources.value = [];
  if (!id) {
    return;
  }
  const track = subtitleTracks.value.find((candidate) => candidate.id === id);
  if (!track) return;
  subtitleLoading.value = true;
  subtitleError.value = null;
  try {
    let bytes = localSubtitleBytes.get(track.id);
    if (!bytes) {
      if (!track.url) throw new SubtitleParseError("SUBTITLE_FORMAT_UNKNOWN", "字幕没有可读取的地址。");
      if (track.headers && Object.keys(track.headers).length > 0) {
        throw new SubtitleParseError("SUBTITLE_PROXY_REQUIRED", "远程字幕必须由 LocalProxy 注入请求头。");
      }
      if (/^https?:/i.test(track.url) && !isLocalProxySubtitleUrl(track.url)) {
        throw new SubtitleParseError("SUBTITLE_PROXY_REQUIRED", "远程字幕必须经过 LocalProxy。");
      }
      const response = await fetch(track.url);
      if (!response.ok) throw new SubtitleParseError("SUBTITLE_LOAD_FAILED", "字幕请求失败。");
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (generation !== subtitleLoadGeneration) return;
    const parsed = parseSubtitle(bytes, {
      format: track.format,
      ...(subtitleEncoding.value !== "auto" ? { encoding: subtitleEncoding.value } : {}),
    });
    const blob = new Blob([subtitleToWebVtt(parsed, { position: subtitlePosition.value })], { type: "text/vtt;charset=utf-8" });
    const url = subtitleUrls.create(track.id, blob);
    if (generation !== subtitleLoadGeneration) {
      subtitleUrls.revoke(track.id);
      return;
    }
    subtitleSources.value = [{
      id: track.id,
      url,
      language: track.language,
      label: track.label,
      forced: track.forced,
    }];
    subtitleError.value = null;
    await nextTick();
    syncNativeTrackModes();
  } catch (error) {
    if (generation !== subtitleLoadGeneration) return;
    subtitleUrls.revoke(id);
    subtitleSources.value = [];
    subtitleError.value = subtitleErrorMessage(error, "字幕加载失败。");
  } finally {
    if (generation === subtitleLoadGeneration) subtitleLoading.value = false;
  }
}

function syncNativeTrackModes(): void {
  void nextTick(() => {
    for (const element of subtitleElements.value) {
      try {
        element.track.mode = subtitleEnabled.value && element.dataset.subtitleId === selectedSubtitleId.value
          ? "showing"
          : "disabled";
      } catch {
        // The browser can expose a track element before its TextTrack is ready.
      }
    }
  });
}

function subtitleErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof SubtitleParseError) return `${error.code}：${error.message}`;
  return error instanceof Error ? error.message : fallback;
}

function listen<K extends keyof HTMLMediaElementEventMap>(
  element: HTMLVideoElement,
  event: K,
  handler: (event: HTMLMediaElementEventMap[K]) => void,
): void {
  element.addEventListener(event, handler as EventListener);
  cleanups.push(() => element.removeEventListener(event, handler as EventListener));
}

function isHls(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

function isDash(url: string): boolean {
  return /\.mpd(?:$|[?#])/i.test(url);
}

function normalizeVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function play(): void { void video.value?.play(); }
function pause(): void { video.value?.pause(); }

function handleFullscreenChange(): void {
  fullscreenActive.value = document.fullscreenElement === playerStage.value;
  if (fullscreenActive.value || document.fullscreenElement === null) fullscreenError.value = null;
  keepControlsVisible();
  if (fullscreenActive.value && localStatus.value === "playing") scheduleControlsHide();
}

function handleFullscreenError(): void {
  fullscreenActive.value = false;
  fullscreenError.value = "全屏切换失败，请重试。";
  keepControlsVisible();
}

async function fullscreen(): Promise<void> {
  const stage = playerStage.value;
  if (!stage) return;
  fullscreenError.value = null;
  try {
    if (document.fullscreenElement === stage) {
      await document.exitFullscreen?.();
      return;
    }
    if (!stage.requestFullscreen) throw new Error("FULLSCREEN_UNAVAILABLE");
    await stage.requestFullscreen();
  } catch {
    handleFullscreenError();
  }
}

function statusLabel(state: PlayerState, status: string, error: string | null): string {
  if (error) return error;
  if (status === state.status && state.error) return state.error.message;
  const labels: Record<PlayerState["status"], string> = {
    idle: "等待播放",
    resolving: "正在解析",
    loading: "正在加载",
    playing: "播放中",
    paused: "已暂停",
    ended: "播放结束",
    stopped: "已停止",
    error: "播放失败",
  };
  return labels[status as PlayerState["status"]] ?? labels.idle;
}

function parserStatusLabel(
  status: NonNullable<PlayerState["parse"]>["status"],
  parserId: string | null,
): string {
  const labels: Record<typeof status, string> = {
    idle: "等待解析",
    resolving: "正在解析",
    attempting: "正在尝试解析器",
    failed: "解析器失败",
    succeeded: "解析成功",
    cancelled: "解析已取消",
  };
  return parserId ? `${labels[status]}：${parserId}` : labels[status];
}
</script>

<template>
  <section
    data-testid="embedded-player-panel"
    data-od-id="embedded-player"
    class="panel embedded-player-panel"
    :data-player-status="localStatus"
    :data-subtitle-position="subtitlePosition"
    :data-subtitle-background="subtitleBackground"
    :data-subtitle-font-size="subtitleFontSize"
    :style="{ '--subtitle-font-size': subtitleFontSize }"
  >
    <template v-if="props.state.source">
      <div
        ref="playerStage"
        data-testid="embedded-player-stage"
        data-aspect-ratio="16:9"
        :data-fullscreen="fullscreenActive"
        class="player-video-stage"
        :class="{ 'is-controls-hidden': !controlsVisible }"
        @pointermove="showControls"
        @pointerleave="scheduleControlsHide"
        @focusin="keepControlsVisible"
        @focusout="scheduleControlsHide"
      >
        <video ref="video" data-testid="embedded-player" playsinline preload="auto" aria-label="视频播放器" @loadedmetadata="setPlaybackRate(playbackRate)">
          <track
            v-for="subtitle in subtitleSources"
            :key="subtitle.id"
            ref="subtitleElements"
            kind="subtitles"
            :src="subtitle.url"
            :srclang="subtitle.language"
            :label="subtitle.label"
            :data-subtitle-id="subtitle.id"
            :default="subtitle.forced || subtitle.id === selectedSubtitleId"
          >
        </video>
        <div
          v-if="localStatus === 'loading' || localStatus === 'resolving'"
          class="player-stage-status"
          data-testid="player-loading-overlay"
          aria-live="polite"
        >
          <span class="loading-bar" aria-hidden="true"></span>
          <span>正在准备首帧</span>
        </div>
        <div
          v-else-if="localStatus === 'error' && localError"
          class="player-stage-status player-stage-error"
          data-testid="player-error-overlay"
          role="alert"
        >
          <span>{{ localError }}</span>
          <button type="button" data-action="player-inline-retry" @click.stop="loadSource">重试</button>
        </div>
        <p v-if="fullscreenError" class="player-fullscreen-error" data-testid="player-fullscreen-error" role="alert">{{ fullscreenError }}</p>
        <DanmakuOverlay
          v-if="props.danmaku"
          :state="props.danmaku"
          :current-time="currentTime"
        />
        <div
          data-testid="player-controls-overlay"
          class="player-controls-overlay"
          @pointerenter="keepControlsVisible"
          @focusin="keepControlsVisible"
          @focusout="scheduleControlsHide"
        >
          <PlayerControls
            :status="localStatus"
            :current-time="currentTime"
            :duration="duration"
            :volume="localVolume"
            :muted="muted"
            :fullscreen="fullscreenActive"
            :preview-url="previewUrl"
            :detachable="props.detachable !== false"
            @play="play"
            @pause="pause"
            @resume="play"
            @stop="stopPlayback"
            @detach="emit('detach')"
            @reload="loadSource"
            @seek="setSeek"
            @volume="setVolume"
            @mute="toggleMute"
            :quality-options="qualityOptions"
            :quality-id="selectedQualityId"
            @quality="selectQuality"
            @fullscreen="fullscreen"
            :playback-rate="playbackRate"
            @rate="setPlaybackRate"
          >
            <template #settings>
              <details class="player-subtitle-settings">
                <summary>字幕设置</summary>
      <SubtitleTrackPanel
        :tracks="subtitleTracks"
        :enabled="subtitleEnabled"
        :selected-track-id="selectedSubtitleId"
        :encoding="subtitleEncoding"
        :font-size="subtitleFontSize"
        :position="subtitlePosition"
        :background="subtitleBackground"
        :loading="subtitleLoading"
        :error="subtitleError"
        @toggle="toggleSubtitle"
        @select="selectSubtitle"
        @encoding="changeSubtitleEncoding"
        @font-size="subtitleFontSize = $event"
        @position="changeSubtitlePosition"
        @background="subtitleBackground = $event"
        @local-file="addLocalSubtitle"
      />
              </details>
            </template>
          </PlayerControls>
        </div>
      </div>

    </template>
    <div v-if="!props.state.source" class="player-preparing" role="status">
      <span>{{ statusLabel(props.state, localStatus, localError) }}</span>
    </div>
    <details class="player-metadata">
      <summary>播放详情</summary>
      <p data-testid="player-status" class="player-status-meta">{{ statusLabel(props.state, localStatus, localError) }}</p>
      <p
        v-if="props.state.parse && props.state.parse.status !== 'idle'"
        data-testid="parser-status"
        class="player-parser-meta"
      >{{ parserStatusLabel(props.state.parse.status, props.state.parse.parserId) }}</p>
      <details v-if="props.state.parse && props.state.parse.attempts.length > 0" data-testid="parser-diagnostics" class="player-parser-diagnostics">
        <summary>解析尝试（{{ props.state.parse.attempts.length }}）</summary>
        <ul>
          <li v-for="attempt in props.state.parse.attempts" :key="`${attempt.parserId}-${attempt.elapsedMs}`">
            {{ attempt.parserId }} · {{ attempt.status }} · {{ attempt.elapsedMs }}ms
          </li>
        </ul>
      </details>

      <p v-if="localError" class="player-error player-error-meta" data-testid="player-error">{{ localError }} <code>{{ localErrorCode }}</code></p>
    </details>
  </section>
</template>
