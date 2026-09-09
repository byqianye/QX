import type { ComputedRef, InjectionKey, Ref } from "vue";

import type {
  HistoryResumeMode,
  PlayerMediaSync,
  RendererState,
  RendererThemeMode,
} from "./state.js";
import type { CoreRouteName } from "./router.js";

export interface CoreRouteContext {
  state: Readonly<Ref<RendererState>>;
  pending: Readonly<Ref<string | null>>;
  lineIndex: Readonly<Ref<number>>;
  order: Readonly<Ref<"forward" | "reverse">>;
  theme: Ref<RendererThemeMode>;
  resolvedTheme: ComputedRef<"light" | "dark">;
  sourceName: ComputedRef<string>;
  retryable: ComputedRef<boolean>;
  canSearchPlayback: ComputedRef<boolean>;
  navigate: (route: CoreRouteName) => void;
  back: () => void;
  search: (query: string) => void;
  selectCategory: (typeId: string, filters?: Record<string, string>) => void;
  openDetail: (vodId: string, siteKey?: string) => void;
  play: (lineIndex: number, episodeIndex: number, resumeMode?: HistoryResumeMode) => void;
  retry: () => void;
  findPlaybackSource: () => void;
  selectPlaybackSource: (siteKey: string, vodId: string) => void;
  setLine: (lineIndex: number) => void;
  setOrder: (order: "forward" | "reverse") => void;
  playerDetach: () => void;
  playerAttach: () => void;
  playerStop: () => void;
  playerSync: (value: PlayerMediaSync) => void;
  fallbackCancel: () => void;
  fallbackApprove: () => void;
  fallbackMode: (value: "off" | "prompt" | "auto") => void;
  openSources: () => void;
  switchSource: () => void;
  selectSource: (siteKey: string) => void;
  favoriteToggle: () => void;
  favoriteMove: (groupId: string) => void;
  historyOpen: (identity: string) => void;
  historyDelete: (identity: string) => void;
  historyDeleteProgress: (identity: string) => void;
  historyClear: (identities: string[]) => void;
  historyPause: (paused: boolean) => void;
  favoriteOpen: (favoriteId: string) => void;
  favoriteDelete: (favoriteId: string) => void;
  favoriteMoveItem: (payload: { favoriteId: string; groupId: string }) => void;
  favoriteReorder: (payload: { groupId: string; favoriteIds: string[] }) => void;
  favoriteCreateGroup: (name: string) => void;
  favoriteRenameGroup: (payload: { groupId: string; name: string }) => void;
  favoriteDeleteGroup: (payload: { groupId: string; disposition?: "default" | "delete" }) => void;
  favoriteReorderGroups: (groupIds: string[]) => void;
  followToggle: () => void;
  followAndFavorite: () => void;
  followRefresh: () => void;
  followOpen: (identity: string) => void;
  followDelete: (identity: string) => void;
  followMarkWatched: (identity: string) => void;
  followMarkUnwatched: (identity: string) => void;
}

export const CORE_ROUTE_CONTEXT_KEY: InjectionKey<CoreRouteContext> = Symbol("qx-core-route-context");

export function useCoreRouteContext(inject: <T>(key: InjectionKey<T>) => T | undefined): CoreRouteContext {
  const context = inject(CORE_ROUTE_CONTEXT_KEY);
  if (!context) throw new Error("QX core route context is unavailable");
  return context;
}
