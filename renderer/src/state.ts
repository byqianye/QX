export type ImportStatus =
  | "empty"
  | "loading"
  | "confirmation_required"
  | "ready"
  | "cancelled"
  | "error";

export type SpiderStatus =
  | "confirmation_required"
  | "idle"
  | "initializing"
  | "loading"
  | "ready"
  | "error"
  | "destroyed";

export interface RendererError {
  code: string;
  message: string;
}

export interface ImportSummary {
  siteCount: number;
  liveCount: number;
  parseCount: number;
  ruleCount: number;
  hasSpider: boolean;
  topLevelKeys: string[];
  engineCounts: Record<string, number>;
}

export interface ImportSite {
  key: string;
  name: string;
  api: string;
}

export interface ImportState {
  status: ImportStatus;
  loading: boolean;
  inputKind: "url" | "file" | "json" | null;
  source: string | null;
  sourceKind: "remote" | "local" | "inline" | null;
  warning: string | null;
  error: RendererError | null;
  trusted: boolean;
  summary: ImportSummary | null;
  sites: ImportSite[];
  selectedSiteKey: string | null;
  selectedApi: string | null;
  sessionReady: boolean;
}

export type SpiderPlayback =
  | {
      available: false;
      label: string;
      message: string;
    }
  | {
      available: true;
      label: string;
      message: string;
      parse: number;
      url: string;
      headers: Record<string, string>;
    };

export interface SpiderState {
  source: string;
  api: string | null;
  status: SpiderStatus;
  warning: string | null;
  sidecarRunning: boolean;
}

export interface BrowseState {
  page: "import" | "home" | "category" | "search" | "detail" | "closed";
  loading: boolean;
  items: Record<string, unknown>[];
}

export interface PlaybackEpisode {
  index: number;
  name: string;
  id: string;
}

export interface PlaybackLine {
  index: number;
  name: string;
  episodes: PlaybackEpisode[];
}

export interface PlaybackCatalog {
  lines: PlaybackLine[];
}

export interface PlaybackSelection {
  lineIndex: number;
  episodeIndex: number;
}

export interface PlayerSource {
  parse: number;
  url: string;
  headers: Record<string, string>;
}

export interface PlayerState {
  status: "idle" | "resolving" | "loading" | "playing" | "paused" | "ended" | "stopped" | "error";
  source: PlayerSource | null;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  error: RendererError | null;
}

export interface DetailState {
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: PlaybackSelection | null;
  canPlay: boolean;
}

export interface PlaybackState {
  playback: SpiderPlayback;
  player: PlayerState;
}

export interface ErrorState {
  error: RendererError | null;
}

export interface RendererState {
  ready: boolean;
  import: ImportState;
  spider: SpiderState;
  browse: BrowseState;
  detail: DetailState;
  playback: PlaybackState;
  error: ErrorState;
}

export interface ApiSpiderState {
  page: BrowseState["page"];
  source: string;
  api: string | null;
  status: SpiderStatus;
  loading: boolean;
  warning: string | null;
  error: RendererError | null;
  sidecarRunning: boolean;
  playback: SpiderPlayback;
  player: PlayerState;
  canPlay: boolean;
  items: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
  playbackCatalog: PlaybackCatalog | null;
  playbackSelection: PlaybackSelection | null;
}

export interface RendererEnvelope {
  import?: ImportState | null;
  state?: ApiSpiderState | null;
  error?: string;
  errorCode?: string;
}

export function createRendererState(): RendererState {
  return {
    ready: false,
    import: {
      status: "empty",
      loading: false,
      inputKind: null,
      source: null,
      sourceKind: null,
      warning: null,
      error: null,
      trusted: false,
      summary: null,
      sites: [],
      selectedSiteKey: null,
      selectedApi: null,
      sessionReady: false,
    },
    spider: {
      source: "",
      api: null,
      status: "confirmation_required",
      warning: null,
      sidecarRunning: false,
    },
    browse: { page: "import", loading: false, items: [] },
    detail: {
      detail: null,
      playbackCatalog: null,
      playbackSelection: null,
      canPlay: false,
    },
    playback: {
      playback: {
        available: false,
        label: "等待播放",
        message: "选择条目后解析播放地址。",
      },
      player: emptyPlayerState(),
    },
    error: { error: null },
  };
}

export function applyRendererEnvelope(
  current: RendererState,
  envelope: RendererEnvelope,
): RendererState {
  const importState = envelope.import ? cloneImportState(envelope.import) : current.import;
  const state = envelope.state;
  if (!state) {
    return {
      ...current,
      ready: true,
      import: importState,
      error: {
        error: importState.error ?? (envelope.error
          ? { code: envelope.errorCode ?? "RENDERER_REQUEST_ERROR", message: envelope.error }
          : current.error.error),
      },
    };
  }

  const stateError = state.error ?? importState.error ?? (envelope.error
    ? { code: envelope.errorCode ?? "RENDERER_REQUEST_ERROR", message: envelope.error }
    : null);
  return {
    ready: true,
    import: importState,
    spider: {
      source: state.source,
      api: state.api,
      status: state.status,
      warning: state.warning,
      sidecarRunning: state.sidecarRunning,
    },
    browse: {
      page: state.page,
      loading: state.loading,
      items: state.items.map((item) => ({ ...item })),
    },
    detail: {
      detail: state.detail ? { ...state.detail } : null,
      playbackCatalog: clonePlaybackCatalog(state.playbackCatalog),
      playbackSelection: state.playbackSelection ? { ...state.playbackSelection } : null,
      canPlay: state.canPlay,
    },
    playback: {
      playback: cloneSpiderPlayback(state.playback),
      player: clonePlayerState(state.player),
    },
    error: { error: stateError ? { ...stateError } : null },
  };
}

function cloneImportState(state: ImportState): ImportState {
  return {
    ...state,
    error: state.error ? { ...state.error } : null,
    summary: state.summary
      ? { ...state.summary, topLevelKeys: [...state.summary.topLevelKeys], engineCounts: { ...state.summary.engineCounts } }
      : null,
    sites: state.sites.map((site) => ({ ...site })),
  };
}

function cloneSpiderPlayback(playback: SpiderPlayback): SpiderPlayback {
  return playback.available
    ? { ...playback, headers: {} }
    : { ...playback };
}

function clonePlaybackCatalog(catalog: PlaybackCatalog | null): PlaybackCatalog | null {
  return catalog
    ? {
        lines: catalog.lines.map((line) => ({
          ...line,
          episodes: line.episodes.map((episode) => ({ ...episode })),
        })),
      }
    : null;
}

function clonePlayerState(player: PlayerState): PlayerState {
  return {
    ...player,
    source: player.source ? { ...player.source, headers: { ...player.source.headers } } : null,
    error: player.error ? { ...player.error } : null,
  };
}

function emptyPlayerState(): PlayerState {
  return {
    status: "idle",
    source: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    fullscreen: false,
    error: null,
  };
}
