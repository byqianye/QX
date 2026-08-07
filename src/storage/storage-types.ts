export type StorageMode = "normal" | "portable";

export interface StorageUiState {
  mode: StorageMode;
  dataRoot: string;
  normalRoot: string;
  portableRoot: string;
  databaseBytes: number;
  cacheBytes: number;
  totalBytes: number;
  historyCount: number;
  favoritesCount: number;
  followCount: number;
  writable: boolean;
  switching: boolean;
  error: string | null;
}

export const EMPTY_STORAGE_UI_STATE: StorageUiState = {
  mode: "normal",
  dataRoot: "—",
  normalRoot: "—",
  portableRoot: "—",
  databaseBytes: 0,
  cacheBytes: 0,
  totalBytes: 0,
  historyCount: 0,
  favoritesCount: 0,
  followCount: 0,
  writable: false,
  switching: false,
  error: null,
};
