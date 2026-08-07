export type LocalMediaType = "video" | "audio";
export type LocalMediaScanStatus = "idle" | "scanning" | "cancelled" | "error";
export type LocalMediaBackend = "html-video" | "hls-js" | "mpv";

export interface LocalSubtitleTrack {
  id: string;
  label: string;
  language: string;
  format: "vtt" | "srt" | "ass" | "ssa";
  fileReference: string;
}

/** Public representation. fileReference is an opaque library reference, never a path. */
export interface LocalMediaItem {
  id: string;
  /** Opaque stable identity for the authorized path; never a filesystem path. */
  pathIdentity: string;
  /** Compatibility name used by the desktop API; also opaque. */
  fileReference: string;
  displayName: string;
  extension: string;
  size: number;
  modifiedAt: number;
  mediaType: LocalMediaType;
  duration?: number;
  width?: number;
  height?: number;
  poster?: string;
  createdAt: number;
  updatedAt: number;
  missing: boolean;
  rootId: string | null;
  subtitleTracks: readonly (Omit<LocalSubtitleTrack, "fileReference"> & { url?: string })[];
}

export interface LocalMediaFolder {
  id: string;
  displayName: string;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
  lastScanAt: number | null;
  scanStatus: LocalMediaScanStatus;
  error: string | null;
}

export interface LocalMediaUiState {
  ready: boolean;
  folders: readonly LocalMediaFolder[];
  items: readonly LocalMediaItem[];
  activeItemId: string | null;
  scan: {
    rootId: string | null;
    status: LocalMediaScanStatus;
    visitedFiles: number;
    skippedFiles: number;
  };
  error: { code: string; message: string } | null;
  limits: {
    maxDepth: number;
    maxFiles: number;
    maxDropFiles: number;
  };
}

export const EMPTY_LOCAL_MEDIA_UI_STATE: LocalMediaUiState = {
  ready: false,
  folders: [],
  items: [],
  activeItemId: null,
  scan: { rootId: null, status: "idle", visitedFiles: 0, skippedFiles: 0 },
  error: null,
  limits: { maxDepth: 8, maxFiles: 10_000, maxDropFiles: 100 },
};
