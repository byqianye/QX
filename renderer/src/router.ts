import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import type { InjectionKey } from "vue";

import BrowsePage from "./pages/BrowsePage.vue";
import FollowPage from "./pages/FollowPage.vue";
import MediaDetailPage from "./pages/MediaDetailPage.vue";
import RouteMarkerPage from "./pages/RouteMarkerPage.vue";
import SourceSwitchPage from "./pages/SourceSwitchPage.vue";
import WatchPage from "./pages/WatchPage.vue";

export const coreRouteNames = [
  "onboarding",
  "home",
  "category",
  "search",
  "media",
  "watch",
  "sources",
  "history",
  "favorites",
  "follow",
  "legacy-downloads",
  "legacy-local",
  "legacy-settings",
] as const;

export type CoreRouteName = typeof coreRouteNames[number];
export const ROUTER_ENABLED_KEY: InjectionKey<boolean> = Symbol("qx-router-enabled");

export const coreRoutes: RouteRecordRaw[] = [
  { path: "/onboarding", name: "onboarding", component: RouteMarkerPage },
  { path: "/home", name: "home", component: BrowsePage },
  { path: "/category", name: "category", component: BrowsePage },
  { path: "/search", name: "search", component: BrowsePage },
  { path: "/media/:mediaId", name: "media", component: MediaDetailPage, props: true },
  { path: "/watch/:mediaId", name: "watch", component: WatchPage, props: true },
  { path: "/sources", name: "sources", component: SourceSwitchPage },
  { path: "/history", name: "history", component: () => import("./pages/HistoryPage.vue") },
  { path: "/favorites", name: "favorites", component: () => import("./pages/FavoritesPage.vue") },
  { path: "/follow", name: "follow", component: FollowPage },
  { path: "/downloads", name: "legacy-downloads", component: RouteMarkerPage },
  { path: "/local", name: "legacy-local", component: RouteMarkerPage },
  { path: "/settings", name: "legacy-settings", component: RouteMarkerPage },
  { path: "/:pathMatch(.*)*", redirect: "/home" },
];

export const router = createRouter({
  // Tauri serves a static bundle, so hash history survives reloads without a
  // server fallback and still gives the renderer real back/forward semantics.
  history: createWebHashHistory(),
  routes: coreRoutes,
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition;
    if (isCoreRouteName(to.name)) return { top: 0 };
    return false;
  },
});

export function isCoreRouteName(value: unknown): value is CoreRouteName {
  return typeof value === "string" && (coreRouteNames as readonly string[]).includes(value);
}
