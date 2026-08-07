import type { HistoryRecord } from "../data/repositories.js";

export interface ContentIdentity {
  sourceId: string;
  vodId: string;
  seasonId: string | null;
  episodeId: string | null;
}

export interface HistoryPlaybackContext {
  identity: ContentIdentity;
  title: string;
  poster: string | null;
  episode: number | null;
  episodeName: string | null;
  playbackLine: string | null;
  sourceDisplayName: string | null;
  sourceType?: "remote" | "local";
}

export interface HistoryCatalogEpisode {
  lineIndex: number;
  episodeIndex: number;
  lineName: string;
  episodeName: string;
  episodeId: string;
}

export type HistoryItem = HistoryRecord;

export interface HistoryResumeCandidate extends HistoryItem {
  lineIndex: number | null;
  episodeIndex: number | null;
  lineName: string | null;
  canResume: boolean;
}

export interface HistoryUiState {
  items: readonly HistoryItem[];
  paused: boolean;
}

export type HistoryResumeMode = "continue" | "beginning";

export const EMPTY_HISTORY_UI_STATE: HistoryUiState = {
  items: [],
  paused: false,
};
