export const EPG_SOURCE_TYPES = ["xmltv-url", "xmltv-file", "fixture"] as const;

export type EpgSourceType = typeof EPG_SOURCE_TYPES[number];

export const EPG_MAPPING_METHODS = ["explicit", "tvg-id", "normalized-name", "alias"] as const;
export type EpgMappingMethod = typeof EPG_MAPPING_METHODS[number];

export const EPG_MATCH_CONFIDENCES = ["exact", "high", "medium", "low", "none"] as const;
export type EpgMatchConfidence = typeof EPG_MATCH_CONFIDENCES[number];

export const EPG_MAPPING_STATUSES = ["mapped", "suggested", "ambiguous", "conflict", "unmapped"] as const;
export type EpgMappingStatus = typeof EPG_MAPPING_STATUSES[number];

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

export interface EpgChannelMappingRecord {
  id: string;
  liveChannelId: string;
  epgSourceId: string;
  epgChannelId: string;
  method: EpgMappingMethod;
  confidence: EpgMatchConfidence;
  userConfirmed: boolean;
  updatedAt: number;
}

export interface EpgChannelAliasRecord {
  id: string;
  liveChannelId: string;
  alias: string;
  normalizedAlias: string;
  updatedAt: number;
}

export interface EpgMatchCandidate {
  epgSourceId: string;
  epgSourceName: string;
  epgChannelId: string;
  epgChannelName: string;
  method: Exclude<EpgMappingMethod, "explicit">;
  confidence: Exclude<EpgMatchConfidence, "none">;
  score: number;
}

export interface EpgMappingUiState {
  liveChannelId: string;
  liveChannelName: string;
  liveSourceName: string;
  status: EpgMappingStatus;
  mapping: EpgChannelMappingRecord | null;
  mappingSourceName: string | null;
  mappingChannelName: string | null;
  aliases: readonly string[];
  candidates: readonly EpgMatchCandidate[];
}

export interface EpgProgrammeUiState {
  id: string;
  title: string;
  subTitle: string | null;
  startAt: number;
  endAt: number;
  progress: number | null;
}

export interface EpgTimelineUiState {
  liveChannelId: string;
  fromAt: number;
  toAt: number;
  items: readonly EpgProgrammeUiState[];
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
  mappings: readonly EpgMappingUiState[];
  timeline: EpgTimelineUiState | null;
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
  mappings: [],
  timeline: null,
};

export function isEpgSourceType(value: unknown): value is EpgSourceType {
  return typeof value === "string" && (EPG_SOURCE_TYPES as readonly string[]).includes(value);
}
