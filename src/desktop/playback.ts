import type { ParseUiState } from "./parse-chain.js";
import type { SubtitleTrack } from "../subtitles.js";

export type PlaybackStatus =
  | "idle"
  | "resolving"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "stopped"
  | "error";

export interface PlaybackSource {
  parse: number;
  url: string;
  headers: Record<string, string>;
  subtitles?: readonly SubtitleTrack[];
}

export interface PlaybackValidationOptions {
  allowHeaders?: boolean;
  allowedParse?: readonly number[];
}

export interface PlaybackError {
  code: string;
  message: string;
}

export type PlaybackMediaEventType =
  | "first-frame"
  | "startup-timeout"
  | "buffer-start"
  | "buffer-end"
  | "fatal-error"
  | "segment-failure"
  | "playlist-refresh-failure"
  | "disconnect"
  | "http-status"
  | "completion"
  | "user-pause"
  | "seek";

export interface PlaybackMediaEvent {
  type: PlaybackMediaEventType;
  at?: number;
  code?: string;
  reason?: string;
  status?: number;
}

export interface PlaybackState {
  status: PlaybackStatus;
  source: PlaybackSource | null;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  error: PlaybackError | null;
  parse?: ParseUiState;
}

export interface PlaybackMediaSync {
  sessionId?: string;
  status?: PlaybackStatus;
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  error?: PlaybackError;
  event?: PlaybackMediaEvent;
}

const INITIAL_STATE: PlaybackState = {
  status: "idle",
  source: null,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  fullscreen: false,
  error: null,
};

export class EmbeddedPlaybackController {
  private stateValue: PlaybackState = cloneState(INITIAL_STATE);

  public get state(): PlaybackState {
    return cloneState(this.stateValue);
  }

  public load(source: PlaybackSource): PlaybackState {
    this.stateValue = {
      ...cloneState(INITIAL_STATE),
      status: "resolving",
      volume: this.stateValue.volume,
      muted: this.stateValue.muted,
      fullscreen: this.stateValue.fullscreen,
    };

    const error = validatePlaybackSource(source);
    if (error) return this.fail(error.code, error.message);

    this.stateValue = {
      ...this.stateValue,
      status: "loading",
      source: cloneSource(source),
      error: null,
    };
    return this.state;
  }

  public play(): PlaybackState {
    if (!this.stateValue.source) return this.fail("PLAYBACK_NOT_LOADED", "没有已加载的播放地址。");
    if (this.stateValue.status === "ended") this.stateValue.currentTime = 0;
    this.stateValue.status = "playing";
    this.stateValue.error = null;
    return this.state;
  }

  public pause(): PlaybackState {
    if (!this.stateValue.source) return this.fail("PLAYBACK_NOT_LOADED", "没有已加载的播放地址。");
    this.stateValue.status = "paused";
    return this.state;
  }

  public resume(): PlaybackState {
    return this.play();
  }

  public stop(): PlaybackState {
    this.stateValue = {
      ...this.stateValue,
      status: "stopped",
      source: null,
      currentTime: 0,
      duration: 0,
      error: null,
    };
    return this.state;
  }

  public reload(): PlaybackState {
    const source = this.stateValue.source;
    if (!source) return this.fail("PLAYBACK_NOT_LOADED", "没有可重新加载的播放地址。");
    return this.load(source);
  }

  public seek(currentTime: number): PlaybackState {
    const normalized = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
    this.stateValue.currentTime = this.stateValue.duration > 0
      ? Math.min(normalized, this.stateValue.duration)
      : normalized;
    return this.state;
  }

  public setDuration(duration: number): PlaybackState {
    const normalized = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    this.stateValue.duration = normalized;
    if (normalized > 0) this.stateValue.currentTime = Math.min(this.stateValue.currentTime, normalized);
    return this.state;
  }

  public setVolume(volume: number): PlaybackState {
    const normalized = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    this.stateValue.volume = normalized;
    return this.state;
  }

  public setMuted(muted: boolean): PlaybackState {
    this.stateValue.muted = muted;
    return this.state;
  }

  public setFullscreen(fullscreen: boolean): PlaybackState {
    this.stateValue.fullscreen = fullscreen;
    return this.state;
  }

  public syncMedia(patch: PlaybackMediaSync): PlaybackState {
    if (!this.stateValue.source) return this.state;
    if (patch.duration !== undefined) this.setDuration(patch.duration);
    if (patch.currentTime !== undefined) this.seek(patch.currentTime);
    if (patch.volume !== undefined) this.setVolume(patch.volume);
    if (patch.muted !== undefined) this.setMuted(patch.muted);
    if (patch.error) {
      this.stateValue.status = "error";
      this.stateValue.error = { ...patch.error };
    }
    if (patch.status !== undefined && patch.status !== "idle" && patch.status !== "resolving") {
      this.stateValue.status = patch.status;
    }
    return this.state;
  }

  public markPlaying(): PlaybackState {
    return this.play();
  }

  public markPaused(): PlaybackState {
    return this.pause();
  }

  public markEnded(): PlaybackState {
    if (this.stateValue.source) this.stateValue.status = "ended";
    return this.state;
  }

  public markError(code: string, message: string): PlaybackState {
    this.stateValue = {
      ...this.stateValue,
      status: "error",
      error: { code, message },
    };
    return this.state;
  }

  private fail(code: string, message: string): PlaybackState {
    this.stateValue = {
      ...this.stateValue,
      status: "error",
      source: null,
      error: { code, message },
    };
    return this.state;
  }
}

export function validatePlaybackSource(
  source: PlaybackSource,
  options: PlaybackValidationOptions = {},
): PlaybackError | null {
  if (source.parse !== 0 && !options.allowedParse?.includes(source.parse)) {
    return {
      code: "PLAYBACK_PARSE_UNSUPPORTED",
      message: "当前播放器只支持 parse=0 的直接媒体地址。",
    };
  }
  if (!/^https?:\/\//i.test(source.url)) {
    return {
      code: "PLAYBACK_INVALID_URL",
      message: "播放地址必须使用 HTTP 或 HTTPS。",
    };
  }
  if (!options.allowHeaders && Object.keys(source.headers).length > 0) {
    return {
      code: "PLAYBACK_PROXY_REQUIRED",
      message: "该地址需要 LocalProxy 才能播放。",
    };
  }
  return null;
}

function cloneState(state: PlaybackState): PlaybackState {
  return {
    ...state,
    source: state.source ? cloneSource(state.source) : null,
    error: state.error ? { ...state.error } : null,
  };
}

function cloneSource(source: PlaybackSource): PlaybackSource {
  return {
    ...source,
    headers: { ...source.headers },
    ...(source.subtitles ? { subtitles: source.subtitles.map(cloneSubtitleTrack) } : {}),
  };
}

function cloneSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  return {
    ...track,
    ...(track.headers ? { headers: { ...track.headers } } : {}),
  };
}
