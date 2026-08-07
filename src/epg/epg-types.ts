export const EPG_SOURCE_TYPES = ["xmltv-url", "xmltv-file", "fixture"] as const;

export type EpgSourceType = typeof EPG_SOURCE_TYPES[number];

export interface EpgSourceRecord {
  id: string;
  name: string;
  type: EpgSourceType;
  location: string;
  enabled: boolean;
  lastUpdatedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
}

export interface EpgChannelRecord {
  id: string;
  sourceId: string;
  externalId: string;
  displayName: string;
  displayNames: readonly string[];
  normalizedName: string;
  icon: string | null;
}

export interface EpgProgrammeRecord {
  id: string;
  sourceId: string;
  channelId: string;
  startAt: number;
  endAt: number;
  title: string;
  subTitle: string | null;
  description: string | null;
  categories: readonly string[];
  icon: string | null;
}

export interface EpgImportIssue {
  code: string;
  message: string;
  line: number | null;
  raw: string | null;
}

export interface EpgImportStats {
  channelCount: number;
  programmeCount: number;
  invalidCount: number;
}

export interface EpgImportPreview {
  id: string;
  source: EpgSourceRecord;
  channels: readonly EpgChannelRecord[];
  programmes: readonly EpgProgrammeRecord[];
  issues: readonly EpgImportIssue[];
  stats: EpgImportStats;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

export interface EpgSourceUiState extends EpgSourceRecord {
  channelCount: number;
  programmeCount: number;
}

export interface EpgPreviewUiState {
  id: string;
  source: EpgSourceRecord;
  channelNames: readonly string[];
  issues: readonly EpgImportIssue[];
  stats: EpgImportStats;
}

export interface EpgRetentionSettings {
  pastRetentionMs: number;
  futureRetentionMs: number;
}

export interface EpgUiError {
  code: string;
  message: string;
}

export interface EpgUiState {
  sources: readonly EpgSourceUiState[];
  preview: EpgPreviewUiState | null;
  loading: boolean;
  error: EpgUiError | null;
  retention: EpgRetentionSettings;
}

export type EpgSourceImportInput =
  | {
      name: string;
      type: "xmltv-url";
      location: string;
      sourceId?: string;
    }
  | {
      name: string;
      type: "xmltv-file";
      fileName: string;
      content?: string;
      filePath?: string;
      location?: string;
      sourceId?: string;
    }
  | {
      name: string;
      type: "fixture";
      content: string;
      location?: string;
      sourceId?: string;
    };

export const DEFAULT_EPG_RETENTION: EpgRetentionSettings = {
  pastRetentionMs: 6 * 60 * 60 * 1000,
  futureRetentionMs: 7 * 24 * 60 * 60 * 1000,
};

export const EMPTY_EPG_UI_STATE: EpgUiState = {
  sources: [],
  preview: null,
  loading: false,
  error: null,
  retention: { ...DEFAULT_EPG_RETENTION },
};

export function isEpgSourceType(value: unknown): value is EpgSourceType {
  return typeof value === "string" && (EPG_SOURCE_TYPES as readonly string[]).includes(value);
}
