export const LIVE_SOURCE_TYPES = [
  "m3u-url",
  "m3u-file",
  "txt-url",
  "txt-file",
  "fixture",
] as const;

export type LiveSourceType = typeof LIVE_SOURCE_TYPES[number];
export type LiveSourceFormat = "m3u" | "txt";
export type LiveRefreshMode = "manual" | "startup" | "interval";

export interface LiveSourceRecord {
  id: string;
  name: string;
  type: LiveSourceType;
  location: string;
  enabled: boolean;
  refreshMode: LiveRefreshMode;
  lastUpdatedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface LiveChannelRecord {
  id: string;
  sourceId: string;
  externalId: string | null;
  name: string;
  normalizedName: string;
  group: string | null;
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
  tvgLogo: string | null;
  tvgChno: string | null;
  catchup: string | null;
  attributes: Record<string, string>;
  enabled: boolean;
  sortOrder: number;
}

export interface LiveChannelStreamRecord {
  id: string;
  channelId: string;
  url: string;
  headers: Record<string, string>;
  priority: number;
  label: string | null;
  protocol: string | null;
}

export interface LiveChannelWithStreams extends LiveChannelRecord {
  streams: readonly LiveChannelStreamRecord[];
}

export interface LiveImportIssue {
  line: number;
  code: string;
  message: string;
  raw: string | null;
}

export interface LiveImportStats {
  channelCount: number;
  groupCount: number;
  streamCount: number;
  invalidCount: number;
  protocolCounts: Record<string, number>;
  addedCount: number;
  removedCount: number;
  changedCount: number;
}

export interface LiveImportPreview {
  id: string;
  source: LiveSourceRecord;
  channels: readonly LiveChannelWithStreams[];
  issues: readonly LiveImportIssue[];
  stats: LiveImportStats;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

export interface LivePreviewUiState {
  id: string;
  source: LiveSourceRecord;
  channelNames: readonly string[];
  issues: readonly LiveImportIssue[];
  stats: LiveImportStats;
}

export interface LiveSourceUiState extends LiveSourceRecord {
  channelCount: number;
  groupCount: number;
  streamCount: number;
}

export interface LiveUiError {
  code: string;
  message: string;
}

export interface LiveUiState {
  sources: readonly LiveSourceUiState[];
  preview: LivePreviewUiState | null;
  loading: boolean;
  error: LiveUiError | null;
}

export type LiveSourceImportInput =
  | {
      name: string;
      type: "m3u-url" | "txt-url";
      location: string;
      sourceId?: string;
    }
  | {
      name: string;
      type: "m3u-file" | "txt-file";
      fileName: string;
      content?: string;
      filePath?: string;
      location?: string;
      sourceId?: string;
    }
  | {
      name: string;
      type: "fixture";
      format: LiveSourceFormat;
      content: string;
      location?: string;
      sourceId?: string;
    };

export function isLiveSourceType(value: unknown): value is LiveSourceType {
  return typeof value === "string" && (LIVE_SOURCE_TYPES as readonly string[]).includes(value);
}

export function liveFormatForType(type: LiveSourceType): LiveSourceFormat {
  return type === "txt-url" || type === "txt-file" ? "txt" : "m3u";
}

export const EMPTY_LIVE_UI_STATE: LiveUiState = {
  sources: [],
  preview: null,
  loading: false,
  error: null,
};
