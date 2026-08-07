export interface BackupSummary {
  settings: number;
  history: number;
  favorites: number;
  following: number;
  liveSources: number;
  smartChannels: number;
}

export interface BackupManifest {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  sections: readonly string[];
  checksums: Readonly<Record<string, string>>;
  databaseSchemaVersion: number;
  summary: BackupSummary;
}

export type BackupCompatibility = "compatible" | "migration-required" | "newer-unsupported";

export interface BackupPreview {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  sections: readonly string[];
  databaseSchemaVersion: number;
  summary: BackupSummary;
  includeCache: boolean;
  compatibility: BackupCompatibility;
}

export type BackupUiStatus = "idle" | "creating" | "preview" | "restarting" | "error";

export interface BackupUiState {
  status: BackupUiStatus;
  lastBackup: {
    fileName: string;
    size: number;
    createdAt: string;
    includeCache: boolean;
    summary: BackupSummary;
  } | null;
  preview: BackupPreview | null;
  error: { code: string; message: string } | null;
}

export const EMPTY_BACKUP_UI_STATE: BackupUiState = {
  status: "idle",
  lastBackup: null,
  preview: null,
  error: null,
};
