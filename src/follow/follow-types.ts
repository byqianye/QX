import type { FollowRecord } from "../data/repositories.js";

export interface FollowEpisodeInput {
  id?: string | null;
  name?: string | null;
}

export interface FollowContentInput {
  sourceId: string;
  vodId: string;
  title: string;
  poster?: string | null;
  episodes: readonly FollowEpisodeInput[];
}

export interface FollowItem extends FollowRecord {
  sourceAvailable: boolean;
  status: "updated" | "caught-up" | "checking" | "error";
}

export interface FollowUiState {
  items: readonly FollowItem[];
  checking: boolean;
  updateCount: number;
}

export const EMPTY_FOLLOW_UI_STATE: FollowUiState = {
  items: [],
  checking: false,
  updateCount: 0,
};
