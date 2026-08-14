export type DownloadStatus =
  | "queued"
  | "starting"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "removed";

export type DownloadBackendKind = "fake" | "aria2" | "native-http" | "unavailable";

export interface DownloadTargetDirectory {
  id: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  taskCount: number;
}

/** Public task state. It never includes the selected directory's absolute path. */
export interface DownloadTask {
  id: string;
  sourceId: string | null;
  contentId: string | null;
  title: string;
  targetDirectoryId: string;
  suggestedFilename: string;
  requestReference: string;
  status: DownloadStatus;
  totalBytes: number | null;
  completedBytes: number | null;
  speed: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  error: string | null;
}

export interface DownloadUiState {
  tasks: readonly DownloadTask[];
  targetDirectories: readonly DownloadTargetDirectory[];
  backend: DownloadBackendKind;
  aria2Available: boolean;
  error: { code: string; message: string } | null;
}

export const EMPTY_DOWNLOAD_UI_STATE: DownloadUiState = {
  tasks: [],
  targetDirectories: [],
  backend: "unavailable",
  aria2Available: false,
  error: null,
};

export function isDownloadStatus(value: unknown): value is DownloadStatus {
  return value === "queued"
    || value === "starting"
    || value === "downloading"
    || value === "paused"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "removed";
}
