export type CastDiscoveryStatus = "idle" | "searching" | "ready" | "error";

export type CastTransportState = "connecting" | "playing" | "paused" | "stopped" | "error";

export interface CastCapabilities {
  setAvTransportUri: boolean;
  play: boolean;
  pause: boolean;
  stop: boolean;
  seek: boolean;
  getTransportInfo: boolean;
  getPositionInfo: boolean;
}

export interface CastDevice {
  deviceId: string;
  friendlyName: string;
  location: string;
  model: string;
  manufacturer: string;
  lastSeen: number;
  capabilities: CastCapabilities;
}

export interface CastMediaSource {
  url: string;
  title: string;
  headers?: Record<string, string>;
  contentType?: string;
  subtitle?: {
    url: string;
    headers?: Record<string, string>;
    contentType?: string;
  };
}

export interface CastSessionState {
  device: CastDevice;
  media: { title: string; contentType: string | null };
  state: CastTransportState;
  startedAt: number;
  lastPosition: number;
  error: { code: string; message: string } | null;
}

export interface CastUiState {
  discoveryStatus: CastDiscoveryStatus;
  devices: readonly CastDevice[];
  session: CastSessionState | null;
  error: { code: string; message: string } | null;
}

export const DEFAULT_CAST_CAPABILITIES: CastCapabilities = {
  setAvTransportUri: true,
  play: true,
  pause: true,
  stop: true,
  seek: false,
  getTransportInfo: false,
  getPositionInfo: false,
};

export const EMPTY_CAST_UI_STATE: CastUiState = {
  discoveryStatus: "idle",
  devices: [],
  session: null,
  error: null,
};
