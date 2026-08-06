import type { PlaybackState } from "./playback.js";

export function renderEmbeddedPlayer(state: PlaybackState): string {
  const source = state.source;
  const hasSource = source !== null;
  const hls = hasSource && isHlsUrl(source.url);
  const sourceUrl = JSON.stringify(source?.url ?? "");
  const status = escapeHtml(state.status);
  const error = state.error
    ? `<p class="player-error" data-testid="player-error">${escapeHtml(state.error.message)}</p>`
    : "";

  if (!hasSource) {
    return `<section data-testid="embedded-player-panel" class="embedded-player-panel" data-player-status="${status}">
      <strong>内嵌播放器</strong>
      <p data-testid="player-status">${escapeHtml(statusLabel(state))}</p>
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
      ${error}
    </section>
    <script>
      (() => {
        const sourceUrl = ${sourceUrl};
        const video = document.querySelector('[data-testid="embedded-player"]');
        const panel = document.querySelector('[data-testid="embedded-player-panel"]');
        const status = document.querySelector('[data-testid="player-status"]');
        const seek = document.querySelector('[data-action="player-seek"]');
        const time = document.querySelector('[data-testid="player-time"]');
        let hlsInstance = null;
        const listeners = [];

        if (!video) return;

        const on = (target, event, handler) => {
          target.addEventListener(event, handler);
          listeners.push(() => target.removeEventListener(event, handler));
        };

        const setStatus = (value) => {
          if (panel) panel.dataset.playerStatus = value;
          if (status) status.textContent = value;
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
        const load = () => {
          destroyHls();
          video.pause();
          video.removeAttribute('src');
          video.load();
          setStatus('loading');
          if (/\\.m3u8(?:$|[?#])/i.test(sourceUrl) && video.canPlayType('application/vnd.apple.mpegurl') === '' && window.Hls) {
            hlsInstance = new window.Hls({ enableWorker: false });
            hlsInstance.loadSource(sourceUrl);
            hlsInstance.attachMedia(video);
          } else {
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
        on(video, 'loadstart', () => setStatus('loading'));
        on(video, 'playing', () => setStatus('playing'));
        on(video, 'pause', () => { if (!video.ended) setStatus('paused'); });
        on(video, 'ended', () => setStatus('ended'));
        on(video, 'error', () => setStatus('error'));
        on(video, 'durationchange', () => { if (seek) seek.max = String(Number.isFinite(video.duration) ? video.duration : 0); });
        on(video, 'timeupdate', () => {
          if (seek) seek.value = String(video.currentTime);
          if (time) time.textContent = formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
        });
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
