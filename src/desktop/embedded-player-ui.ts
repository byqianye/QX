import type { PlaybackState } from "./playback.js";

export interface EmbeddedPlayerRenderOptions {
  sessionId?: string;
}

export function renderEmbeddedPlayer(
  state: PlaybackState,
  options: EmbeddedPlayerRenderOptions = {},
): string {
  const source = state.source;
  const hasSource = source !== null;
  const hls = hasSource && (source.mediaType === "hls" || isHlsUrl(source.url));
  const sourceUrl = JSON.stringify(source?.url ?? "");
  const sessionId = JSON.stringify(options.sessionId ?? "");
  const status = escapeHtml(state.status);
  const error = state.error
    ? `<p class="player-error" data-testid="player-error">${escapeHtml(state.error.message)}</p>`
    : "";
  const parserStatus = state.parse && state.parse.status !== "idle"
    ? `<p data-testid="parser-status">${escapeHtml(parserStatusLabel(state.parse.status, state.parse.parserId))}</p>`
    : "";
  const parserDiagnostics = state.parse && state.parse.attempts.length > 0
    ? `<details data-testid="parser-diagnostics"><summary>解析尝试（${state.parse.attempts.length}）</summary><ul>${state.parse.attempts
      .map((attempt) => `<li>${escapeHtml(attempt.parserId)} · ${escapeHtml(attempt.status)} · ${attempt.elapsedMs}ms</li>`)
      .join("")}</ul></details>`
    : "";

  if (!hasSource) {
    return `<section data-testid="embedded-player-panel" class="embedded-player-panel" data-player-status="${status}">
      <strong>内嵌播放器</strong>
      <p data-testid="player-status">${escapeHtml(statusLabel(state))}</p>
      ${parserStatus}
      ${parserDiagnostics}
      ${error}
    </section>`;
  }

  return `${hls ? '<script src="/assets/hls.min.js"></script>' : ""}
    <section data-testid="embedded-player-panel" class="embedded-player-panel" data-player-status="${status}">
      <video data-testid="embedded-player" playsinline controls preload="metadata"></video>
      <div class="player-controls" aria-label="播放器控制">
        <button data-action="player-play" data-testid="player-play">播放</button>
        <button data-action="player-pause">暂停</button>
        <button data-action="player-resume">恢复</button>
        <button data-action="player-stop">停止</button>
        <button data-action="player-reload">重新加载</button>
        <label>进度 <input data-action="player-seek" data-testid="player-seek" type="range" min="0" max="0" step="0.1" value="0"></label>
        <span data-testid="player-time">0:00 / 0:00</span>
        <label>音量 <input data-action="player-volume" type="range" min="0" max="1" step="0.01" value="${state.volume}"></label>
        <button data-action="player-mute">${state.muted ? "取消静音" : "静音"}</button>
        <button data-action="player-fullscreen">全屏</button>
        <button data-action="player-detach">独立窗口</button>
      </div>
      <p data-testid="player-status">${escapeHtml(statusLabel(state))}</p>
      ${parserStatus}
      ${parserDiagnostics}
      ${error}
    </section>
    <script>
      (() => {
        const sourceUrl = ${sourceUrl};
        const sessionId = ${sessionId};
        const video = document.querySelector('[data-testid="embedded-player"]');
        const panel = document.querySelector('[data-testid="embedded-player-panel"]');
        const status = document.querySelector('[data-testid="player-status"]');
        const seek = document.querySelector('[data-action="player-seek"]');
        const time = document.querySelector('[data-testid="player-time"]');
        const hlsReady = new Promise((resolve) => {
          const started = Date.now();
          const wait = () => {
            if (window.Hls) { resolve(window.Hls); return; }
            if (Date.now() - started >= 10_000) { resolve(null); return; }
            window.setTimeout(wait, 25);
          };
          wait();
        });
        let hlsInstance = null;
        const listeners = [];
        let syncQueue = Promise.resolve();

        if (!video) return;
        // The LocalProxy is intentionally served from a dynamic localhost
        // port, so the embedded media element must opt into CORS before HLS.js
        // attaches its MediaSource buffer.
        video.crossOrigin = 'anonymous';

        const on = (target, event, handler) => {
          target.addEventListener(event, handler);
          listeners.push(() => target.removeEventListener(event, handler));
        };

        const setStatus = (value) => {
          if (panel) panel.dataset.playerStatus = value;
          if (status) status.textContent = value;
        };
        const mediaState = () => ({
          currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          volume: Number.isFinite(video.volume) ? video.volume : 1,
          muted: Boolean(video.muted),
        });
        const sync = (payload) => {
          if (!sessionId) return Promise.resolve();
          syncQueue = syncQueue.then(() => fetch('/api/player/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, ...payload }),
          })).catch(() => undefined);
          return syncQueue;
        };
        const syncEvent = (statusValue, event, stage, error) => {
          const payload = { ...mediaState(), status: statusValue };
          if (event) payload.event = event;
          if (stage) payload.stage = stage;
          if (error) payload.error = error;
          void sync(payload);
        };
        const request = async (path) => {
          await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        };
        const detach = async () => {
          await request('/api/player/detach');
          destroyHls();
          video.pause();
          video.removeAttribute('src');
          video.load();
          await request('/api/player/open');
          window.location.reload();
        };
        const destroyHls = () => {
          if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
          }
        };
        const load = async () => {
          destroyHls();
          video.pause();
          video.removeAttribute('src');
          video.load();
          setStatus('loading');
          syncEvent('loading', undefined, 'PROXY_START');
          const Hls = await hlsReady;
          if (/\\.m3u8(?:$|[?#])/i.test(sourceUrl) && Hls) {
            if (panel) panel.dataset.playerMode = 'hls-js';
            hlsInstance = new Hls({ enableWorker: false });
            if (panel) panel.__qxHlsInstance = hlsInstance;
            const events = Hls.Events || {};
            ['MEDIA_ATTACHED', 'MANIFEST_LOADING', 'MANIFEST_LOADED', 'LEVEL_LOADED', 'FRAG_LOADED', 'FRAG_BUFFERED'].forEach((name) => {
              if (events[name]) hlsInstance.on(events[name], () => { if (panel) panel.dataset.hlsStage = name; });
            });
            if (events.MANIFEST_PARSED) hlsInstance.on(events.MANIFEST_PARSED, () => void sync({ stage: 'MANIFEST' }));
            if (events.LEVEL_SWITCHED) hlsInstance.on(events.LEVEL_SWITCHED, () => void sync({ stage: 'VARIANT' }));
            if (events.FRAG_LOADED) hlsInstance.on(events.FRAG_LOADED, () => void sync({ stage: 'SEGMENT' }));
            if (events.ERROR) hlsInstance.on(events.ERROR, (_event, data) => {
              const details = data && typeof data.details === 'string' ? data.details : 'HLS_ERROR';
              if (panel && data) {
                panel.dataset.hlsError = JSON.stringify({
                  details,
                  fatal: data.fatal === true,
                  responseCode: typeof data.response?.code === 'number' ? data.response.code : null,
                  reason: typeof data.reason === 'string' ? data.reason : null,
                });
              }
              if (data && data.fatal) {
                syncEvent('error', { type: 'fatal-error', code: details, stage: 'DECODER' }, 'DECODER', { code: details, message: details });
              } else {
                void sync({ event: { type: 'segment-failure', reason: details, stage: 'SEGMENT' }, stage: 'SEGMENT' });
              }
            });
            hlsInstance.loadSource(sourceUrl);
            hlsInstance.attachMedia(video);
          } else {
            if (panel) panel.dataset.playerMode = 'native';
            video.src = sourceUrl;
            video.load();
          }
        };
        const play = () => { void video.play().catch((error) => setStatus('error: ' + error.message)); };
        const stop = () => {
          destroyHls();
          video.pause();
          video.removeAttribute('src');
          video.load();
          setStatus('stopped');
        };
        const formatTime = (value) => {
          if (!Number.isFinite(value)) return '0:00';
          const seconds = Math.max(0, Math.floor(value));
          return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        };

        document.querySelectorAll('[data-action="player-play"], [data-action="play"]').forEach((button) => on(button, 'click', play));
        document.querySelectorAll('[data-action="player-pause"]').forEach((button) => on(button, 'click', () => video.pause()));
        document.querySelectorAll('[data-action="player-resume"]').forEach((button) => on(button, 'click', play));
        document.querySelectorAll('[data-action="player-stop"]').forEach((button) => on(button, 'click', stop));
        document.querySelectorAll('[data-action="player-reload"]').forEach((button) => on(button, 'click', load));
        document.querySelectorAll('[data-action="player-seek"]').forEach((input) => on(input, 'input', () => { video.currentTime = Number(input.value); }));
        document.querySelectorAll('[data-action="player-volume"]').forEach((input) => on(input, 'input', () => { video.volume = Number(input.value); }));
        document.querySelectorAll('[data-action="player-mute"]').forEach((button) => on(button, 'click', () => { video.muted = !video.muted; button.textContent = video.muted ? '取消静音' : '静音'; }));
        document.querySelectorAll('[data-action="player-fullscreen"]').forEach((button) => on(button, 'click', () => { void video.requestFullscreen?.(); }));
        document.querySelectorAll('[data-action="player-detach"]').forEach((button) => on(button, 'click', () => { void detach(); }));
        on(video, 'loadstart', () => { setStatus('loading'); syncEvent('loading'); });
        on(video, 'loadedmetadata', () => void sync({ ...mediaState(), stage: 'DECODER' }));
        on(video, 'playing', () => {
          setStatus('playing');
          syncEvent('playing', { type: 'first-frame', stage: 'PLAYING' }, 'PLAYING');
        });
        on(video, 'waiting', () => syncEvent('loading', { type: 'buffer-start' }));
        on(video, 'canplay', () => void sync({ ...mediaState(), event: { type: 'buffer-end' } }));
        on(video, 'pause', () => { if (!video.ended) { setStatus('paused'); syncEvent('paused', { type: 'user-pause' }); } });
        on(video, 'ended', () => { setStatus('ended'); syncEvent('ended', { type: 'completion' }); });
        on(video, 'error', () => {
          const error = { code: 'HTML_VIDEO_ERROR', message: 'The media element reported an error.' };
          setStatus('error');
          syncEvent('error', { type: 'fatal-error', code: error.code, stage: 'DECODER' }, 'DECODER', error);
        });
        on(video, 'durationchange', () => {
          if (seek) seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
          void sync(mediaState());
        });
        on(video, 'timeupdate', () => {
          if (seek) seek.value = String(video.currentTime);
          if (time) time.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
          void sync(mediaState());
        });
        on(video, 'seeking', () => void sync({ ...mediaState(), event: { type: 'seek' } }));
        on(video, 'volumechange', () => void sync(mediaState()));
        const cleanup = () => {
          destroyHls();
          video.pause();
          video.removeAttribute('src');
          video.load();
          listeners.splice(0).forEach((remove) => remove());
        };
        on(window, 'pagehide', cleanup);
        load();
      })();
    </script>`;
}

function statusLabel(state: PlaybackState): string {
  if (state.error) return state.error.message;
  const labels: Record<PlaybackState["status"], string> = {
    idle: "等待播放",
    resolving: "正在解析",
    loading: "正在加载",
    playing: "播放中",
    paused: "已暂停",
    ended: "播放结束",
    stopped: "已停止",
    error: "播放失败",
  };
  return labels[state.status];
}

function parserStatusLabel(
  status: NonNullable<PlaybackState["parse"]>["status"],
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

function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
