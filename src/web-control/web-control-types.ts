export type WebControlPermission = "read" | "control" | "push";
export type WebControlRateClass = "read" | "control" | "search";

export interface WebControlRouteContract {
  method: "GET" | "POST";
  path: string;
  schema: string;
  permission: WebControlPermission;
  rateClass: WebControlRateClass;
}

export const WEB_CONTROL_ROUTES: readonly WebControlRouteContract[] = [
  { method: "GET", path: "/api/now-playing", schema: "empty", permission: "read", rateClass: "read" },
  { method: "POST", path: "/api/play", schema: "{flag,id,vipFlags?}", permission: "control", rateClass: "control" },
  { method: "POST", path: "/api/pause", schema: "empty", permission: "control", rateClass: "control" },
  { method: "POST", path: "/api/stop", schema: "empty", permission: "control", rateClass: "control" },
  { method: "POST", path: "/api/seek", schema: "{position}", permission: "control", rateClass: "control" },
  { method: "POST", path: "/api/volume", schema: "{volume,muted?}", permission: "control", rateClass: "control" },
  { method: "GET", path: "/api/search", schema: "?q", permission: "read", rateClass: "search" },
  { method: "GET", path: "/api/detail", schema: "?id", permission: "read", rateClass: "read" },
  { method: "POST", path: "/api/play-episode", schema: "{lineIndex,episodeIndex,vipFlags?}", permission: "control", rateClass: "control" },
  { method: "GET", path: "/api/live-channels", schema: "empty", permission: "read", rateClass: "read" },
  { method: "POST", path: "/api/live-channel", schema: "{channelId,streamId?}", permission: "control", rateClass: "control" },
  { method: "POST", path: "/api/push", schema: "{url,title?}", permission: "push", rateClass: "control" },
  { method: "GET", path: "/api/downloads", schema: "empty", permission: "read", rateClass: "read" },
  { method: "GET", path: "/api/cast-devices", schema: "empty", permission: "read", rateClass: "read" },
  { method: "POST", path: "/api/cast", schema: "{deviceId}", permission: "control", rateClass: "control" },
  { method: "GET", path: "/api/safe-status", schema: "empty", permission: "read", rateClass: "read" },
] as const;

export interface WebControlNowPlaying {
  status: "idle" | "resolving" | "loading" | "playing" | "paused" | "ended" | "stopped" | "error";
  title: string | null;
  episode: string | null;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  live: boolean;
  error: { code: string; message: string } | null;
}

export interface WebControlSearchItem {
  id: string;
  title: string;
  year: string | null;
  remark: string | null;
}

export interface WebControlSearchResult {
  query: string;
  items: readonly WebControlSearchItem[];
}

export interface WebControlEpisode {
  lineIndex: number;
  episodeIndex: number;
  lineName: string;
  name: string;
}

export interface WebControlDetail {
  id: string;
  title: string;
  year: string | null;
  overview: string | null;
  episodes: readonly WebControlEpisode[];
}

export interface WebControlLiveStream {
  id: string;
  label: string;
  protocol: string;
  status: "ready" | "unsupported";
}

export interface WebControlLiveChannel {
  id: string;
  name: string;
  group: string | null;
  sourceName: string;
  streams: readonly WebControlLiveStream[];
}

export interface WebControlLiveState {
  channels: readonly WebControlLiveChannel[];
  activeChannelId: string | null;
  activeStreamId: string | null;
  state: string | null;
}

export interface WebControlDownloadTask {
  id: string;
  title: string;
  filename: string;
  status: string;
  totalBytes: number | null;
  completedBytes: number | null;
  speed: number | null;
  error: string | null;
}

export interface WebControlDownloads {
  tasks: readonly WebControlDownloadTask[];
  backend: "fake" | "aria2" | "native-http" | "unavailable";
  available: boolean;
  error: { code: string; message: string } | null;
}

export interface WebControlCastDevice {
  deviceId: string;
  friendlyName: string;
  model: string;
  manufacturer: string;
  capabilities: {
    play: boolean;
    pause: boolean;
    stop: boolean;
    seek: boolean;
  };
}

export interface WebControlCastState {
  discoveryStatus: "idle" | "searching" | "ready" | "error";
  devices: readonly WebControlCastDevice[];
  session: {
    deviceId: string;
    deviceName: string;
    title: string;
    state: "connecting" | "playing" | "paused" | "stopped" | "error";
    lastPosition: number;
    error: { code: string; message: string } | null;
  } | null;
  error: { code: string; message: string } | null;
}

export interface WebControlPushResult {
  kind: "confirmation-required" | "accepted" | "queued";
  id: string | null;
  title: string | null;
  status: string;
}

export interface WebControlBackendStatus {
  uiReady: boolean;
  capabilities: {
    search: boolean;
    playback: boolean;
    live: boolean;
    push: boolean;
    downloads: boolean;
    cast: boolean;
  };
  lanControl: "disabled" | "enabled";
}

export interface WebControlSnapshot {
  nowPlaying: WebControlNowPlaying;
  search: WebControlSearchResult;
  live: WebControlLiveState;
  downloads: WebControlDownloads;
  cast: WebControlCastState;
  status: WebControlBackendStatus;
}

export interface WebControlBackend {
  snapshot(): WebControlSnapshot | Promise<WebControlSnapshot>;
  play(input: { flag: string; id: string; vipFlags: readonly string[] }): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(position: number): Promise<void>;
  volume(volume: number, muted?: boolean): Promise<void>;
  search(query: string): Promise<WebControlSearchResult>;
  detail(id: string): Promise<WebControlDetail>;
  playEpisode(input: { lineIndex: number; episodeIndex: number; vipFlags: readonly string[] }): Promise<void>;
  liveChannels(): WebControlLiveState | Promise<WebControlLiveState>;
  playLive(input: { channelId: string; streamId?: string }): Promise<void>;
  push(input: { url: string; title?: string }): Promise<WebControlPushResult>;
  downloads(): WebControlDownloads | Promise<WebControlDownloads>;
  castDevices(): WebControlCastState | Promise<WebControlCastState>;
  cast(deviceId: string): Promise<void>;
  safeStatus(): WebControlBackendStatus | Promise<WebControlBackendStatus>;
}

export class WebControlError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "WebControlError";
    this.code = code;
    this.status = status;
  }
}
