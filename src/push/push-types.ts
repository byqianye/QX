export const PUSH_REQUEST_TYPES = [
  "url",
  "source-item",
  "local-file",
  "fixture",
] as const;

export type PushRequestType = (typeof PUSH_REQUEST_TYPES)[number];

export type PushRequester = "user" | "localhost" | "trusted-local";

export type PushConflictMode = "replace" | "queue" | "reject";

export type PushConfirmationPolicy = "ask" | "allow-trusted-local";

export interface PushSourceReference {
  sourceId?: string;
  contentId: string;
  episodeId?: string;
  flag?: string;
}

export interface PushRequestBase {
  title?: string;
  headers?: Record<string, string>;
  requestedBy: PushRequester;
}

export interface PushUrlRequest extends PushRequestBase {
  type: "url";
  url: string;
}

export interface PushSourceItemRequest extends PushRequestBase {
  type: "source-item";
  sourceReference: PushSourceReference;
}

export interface PushLocalFileRequest extends PushRequestBase {
  type: "local-file";
  localFileReference: { itemId: string };
}

export interface PushFixtureRequest extends PushRequestBase {
  type: "fixture";
  fixtureId: string;
  url?: string;
}

export type PushRequest =
  | PushUrlRequest
  | PushSourceItemRequest
  | PushLocalFileRequest
  | PushFixtureRequest;

export interface PushPlaybackSessionSnapshot {
  id: string;
  kind: "vod";
  title: string | null;
  state: "active" | "stopped";
}

export interface PushConfirmationPreview {
  id: string;
  type: PushRequestType;
  title: string;
  targetHost: string | null;
  requestedBy: PushRequester;
  createdAt: number;
}

export type PushRecentStatus =
  | "pending-confirmation"
  | "accepted"
  | "queued"
  | "rejected"
  | "cancelled"
  | "failed";

export interface PushRecentRecord {
  id: string;
  type: PushRequestType;
  title: string;
  status: PushRecentStatus;
  requestedBy: PushRequester;
  createdAt: number;
  sessionId: string | null;
  error: { code: string; message: string } | null;
}

export interface PushUiState {
  enabled: boolean;
  host: string;
  configuredPort: number;
  port: number | null;
  listening: boolean;
  endpoint: string | null;
  confirmationPolicy: PushConfirmationPolicy;
  conflictMode: PushConflictMode;
  pending: readonly PushConfirmationPreview[];
  recent: readonly PushRecentRecord[];
  activeSession: PushPlaybackSessionSnapshot | null;
  error: { code: string; message: string } | null;
  lanControl: "disabled" | "enabled";
}

export const EMPTY_PUSH_UI_STATE: PushUiState = {
  enabled: true,
  host: "127.0.0.1",
  configuredPort: 0,
  port: null,
  listening: false,
  endpoint: null,
  confirmationPolicy: "ask",
  conflictMode: "replace",
  pending: [],
  recent: [],
  activeSession: null,
  error: null,
  lanControl: "disabled",
};
