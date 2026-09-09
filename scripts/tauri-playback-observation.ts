// Installed only by the desktop canary, before the user's play action.
export function installPlaybackObservationExpression(): string {
  return `(() => {
    const observed = new WeakSet();
    const reset = () => {
      window.__qxPlaybackObservation = { intentAt: performance.now(), firstFrameAt: null,
        frames: 0, firstTime: null, lastTime: null, maxFrameGapMs: 0, lastFrameAt: null,
        bufferCount: 0, bufferMs: 0, bufferingAt: null, ended: false, errors: [], samples: [] };
    };
    reset();
    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('[data-action="core-watch-play"], [data-action="core-detail-play"], [data-action="play"], [data-action="player-episode"]')) reset();
    }, true);
    const attach = () => {
      const video = document.querySelector('[data-testid="embedded-player"]');
      if (!(video instanceof HTMLVideoElement) || observed.has(video)) return;
      observed.add(video);
      const frame = (_now, metadata) => {
        if (!video.isConnected) return;
        const state = window.__qxPlaybackObservation;
        const now = performance.now();
        if (state.firstFrameAt === null) { state.firstFrameAt = now; state.firstTime = metadata.mediaTime; }
        if (state.lastFrameAt !== null) state.maxFrameGapMs = Math.max(state.maxFrameGapMs, now - state.lastFrameAt);
        state.frames++;
        state.lastFrameAt = now;
        state.lastTime = metadata.mediaTime;
        if (state.bufferingAt !== null) { state.bufferMs += now - state.bufferingAt; state.bufferingAt = null; }
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      video.addEventListener('waiting', () => {
        const state = window.__qxPlaybackObservation;
        if (state.firstFrameAt !== null && !video.paused && !video.seeking && state.bufferingAt === null) {
          state.bufferCount++; state.bufferingAt = performance.now();
        }
      });
      video.addEventListener('ended', () => { window.__qxPlaybackObservation.ended = true; });
      video.addEventListener('error', () => { window.__qxPlaybackObservation.errors.push(video.error?.code ?? -1); });
    };
    new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
    attach();
    setInterval(() => {
      const state = window.__qxPlaybackObservation;
      const video = document.querySelector('[data-testid="embedded-player"]');
      if (state.firstFrameAt !== null && video instanceof HTMLVideoElement && state.samples.length < 900) {
        state.samples.push({ elapsedMs: performance.now() - state.firstFrameAt, time: video.currentTime,
          frames: video.getVideoPlaybackQuality().totalVideoFrames, dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
          readyState: video.readyState, paused: video.paused, rate: video.playbackRate });
      }
    }, 1000);
    return true;
  })()`;
}

export function playbackObservationFailures(value: Record<string, any>, requiredSeconds: number): string[] {
  const failures: string[] = [];
  if (!(value.frames > 0) || !Number.isFinite(value.firstFrameAt)) failures.push("NO_DECODED_FRAME");
  if (!(value.firstFrameAt - value.intentAt <= 10_000)) failures.push("FIRST_FRAME_OVER_10S");
  const samples = value.samples as Array<{ elapsedMs: number; time: number; paused: boolean; rate: number }> | undefined;
  const last = samples?.at(-1);
  if (!last || last.elapsedMs < requiredSeconds * 1000 || value.lastTime - value.firstTime < requiredSeconds - 1) failures.push("CONTINUOUS_PLAYBACK_TOO_SHORT");
  if (value.bufferCount > 0 || value.bufferingAt !== null || value.maxFrameGapMs > 2000) failures.push("BUFFERING_INTERRUPTION");
  if (samples?.some(sample => sample.paused || sample.rate !== 1)) failures.push("PLAYBACK_NOT_CONTINUOUS_AT_1X");
  if (value.ended || value.errors?.length) failures.push("MEDIA_ENDED_OR_FAILED");
  return failures;
}
