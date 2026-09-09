import type { SniffedMedia } from "./isolated-sniffer.js";
import { CACHE_TYPES } from "../cache/cache-types.js";

export interface PackagedE2eOptions {
  baseUrl: string;
  configUrl: string;
  configFile: string;
  configJson: string;
  freshTrust: boolean;
  startAgain?: () => Promise<{ url: string }>;
  closeWindow?: () => Promise<void>;
  getSidecarPid?: () => number | null;
  waitForSidecarExit?: (pid: number) => Promise<boolean>;
  reloadWindow?: () => Promise<void>;
  evaluateWindow?: (script: string) => Promise<unknown>;
  captureWindow?: (name: string) => Promise<void>;
  readWindowHtml?: () => Promise<string>;
  verifyPlaybackRules?: boolean;
  verifyPlaybackDebug?: boolean;
  verifySubtitleTracks?: boolean;
  verifyDanmaku?: boolean;
  verifyPlaybackHealth?: boolean;
  verifyPlaybackFallback?: boolean;
  verifyHistory?: boolean;
  verifyFavorites?: boolean;
  verifyFollow?: boolean;
  verifyCache?: boolean;
  verifyStorage?: boolean;
  verifyBackup?: boolean;
  expectedFavoriteId?: string;
  expectedFollowIdentity?: string;
  verifyParserFallback?: boolean;
  verifySniffFallback?: boolean;
  verifyAggregateSearch?: boolean;
  verifyFakeMpv?: boolean;
  verifyLocalMedia?: boolean;
  localMediaFile?: string;
  verifyDownloads?: boolean;
  downloadDirectory?: string;
  downloadUrl?: string;
  realDownloads?: boolean;
  verifyPush?: boolean;
  pushUrl?: string;
  verifyCast?: boolean;
  verifyWebControl?: boolean;
  webControlUrl?: string;
  fakeMpv?: () => Promise<boolean>;
  verifySniffer?: boolean;
  sniff?: () => Promise<SniffedMedia>;
  hlsMasterUrl?: string;
  hlsChildUrl?: string;
  resourceCleanup?: () => Promise<{ proxySessions: number; snifferSessions: number }>;
  playback?: {
    configJson: string;
  };
}

export interface PackagedE2eChecks {
  initialImportForm: boolean;
  urlImport: boolean;
  cancellation: boolean;
  fileImport: boolean;
  jsonImport: boolean;
  searchDetail: boolean;
  sidecarStopped: boolean;
  repeatedStart: boolean;
  trustedReimport: boolean;
  doubanUnavailable: boolean;
  embeddedMp4?: boolean;
  embeddedHls?: boolean;
  parseChain?: boolean;
  isolatedSniffer?: boolean;
  playbackRules?: boolean;
  playbackDebug?: boolean;
  subtitleTracks?: boolean;
  danmaku?: boolean;
  playbackHealth?: boolean;
  playbackFallback?: boolean;
  parserFallback?: boolean;
  sniffFallback?: boolean;
  fakeMpvExit?: boolean;
  localMedia?: boolean;
  localMediaRestart?: boolean;
  downloads?: boolean;
  downloadsRestart?: boolean;
  push?: boolean;
  pushRestart?: boolean;
  cast?: boolean;
  castRestart?: boolean;
  webControl?: boolean;
  webControlRestart?: boolean;
  hlsTopology?: boolean;
  aggregateSearch?: boolean;
  proxyCleanup?: boolean;
  snifferCleanup?: boolean;
  proxyRequired?: boolean;
  noExternalBrowser?: boolean;
  errorSurface?: boolean;
  embeddedMp4Dom?: boolean;
  embeddedHlsDom?: boolean;
  proxyHlsDom?: boolean;
  vodPlaybackFlow?: boolean;
  detachablePlayer?: boolean;
  singlePlaybackSession?: boolean;
  noBackgroundPlayer?: boolean;
  history?: boolean;
  historyRestart?: boolean;
  favorites?: boolean;
  favoritesRestart?: boolean;
  follow?: boolean;
  followRestart?: boolean;
  cache?: boolean;
  storage?: boolean;
  backup?: boolean;
}

export interface PackagedE2eResult {
  status: "passed" | "failed";
  checks: PackagedE2eChecks;
  searchVodId: string | null;
  detailVodId: string | null;
  favoriteId: string | null;
  followIdentity: string | null;
  sidecarPid: number | null;
  error?: string;
  localMediaProbe?: Record<string, unknown>;
}

export async function runPackagedE2e(options: PackagedE2eOptions): Promise<PackagedE2eResult> {
  const checks = emptyChecks();
  let searchVodId: string | null = null;
  let detailVodId: string | null = null;
  let favoriteId: string | null = null;
  let followIdentity: string | null = null;
  let sidecarPid: number | null = null;
  let localMediaProbe: Record<string, unknown> | undefined;

  try {
    const initialHtml = await readPage(options);
    if (options.captureWindow) {
      await post(options.baseUrl, "/api/view-state", { navigation: "home", theme: "light" });
      await readPage(options);
    }
    await captureWindow(options, "first-start-light");
    if (options.captureWindow) {
      await post(options.baseUrl, "/api/view-state", { navigation: "home", theme: "dark" });
      await readPage(options);
      await options.captureWindow("first-start-dark");
      await post(options.baseUrl, "/api/view-state", { navigation: "home", theme: "light" });
      await readPage(options);
    }
    checks.initialImportForm = initialHtml.includes('data-testid="config-import-form"')
      && (!options.readWindowHtml || initialHtml.includes('data-testid="vue-renderer"'));

    if (options.verifySniffer) {
      if (!options.sniff) throw new Error("Packaged E2E sniffer verification is not configured");
      const sniffed = await options.sniff();
      checks.isolatedSniffer = sniffed.parse === 0
        && sniffed.url.endsWith("/sniff/delayed.m3u8")
        && sniffed.diagnostics.redacted
        && !JSON.stringify(sniffed.diagnostics).includes("Cookie");
    }

    if (options.verifyFakeMpv) {
      if (!options.fakeMpv) throw new Error("Packaged E2E fake-mpv verification is not configured");
      checks.fakeMpvExit = await options.fakeMpv();
    }

    if (options.hlsMasterUrl && options.hlsChildUrl) {
      const [master, child] = await Promise.all([
        fetch(options.hlsMasterUrl),
        fetch(options.hlsChildUrl),
      ]);
      const masterBody = await master.text();
      const childBody = await child.text();
      checks.hlsTopology = master.ok
        && child.ok
        && masterBody.includes("#EXT-X-STREAM-INF")
        && masterBody.includes("/media/fixture.m3u8")
        && childBody.includes("#EXTM3U")
        && childBody.includes("#EXT-X-MAP");
    }

    const firstUrl = await load(options.baseUrl, options.configUrl);
    const warningHtml = await readPage(options);
    const firstUrlConfirmation = options.freshTrust
      ? firstUrl.import.status === "confirmation_required"
        && warningHtml.includes('data-testid="import-warning"')
      : firstUrl.import.status === "ready";
    if (options.freshTrust) {
      const cancelled = await post(options.baseUrl, "/api/import/cancel");
      checks.cancellation = cancelled.import.status === "cancelled"
        && (cancelled.state === null || cancelled.state.status === "destroyed");
    } else {
      checks.cancellation = (await post(options.baseUrl, "/api/import/cancel")).import.status === "cancelled";
    }
    const trustedUrl = await load(options.baseUrl, options.configUrl);
    const trustedUrlReady = await confirmIfNeeded(options.baseUrl, trustedUrl.import.status);
    await post(options.baseUrl, "/api/import/cancel");
    checks.urlImport = firstUrlConfirmation && trustedUrlReady;

    const fileImport = await load(options.baseUrl, options.configFile);
    const fileReady = await confirmIfNeeded(options.baseUrl, fileImport.import.status);
    await post(options.baseUrl, "/api/import/cancel");
    checks.fileImport = fileReady;

    const jsonImport = await load(options.baseUrl, options.configJson);
    const jsonReady = await confirmIfNeeded(options.baseUrl, jsonImport.import.status);
    const opened = await post(options.baseUrl, "/api/open");
    if (options.captureWindow) {
      await post(options.baseUrl, "/api/view-state", { navigation: "home", siteKey: null });
      await readPage(options);
      await options.captureWindow("home-source-ready");
      await post(options.baseUrl, "/api/view-state", { navigation: "home", siteKey: null, theme: "dark" });
      await readPage(options);
      await options.captureWindow("home-source-ready-dark");
      await post(options.baseUrl, "/api/view-state", { navigation: "home", siteKey: null, theme: "light" });
      await readPage(options);
    }
    const search = await post(options.baseUrl, "/api/search", {
      key: "蜘蛛侠",
      quick: false,
      page: 1,
    });
    searchVodId = firstVodId(search.state);
    if (options.captureWindow) {
      await readPage(options);
      await options.captureWindow("search-results");
      await post(options.baseUrl, "/api/view-state", { navigation: "search", theme: "dark" });
      await readPage(options);
      await options.captureWindow("search-results-dark");
      await post(options.baseUrl, "/api/view-state", { navigation: "search", theme: "light" });
      await readPage(options);
    }
    if (options.verifyAggregateSearch && search.state?.aggregateSearch) {
      checks.aggregateSearch = search.state.aggregateSearch.status === "complete"
        && search.state.aggregateSearch.total >= 2
        && search.state.aggregateSearch.completed === search.state.aggregateSearch.total
        && search.state.aggregateSearch.sources.length >= 2
        && search.state.aggregateSearch.sources
          .filter((source) => source.status !== "skipped")
          .every((source) => source.status === "success");
    }
    const detail = await post(options.baseUrl, "/api/detail", { vodId: searchVodId });
    detailVodId = stringField(detail.state?.detail?.vod_id);
    if (options.captureWindow) {
      await readPage(options);
      await options.captureWindow("detail-drawer");
      await post(options.baseUrl, "/api/view-state", { navigation: "detail", recentDetailId: searchVodId, theme: "dark" });
      await readPage(options);
      await options.captureWindow("detail-drawer-dark");
      await post(options.baseUrl, "/api/view-state", { navigation: "detail", recentDetailId: searchVodId, theme: "light" });
      await readPage(options);
    }
    if (options.verifyWebControl) {
      if (!options.webControlUrl) throw new Error("Packaged Web control E2E URL is not configured");
      checks.webControl = await verifyWebControlEndpoint(options.webControlUrl);
    }
    const doubanPlayback = await post(options.baseUrl, "/api/player", {
      flag: "default",
      id: searchVodId,
    });
    await post(options.baseUrl, "/api/view-state", { navigation: "home", siteKey: null });
    const doubanErrorHtml = await readPage(options);
    const closed = await post(options.baseUrl, "/api/import/cancel");
    checks.searchDetail = jsonReady
      && opened.state?.status === "ready"
      && /^msearch:\d+$/.test(searchVodId)
      && detail.state?.page === "detail"
      && detailVodId === searchVodId;
    checks.jsonImport = jsonReady && closed.import.status === "cancelled";
    checks.doubanUnavailable = doubanPlayback.state?.error?.code === "PLAYBACK_UNAVAILABLE";
    checks.errorSurface = !options.readWindowHtml
      || (doubanErrorHtml.includes('data-testid="error-state"')
        && doubanErrorHtml.includes('data-testid="error-diagnostic"')
        && doubanErrorHtml.includes('data-action="copy-diagnostic"'));

    if (options.verifyCache) {
      const refreshedCache = await post(options.baseUrl, "/api/cache/refresh");
      const clearedCache = await post(options.baseUrl, "/api/cache/clear", { scope: "all" });
      checks.cache = validCacheState(refreshedCache.state?.cache)
        && validCacheState(clearedCache.state?.cache)
        && clearedCache.state?.cache?.entries === 0;
    }
    if (options.verifyStorage) {
      const storage = await post(options.baseUrl, "/api/storage/refresh");
      checks.storage = validStorageState(storage.state?.storage)
        && storage.state?.storage?.mode === "normal"
        && !storage.state.storage.dataRoot.includes("\\")
        && !storage.state.storage.dataRoot.includes(":");
    }
    if (options.verifyBackup) {
      const createdBackup = await post(options.baseUrl, "/api/backup/create", { includeCache: false });
      const createdState = isRecord(createdBackup.state?.backup) ? createdBackup.state.backup : null;
      const lastBackup = createdState && isRecord(createdState.lastBackup) ? createdState.lastBackup : null;
      const pickedBackup = await post(options.baseUrl, "/api/backup/pick");
      const pickedState = isRecord(pickedBackup.state?.backup) ? pickedBackup.state.backup : null;
      const preview = pickedState && isRecord(pickedState.preview) ? pickedState.preview : null;
      const clearedBackup = await post(options.baseUrl, "/api/backup/clear");
      const clearedState = isRecord(clearedBackup.state?.backup) ? clearedBackup.state.backup : null;
      checks.backup = typeof lastBackup?.fileName === "string"
        && lastBackup.fileName.endsWith(".zip")
        && pickedState?.status === "preview"
        && preview?.compatibility === "compatible"
        && clearedState?.preview === null;
    }

    if (options.playback) {
      const playbackImport = await load(options.baseUrl, options.playback.configJson);
      const playbackReady = await confirmIfNeeded(options.baseUrl, playbackImport.import.status);
      const playbackOpened = await post(options.baseUrl, "/api/open");
      const playbackHome = await post(options.baseUrl, "/api/home");
      if (options.verifyPush) {
        if (!options.pushUrl) throw new Error("Packaged Push E2E URL is not configured");
        const beforePush = options.freshTrust
          ? (await post(options.baseUrl, "/api/push/settings", {
            enabled: true,
            port: 0,
            confirmationPolicy: "ask",
            conflictMode: "replace",
          })).state?.push
          : playbackHome.state?.push ?? playbackHome.push;
        if (!options.freshTrust) {
          checks.pushRestart = beforePush?.listening === true
            && beforePush.endpoint?.startsWith("http://127.0.0.1:") === true;
        } else if (beforePush?.endpoint) {
          const pushed = await postPush(beforePush.endpoint, {
            uri: `push://url?url=${encodeURIComponent(options.pushUrl)}&title=Packaged%20Push`,
          });
          const confirmationId = isRecord(pushed.preview) && typeof pushed.preview.id === "string"
            ? pushed.preview.id
            : null;
          const confirmed = confirmationId
            ? await post(options.baseUrl, "/api/push/confirm", { id: confirmationId })
            : null;
          const pushState = confirmed?.state?.push ?? confirmed?.push;
          const rejectedPush = await postPush(beforePush.endpoint, {
            uri: `push://url?url=${encodeURIComponent(options.pushUrl)}&title=Packaged%20Reject`,
          });
          const rejectedId = isRecord(rejectedPush.preview) && typeof rejectedPush.preview.id === "string"
            ? rejectedPush.preview.id
            : null;
          const rejected = rejectedId
            ? await postPush(pushActionEndpoint(beforePush.endpoint, "confirm"), { id: rejectedId, decision: "play", mode: "reject" }, true)
            : null;
          const rejectedState = await post(options.baseUrl, "/api/push/refresh");
          await post(options.baseUrl, "/api/push/settings", { conflictMode: "queue" });
          const queuedPush = await postPush(beforePush.endpoint, {
            uri: `push://url?url=${encodeURIComponent(options.pushUrl)}&title=Packaged%20Queue`,
          });
          const queuedId = isRecord(queuedPush.preview) && typeof queuedPush.preview.id === "string"
            ? queuedPush.preview.id
            : null;
          const queued = queuedId
            ? await postPush(pushActionEndpoint(beforePush.endpoint, "confirm"), { id: queuedId, decision: "play", mode: "queue" })
            : null;
          const cancelled = queuedId
            ? await postPush(pushActionEndpoint(beforePush.endpoint, "cancel"), { id: queuedId })
            : null;
          const queuedRecent = isRecord(queued?.recent) ? queued.recent : null;
          const cancelledRecent = isRecord(cancelled?.recent) ? cancelled.recent : null;
          const queuedState = await post(options.baseUrl, "/api/push/refresh");
          checks.push = pushed.kind === "confirmation-required"
            && confirmationId !== null
            && confirmed?.state?.playbackSession?.id !== undefined
            && confirmed.state.player?.source?.url?.includes("/__qx_playback/") === true
            && pushState?.recent[0]?.status === "accepted"
            && !JSON.stringify(pushState?.recent[0]).includes(options.pushUrl)
            && rejectedId !== null
            && rejected?._status === 409
            && rejectedState.state?.push?.recent.some((item) => item.status === "rejected") === true
            && queuedId !== null
            && queuedRecent?.status === "queued"
            && cancelledRecent?.status === "cancelled"
            && queuedState.state?.push?.recent.some((item) => item.status === "cancelled") === true;
          await post(options.baseUrl, "/api/push/settings", { conflictMode: "replace" });
          await post(options.baseUrl, "/api/player/stop");
        }
      }
      const playbackDetail = await post(options.baseUrl, "/api/detail", { vodId: "fixture:movie-1" });
      if (options.verifyHistory) {
        checks.historyRestart = options.freshTrust
          || playbackDetail.state?.historyResume?.position === 44;
      }
      if (options.verifyFavorites) {
        const existingFavoriteId = playbackDetail.state?.favoriteDetail?.favoriteId;
        if (options.expectedFavoriteId !== undefined) {
          checks.favoritesRestart = existingFavoriteId === options.expectedFavoriteId;
        }
        if (typeof existingFavoriteId === "string") {
          await post(options.baseUrl, "/api/favorites/delete", { favoriteId: existingFavoriteId });
        }
        const toggled = await post(options.baseUrl, "/api/favorites/toggle-detail");
        favoriteId = toggled.state?.favoriteDetail?.favoriteId ?? null;
        const existingGroup = toggled.state?.favorites?.groups.find((group) => group.name === "E2E 收藏");
        const createdGroup = existingGroup
          ? toggled
          : await post(options.baseUrl, "/api/favorites/group/create", { name: "E2E 收藏" });
        const group = createdGroup.state?.favorites?.groups.find((entry) => entry.name === "E2E 收藏");
        const moved = typeof favoriteId === "string" && group
          ? await post(options.baseUrl, "/api/favorites/move", { favoriteId, groupId: group.groupId })
          : null;
        const openedFavorite = typeof favoriteId === "string"
          ? await post(options.baseUrl, "/api/favorites/open", { favoriteId })
          : null;
        checks.favorites = typeof favoriteId === "string"
          && toggled.state?.favoriteDetail?.favoriteId === favoriteId
          && group !== undefined
          && moved?.state?.favoriteDetail?.groupId === group.groupId
          && openedFavorite?.state?.page === "detail"
          && openedFavorite.state?.detail?.vod_id === "fixture:movie-1";
      }
      const playbackDetailHtml = await readPage(options);
      const mp4 = await post(options.baseUrl, "/api/player", {
        lineIndex: 1,
        episodeIndex: 0,
        vipFlags: ["e2e"],
      });
      const mp4Html = await readPage(options);
      const mp4Dom = await probeWindow(options, mp4Html);
      const hls = await post(options.baseUrl, "/api/player", {
        lineIndex: 0,
        episodeIndex: 0,
      });
      const hlsHtml = await readPage(options);
      if (options.captureWindow) await options.captureWindow("player-hls");
      const hlsDom = await probeWindow(options, hlsHtml);
      if (options.verifyDanmaku) {
        const loaded = await post(options.baseUrl, "/api/danmaku/load", {
          format: "json",
          source: "fixture-danmaku",
          data: JSON.stringify({ items: [{ id: "e2e-danmaku", timeMs: 1_000, text: "fixture 弹幕", type: "scroll", source: "fixture" }] }),
        });
        const synced = await post(options.baseUrl, "/api/player/sync", {
          status: "playing",
          currentTime: 1.2,
          duration: 100,
          event: { type: "first-frame" },
        });
        const danmakuHtml = await readPage(options);
        checks.danmaku = loaded.state?.danmaku?.status === "ready"
          && loaded.state.danmaku.totalCount === 1
          && synced.state?.danmaku?.playing === true
          && synced.state.danmaku.currentTimeMs === 1_200
          && (!options.readWindowHtml
            || (danmakuHtml.includes('data-testid="danmaku-overlay"')
              && danmakuHtml.includes('data-rendered-count="1"')));
      }
      const headered = await post(options.baseUrl, "/api/player", {
        lineIndex: 0,
        episodeIndex: 1,
      });
      const headeredHtml = await readPage(options);
      const headeredDom = await probeWindow(options, headeredHtml);
      const headeredPlaylist = options.verifyPlaybackRules && playerSourceUrl(headered.state)
        ? await fetch(playerSourceUrl(headered.state) as string).then((response) => response.text())
        : "";
      let sessionReference = headered;
      if (options.verifyHistory) {
        const firstFrame = await post(options.baseUrl, "/api/player/sync", {
          status: "playing",
          currentTime: 44,
          duration: 100,
          event: { type: "first-frame" },
        });
        const paused = await post(options.baseUrl, "/api/player/sync", {
          status: "paused",
          currentTime: 44,
          duration: 100,
          event: { type: "user-pause" },
        });
        const resumeDetail = await post(options.baseUrl, "/api/detail", { vodId: "fixture:movie-1" });
        const resumed = await post(options.baseUrl, "/api/player", {
          lineIndex: 0,
          episodeIndex: 1,
          resume: "continue",
        });
        sessionReference = resumed;
        const historyItems = paused.state?.history?.items ?? [];
        checks.history = firstFrame.state?.history !== undefined
          && historyItems.some((item) => item.position === 44 && item.duration === 100)
          && resumeDetail.state?.historyResume?.position === 44
          && resumed.state?.player?.currentTime === 44;
      }
      if (options.verifyFollow) {
        const existingFollowIdentity = playbackDetail.state?.followDetail?.identity;
        if (options.expectedFollowIdentity !== undefined) {
          checks.followRestart = existingFollowIdentity === options.expectedFollowIdentity;
        }
        const followed = typeof existingFollowIdentity === "string"
          ? playbackDetail
          : await post(options.baseUrl, "/api/follow/toggle-detail");
        followIdentity = stringField(followed.state?.followDetail?.identity);
        const refreshed = typeof followIdentity === "string"
          ? await post(options.baseUrl, "/api/follow/refresh")
          : null;
        const refreshedItem = followItem(refreshed?.state ?? null, followIdentity);
        const markedWatched = typeof followIdentity === "string"
          ? await post(options.baseUrl, "/api/follow/mark-watched", { identity: followIdentity })
          : null;
        const watchedItem = followItem(markedWatched?.state ?? null, followIdentity);
        const markedUnwatched = typeof followIdentity === "string"
          ? await post(options.baseUrl, "/api/follow/mark-unwatched", { identity: followIdentity })
          : null;
        const unwatchedItem = followItem(markedUnwatched?.state ?? null, followIdentity);
        let followHtml = "";
        if (options.readWindowHtml) {
          await post(options.baseUrl, "/api/view-state", { navigation: "follow" });
          followHtml = await readPage(options);
          await post(options.baseUrl, "/api/view-state", {
            navigation: "detail",
            recentDetailId: "fixture:movie-1",
          });
          await readPage(options);
        }
        checks.follow = typeof followIdentity === "string"
          && typeof refreshedItem?.lastCheckedAt === "number"
          && refreshedItem?.checkError === null
          && watchedItem?.updateAvailable === false
          && unwatchedItem?.updateAvailable === true
          && markedUnwatched?.state?.follow?.updateCount === 1
          && (!options.readWindowHtml || followHtml.includes('data-testid="follow-page"'));
      }
      const detached = await post(options.baseUrl, "/api/player/detach");
      const detachedHtml = await readPage(options);
      const opened = await post(options.baseUrl, "/api/player/open");
      const attached = await post(options.baseUrl, "/api/player/attach");
      const attachedHtml = await readPage(options);
      const parsed = await post(options.baseUrl, "/api/player", {
        flag: "default",
        id: "parse-one",
        vipFlags: [],
      });
      checks.embeddedMp4 = playbackReady
        && playbackOpened.state?.status === "ready"
        && mp4.state?.player?.status === "loading"
        && playerSourceUrl(mp4.state) !== null
        && isLocalProxyUrl(playerSourceUrl(mp4.state))
        && mp4Html.includes('data-testid="embedded-player"');
      checks.embeddedHls = hls.state?.player?.status === "loading"
        && isLocalProxyUrl(playerSourceUrl(hls.state))
        && hlsHtml.includes('data-testid="embedded-player"')
        && (hlsHtml.includes("/assets/hls.min.js") || hlsDom?.hlsLoaded === true);
      if (options.verifyCast) {
        const discovered = await post(options.baseUrl, "/api/cast/discover");
        const discoveredCast = discovered.cast ?? discovered.state?.cast;
        const deviceId = discoveredCast?.devices[0]?.deviceId;
        const casted = deviceId
          ? await post(options.baseUrl, "/api/cast/play", { deviceId })
          : null;
        const castState = casted?.cast ?? casted?.state?.cast;
        const stopped = casted ? await post(options.baseUrl, "/api/cast/stop") : null;
        const disconnected = await post(options.baseUrl, "/api/cast/disconnect");
        checks.cast = discoveredCast?.discoveryStatus === "ready"
          && deviceId !== undefined
          && castState?.session?.state === "playing"
          && stopped?.cast?.session?.state === "stopped"
          && disconnected.cast?.session === null;
        checks.castRestart = options.freshTrust
          || (disconnected.cast?.discoveryStatus === "ready" && disconnected.cast.session === null);
      }
      checks.parseChain = parsed.state?.player?.status === "loading"
        && parsed.state?.error === null
        && parsed.state?.player?.error === null
        && parsed.state?.player?.source?.parse === 0
        && isLocalProxyUrl(playerSourceUrl(parsed.state));
      if (options.verifyParserFallback) {
        const attempts = parsed.state?.player?.parse?.attempts ?? [];
        checks.parserFallback = parsed.state?.player?.parse?.status === "succeeded"
          && attempts.length === 2
          && attempts[0]?.status === "error"
          && attempts[1]?.status === "succeeded";
      }
      if (options.verifySniffFallback) {
        const sniffFallback = await post(options.baseUrl, "/api/player", {
          flag: "default",
          id: "parse-sniff",
          vipFlags: [],
        });
        const parseState = sniffFallback.state?.player?.parse;
        checks.sniffFallback = sniffFallback.state?.player?.status === "loading"
          && sniffFallback.state?.error === null
          && sniffFallback.state?.player?.error === null
          && parseState?.status === "succeeded"
          && parseState.parserId === "isolated-sniffer"
          && playerSourceUrl(sniffFallback.state)?.includes("/__qx_playback/") === true;
      }
      if (options.verifyPlaybackRules) {
        checks.playbackRules = headeredPlaylist.includes("#EXTM3U")
          && !headeredPlaylist.includes("#EXT-X-CUE-OUT");
      }
      checks.vodPlaybackFlow = playbackReady
        && playbackOpened.state?.status === "ready"
        && playbackHome.state?.page === "home"
        && playbackDetail.state?.page === "detail"
        && playbackDetailHtml.includes('data-testid="playback-selector"')
        && playbackDetailHtml.includes('data-order="forward"')
        && playbackDetailHtml.includes('data-order="reverse"')
        && playbackDetailHtml.includes('data-play-flag="主线"')
        && playbackDetailHtml.includes('data-play-id="headered"')
        && playbackDetailHtml.includes('data-play-id="direct-mp4"')
        && mp4.state?.playbackSelection?.lineIndex === 1
        && mp4.state?.playbackSelection?.episodeIndex === 0
        && hls.state?.playbackSelection?.lineIndex === 0
        && hls.state?.playbackSelection?.episodeIndex === 0
        && headered.state?.playbackSelection?.lineIndex === 0
        && headered.state?.playbackSelection?.episodeIndex === 1;
      checks.proxyRequired = headered.state?.error?.code === "PLAYBACK_PROXY_REQUIRED"
        ? false
        : headered.state?.player?.status === "loading"
          && playerSourceUrl(headered.state)?.includes("/__qx_playback/") === true
          && playerSourceHeaders(headered.state) !== null
          && Object.keys(playerSourceHeaders(headered.state) ?? {}).length === 0
          && headeredHtml.includes('data-testid="embedded-player"');
      const sessionId = sessionReference.state?.playbackSession?.id;
      checks.singlePlaybackSession = typeof sessionId === "string"
        && detached.state?.playbackSession?.id === sessionId
        && attached.state?.playbackSession?.id === sessionId
        && playerSourceUrl(detached.state) === playerSourceUrl(sessionReference.state)
        && playerSourceUrl(attached.state) === playerSourceUrl(sessionReference.state);
      checks.noBackgroundPlayer = detached.state?.playerHost === "detached"
        && (!options.readWindowHtml
          || (detachedHtml.includes('data-testid="detached-player-panel"')
            && !detachedHtml.includes('data-testid="embedded-player"')));
      checks.detachablePlayer = checks.singlePlaybackSession
        && checks.noBackgroundPlayer
        && opened.state?.playerHost === "detached"
        && attached.state?.playerHost === "embedded"
        && (!options.readWindowHtml || attachedHtml.includes('data-testid="embedded-player"'));
      checks.noExternalBrowser = !mp4Html.includes("window.open")
        && !hlsHtml.includes("window.open")
        && !headeredHtml.includes("window.open")
        && !mp4Html.includes("_blank")
        && !hlsHtml.includes("_blank")
        && !headeredHtml.includes("_blank");
      if (mp4Dom && hlsDom) {
        checks.embeddedMp4Dom = mp4Dom.hasVideo
          && mp4Dom.readyState >= 1
          && isLocalProxyUrl(mp4Dom.src);
        checks.embeddedHlsDom = hlsDom.hasVideo && hlsDom.hlsLoaded && hlsDom.readyState >= 1;
      }
      if (headeredDom) {
        checks.proxyHlsDom = headeredDom.hasVideo
          && headeredDom.hlsLoaded
          && headeredDom.readyState >= 1;
      }
      if (options.verifyPlaybackDebug) {
        checks.playbackDebug = await probePlaybackDebug(options);
      }
      if (options.verifySubtitleTracks) {
        const tracks = hls.state?.player?.source?.subtitles;
        const subtitlePanel = !options.readWindowHtml
          || (hlsHtml.includes('data-testid="subtitle-track-panel"')
            && hlsHtml.includes('data-action="subtitle-encoding"')
            && hlsHtml.includes('data-action="subtitle-local-file"'));
        checks.subtitleTracks = Array.isArray(tracks)
          && tracks.length >= 2
          && tracks.every((track) => isRecord(track)
            && typeof track.url === "string"
            && track.url.includes("/__qx_playback/")
            && (!track.headers || Object.keys(track.headers).length === 0))
          && subtitlePanel;
      }
      if (options.verifyPlaybackHealth) {
        const healthStart = await post(options.baseUrl, "/api/player/sync", {
          status: "playing",
          currentTime: 1,
          event: { type: "buffer-start" },
        });
        const healthEnd = await post(options.baseUrl, "/api/player/sync", {
          status: "playing",
          currentTime: 2,
          event: { type: "buffer-end" },
        });
        const healthHtml = await readPage(options);
        const startBufferingCount = healthStart.state?.playbackHealth?.bufferingCount?.value;
        const endBufferingCount = healthEnd.state?.playbackHealth?.bufferingCount?.value;
        checks.playbackHealth = healthStart.state?.playbackHealth !== undefined
          && typeof endBufferingCount === "number"
          && endBufferingCount > 0
          && (typeof startBufferingCount !== "number" || endBufferingCount >= startBufferingCount)
          && healthHtml.includes('data-testid="playback-health-panel"')
          && healthHtml.includes('data-action="playback-fallback-mode"')
          && healthHtml.includes('data-action="playback-fallback-debug"');
      }
      if (options.verifyPlaybackFallback) {
        const fallbackDetail = await post(options.baseUrl, "/api/detail", { vodId: "fixture:fallback" });
        const fallback = await post(options.baseUrl, "/api/player", {
          lineIndex: 0,
          episodeIndex: 0,
        });
        const tried = fallback.state?.fallback?.tried ?? [];
        checks.playbackFallback = fallbackDetail.state?.page === "detail"
          && fallback.state?.fallback?.status === "recovered"
          && fallback.state?.playbackSelection?.lineIndex === 1
          && fallback.state?.playbackSelection?.episodeIndex === 0
          && tried.includes("current-retry")
          && tried.includes("current-reparse")
          && tried.some((id) => id.startsWith("line:1:episode:0"))
          && fallback.state?.player?.status === "loading"
          && isLocalProxyUrl(playerSourceUrl(fallback.state));
      }
      if (options.verifyLocalMedia) {
        if (!options.localMediaFile) throw new Error("Packaged local media E2E file is not configured");
        const beforeLocalState = await getState(options.baseUrl);
        const beforeLocal = beforeLocalState.state?.history?.items.find((item) => item.sourceType === "local");
        const openedLocal = await post(options.baseUrl, "/api/local-media/open-file");
        const localItems = openedLocal.state?.localMedia?.items ?? [];
        const localItem = localItems.find((item) => item.displayName === "local-fixture.mp4") ?? localItems[0];
        const playedLocal = localItem
          ? await post(options.baseUrl, "/api/local-media/play", { itemId: localItem.id })
          : null;
        const localSessionId = typeof playedLocal?.state?.playbackSession?.id === "string"
          ? playedLocal.state.playbackSession.id
          : undefined;
        const localUrl = playedLocal ? playerSourceUrl(playedLocal.state) : null;
        const rangeResponse = localUrl
          ? await fetch(localUrl, { headers: { range: "bytes=0-3" } })
          : null;
        const rangeBodyLength = rangeResponse ? (await rangeResponse.arrayBuffer()).byteLength : null;
        let localHtml = "";
        if (options.readWindowHtml) {
          await post(options.baseUrl, "/api/view-state", { navigation: "local" });
          localHtml = await readPage(options);
          if (options.evaluateWindow) {
            localHtml = await readWindowUntil(options, '[data-testid="local-media-page"]');
            localMediaProbe = await probeLocalMedia(options);
          }
        }
        const localPlaying = playedLocal
          ? await post(options.baseUrl, "/api/player/sync", {
              ...(localSessionId ? { sessionId: localSessionId } : {}),
              status: "playing",
              currentTime: 3,
              duration: 100,
              event: { type: "first-frame" },
            })
          : null;
        const localPaused = localPlaying
          ? await post(options.baseUrl, "/api/player/sync", {
              ...(localSessionId ? { sessionId: localSessionId } : {}),
              status: "paused",
              currentTime: 3,
              duration: 100,
              event: { type: "user-pause" },
            })
          : null;
        const localHistory = localPaused?.state?.history?.items.find((item) => item.sourceType === "local");
        const localStopped = localPaused ? await post(options.baseUrl, "/api/player/stop") : null;
        checks.localMedia = localItem !== undefined
          && openedLocal.state?.localMedia?.items.some((item) => item.fileReference.startsWith("local-file:")) === true
          && rangeResponse?.status === 206
          && rangeBodyLength === 4
          && localUrl?.includes("/api/local-media/stream/") === true
          && localHistory?.position === 3
          && (!options.evaluateWindow || localMediaProbe?.status === "PASS")
          && (!options.readWindowHtml || localHtml.includes('data-testid="local-media-page"'));
        checks.localMediaRestart = options.freshTrust
          ? true
          : (beforeLocal ?? localStopped?.state?.history?.items.find((item) => item.sourceType === "local"))?.position === 3;
        void options.localMediaFile;
      }
      if (options.verifyDownloads) {
        if (!options.downloadDirectory) throw new Error("Packaged download E2E directory is not configured");
        const beforeDownloads = await getState(options.baseUrl);
        let downloadState = beforeDownloads.state?.downloads ?? beforeDownloads.downloads;
        let target = downloadState?.targetDirectories[0];
        if (!target) {
          const selected = await post(options.baseUrl, "/api/downloads/select-folder");
          downloadState = selected.state?.downloads ?? selected.downloads;
          target = downloadState?.targetDirectories[0];
        }
        if (!target) throw new Error("Packaged download E2E did not select a target directory");
        let downloadResult = beforeDownloads;
        let pauseVerified = false;
        let resumeVerified = false;
        if (options.freshTrust && (!downloadState || downloadState.tasks.length === 0)) {
          const addedDownload = await post(options.baseUrl, "/api/downloads/add", {
            title: "Packaged download fixture",
            url: options.downloadUrl ?? "https://media.example.test/files/fixture.mp4",
            filename: "fixture.mp4",
            targetDirectoryId: target.id,
          });
          const addedTask = addedDownload.state?.downloads?.tasks[0] ?? addedDownload.downloads?.tasks[0];
          if (!addedTask) throw new Error("Packaged download E2E did not create a task");
          if (options.realDownloads) {
            pauseVerified = true;
            resumeVerified = true;
          } else {
            const paused = await post(options.baseUrl, "/api/downloads/pause", { taskId: addedTask.id });
            pauseVerified = paused.state?.downloads?.tasks[0]?.status === "paused"
              || paused.downloads?.tasks[0]?.status === "paused";
            const resumed = await post(options.baseUrl, "/api/downloads/resume", { taskId: addedTask.id });
            resumeVerified = resumed.state?.downloads?.tasks[0]?.status === "downloading"
              || resumed.downloads?.tasks[0]?.status === "downloading";
          }
          downloadResult = await post(options.baseUrl, "/api/downloads/refresh");
        } else {
          downloadResult = await post(options.baseUrl, "/api/downloads/refresh");
        }
        const finalDownloads = downloadResult.state?.downloads ?? downloadResult.downloads;
        const downloadTask = finalDownloads?.tasks.find((task) => task.title === "Packaged download fixture")
          ?? finalDownloads?.tasks[0];
        let downloadsHtml = "";
        if (options.readWindowHtml) {
          await post(options.baseUrl, "/api/view-state", { navigation: "downloads" });
          downloadsHtml = await readPage(options);
        }
        checks.downloads = target.id.startsWith("download-dir-")
          && downloadTask?.status === "completed"
          && downloadTask.requestReference.startsWith("download:")
          && !JSON.stringify({ finalDownloads, downloadsHtml }).includes(options.downloadDirectory)
          && !JSON.stringify({ finalDownloads, downloadsHtml }).includes("https://media.example.test")
          && (!options.freshTrust || (pauseVerified && resumeVerified))
          && (!options.readWindowHtml || downloadsHtml.includes('data-testid="downloads-page"'));
        checks.downloadsRestart = options.freshTrust
          ? true
          : downloadTask?.status === "completed" && downloadTask.title === "Packaged download fixture";
      }
    }

    const repeated = await load(options.baseUrl, options.configJson);
    checks.trustedReimport = repeated.import.status === "ready" && repeated.import.trusted;
    if (options.startAgain) {
      const startedAgain = await options.startAgain();
      checks.repeatedStart = startedAgain.url === options.baseUrl;
      if (options.verifyWebControl && options.webControlUrl) {
        checks.webControlRestart = await verifyWebControlEndpoint(options.webControlUrl);
      }
    } else {
      checks.repeatedStart = false;
    }

    if (options.captureWindow) {
      const p3Views = [
        "downloads",
        "history",
        "favorites",
        "follow",
        "local",
        "settings",
      ] as const;
      for (const navigation of p3Views) {
        for (const theme of ["light", "dark"] as const) {
          await post(options.baseUrl, "/api/view-state", { navigation, theme });
          await readPage(options);
          await options.captureWindow(`p3-${navigation}-${theme}`);
        }
      }
      await post(options.baseUrl, "/api/view-state", { navigation: "settings", theme: "light" });
      await readPage(options);
      await new Promise<void>((resolve) => setTimeout(resolve, 2500));
      await readPage(options);
      await options.captureWindow("settings-runtime-light");
      await post(options.baseUrl, "/api/view-state", { navigation: "settings", theme: "dark" });
      await readPage(options);
      await new Promise<void>((resolve) => setTimeout(resolve, 2500));
      await readPage(options);
      await options.captureWindow("settings-runtime-dark");
      await post(options.baseUrl, "/api/view-state", { navigation: "home", theme: "light" });
    }

    const finalOpened = await post(options.baseUrl, "/api/open");
    sidecarPid = options.getSidecarPid?.() ?? null;
    let finalClosedState: UiState | null = null;
    if (options.closeWindow) {
      await options.closeWindow();
    } else {
      const finalClosed = await post(options.baseUrl, "/api/import/cancel");
      finalClosedState = finalClosed.state;
    }
    checks.sidecarStopped = finalOpened.state?.status === "ready"
      && sidecarPid !== null
      && (finalClosedState === null || finalClosedState.status === "destroyed")
      && (options.waitForSidecarExit
        ? await options.waitForSidecarExit(sidecarPid)
        : false);
    if (options.resourceCleanup) {
      const cleanup = await options.resourceCleanup();
      checks.proxyCleanup = cleanup.proxySessions === 0;
      checks.snifferCleanup = cleanup.snifferSessions === 0;
    }

    return {
      status: Object.values(checks).every(Boolean) ? "passed" : "failed",
      checks,
      searchVodId,
      detailVodId,
      favoriteId,
      followIdentity,
      sidecarPid,
      ...(localMediaProbe ? { localMediaProbe } : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      checks,
      searchVodId,
      detailVodId,
      favoriteId,
      followIdentity,
      sidecarPid,
      ...(localMediaProbe ? { localMediaProbe } : {}),
      error: errorMessage(error),
    };
  }
}

async function captureWindow(options: PackagedE2eOptions, name: string): Promise<void> {
  if (options.captureWindow) await options.captureWindow(name);
}

async function verifyWebControlEndpoint(baseUrl: string): Promise<boolean> {
  const origin = new URL(baseUrl).origin;
  const root = await fetch(new URL("/", baseUrl));
  const html = await root.text();
  const token = /<meta name="qx-csrf-token" content="([^"]+)"/u.exec(html)?.[1];
  const csp = root.headers.get("content-security-policy") ?? "";
  const safe = await fetch(new URL("/api/safe-status", baseUrl), {
    headers: { Origin: origin },
  });
  const safeValue: unknown = await safe.json();
  const search = await fetch(new URL("/api/search?q=fixture", baseUrl), {
    headers: { Origin: origin },
  });
  const searchValue: unknown = await search.json();
  const rejected = await fetch(new URL("/api/volume", baseUrl), {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ volume: 0.5 }),
  });
  const accepted = token
    ? await fetch(new URL("/api/volume", baseUrl), {
        method: "POST",
        headers: { Origin: origin, "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({ volume: 0.5 }),
      })
    : null;
  const safeStatus = isRecord(safeValue) && isRecord(safeValue.status) ? safeValue.status : null;
  const searchResult = isRecord(searchValue) && isRecord(searchValue.search) ? searchValue.search : null;
  return root.ok
    && html.includes("/app.js")
    && csp.includes("default-src 'self'")
    && root.headers.get("access-control-allow-origin") !== "*"
    && token !== undefined
    && safe.ok
    && safeStatus?.host === "127.0.0.1"
    && safeStatus?.port === Number(new URL(baseUrl).port)
    && search.ok
    && Array.isArray(searchResult?.items)
    && rejected.status === 403
    && accepted?.ok === true
    && !JSON.stringify({ safeValue, searchValue }).includes("stack");
}

async function page(baseUrl: string): Promise<string> {
  const response = await fetch(new URL("/", baseUrl));
  return response.text();
}

async function readPage(options: PackagedE2eOptions): Promise<string> {
  return options.readWindowHtml ? options.readWindowHtml() : page(options.baseUrl);
}

async function readWindowUntil(options: PackagedE2eOptions, selector: string): Promise<string> {
  if (!options.evaluateWindow) return "";
  const result = await options.evaluateWindow(`(() => new Promise((resolve) => {
    const started = Date.now();
    const read = () => {
      if (document.querySelector(${JSON.stringify(selector)})) {
        resolve(document.documentElement.outerHTML);
        return;
      }
      if (Date.now() - started > 5000) {
        resolve(document.documentElement.outerHTML);
        return;
      }
      window.setTimeout(read, 25);
    };
    read();
  }))()`);
  return typeof result === "string" ? result : "";
}

async function probeLocalMedia(options: PackagedE2eOptions): Promise<Record<string, unknown>> {
  if (!options.evaluateWindow) throw new Error("Packaged local media probe requires a renderer evaluator");
  const value = await options.evaluateWindow(`(() => new Promise((resolve) => {
    const started = Date.now();
    const fatalErrors = [];
    const finish = (status, reason, video) => resolve({
      status,
      ...(reason ? { reason } : {}),
      hasVideo: Boolean(video),
      videoWidth: video?.videoWidth || 0,
      videoHeight: video?.videoHeight || 0,
      currentTimeStart: video?.__qxLocalStart ?? null,
      currentTimeEnd: video?.currentTime ?? null,
      readyState: video?.readyState || 0,
      errorCode: video?.error?.code ?? null,
      fatal: Boolean(video?.error) || fatalErrors.length > 0,
      fatalErrors,
    });
    const waitForVideo = () => {
      const video = document.querySelector('[data-testid="embedded-player"]');
      if (!video) {
        if (Date.now() - started > 20_000) finish('FAIL', 'VIDEO_ELEMENT_MISSING', null);
        else window.setTimeout(waitForVideo, 100);
        return;
      }
      video.addEventListener('error', () => {
        if (!fatalErrors.includes('MEDIA_ERROR')) fatalErrors.push('MEDIA_ERROR');
      });
      const waitForMetadata = () => {
        if (video.error) {
          finish('FAIL', 'FATAL_MEDIA_ERROR', video);
          return;
        }
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          video.pause();
          try { video.currentTime = 0; } catch (_) { /* metadata is already the acceptance gate */ }
          video.__qxLocalStart = video.currentTime;
          const requestPlay = () => {
            const button = document.querySelector('[data-action="player-play"]');
            if (button instanceof HTMLElement) button.click();
            void video.play().catch(() => undefined);
          };
          requestPlay();
          const deadline = Date.now() + 6_000;
          const waitForAdvance = () => {
            if (video.error) {
              finish('FAIL', 'FATAL_MEDIA_ERROR', video);
              return;
            }
            if (video.currentTime > video.__qxLocalStart + 0.05) {
              finish('PASS', undefined, video);
              return;
            }
            if (Date.now() >= deadline) {
              finish('FAIL', 'VIDEO_CURRENT_TIME_DID_NOT_ADVANCE', video);
              return;
            }
            window.setTimeout(waitForAdvance, 100);
          };
          waitForAdvance();
          return;
        }
        if (Date.now() - started > 20_000) {
          finish('FAIL', 'VIDEO_METADATA_NOT_LOADED', video);
          return;
        }
        window.setTimeout(waitForMetadata, 100);
      };
      waitForMetadata();
    };
    waitForVideo();
  }))()`);
  if (!isRecord(value)
    || (value.status !== "PASS" && value.status !== "FAIL")
    || typeof value.hasVideo !== "boolean"
    || typeof value.videoWidth !== "number"
    || typeof value.videoHeight !== "number"
    || (value.currentTimeStart !== null && typeof value.currentTimeStart !== "number")
    || (value.currentTimeEnd !== null && typeof value.currentTimeEnd !== "number")
    || typeof value.readyState !== "number"
    || (value.errorCode !== null && typeof value.errorCode !== "number")
    || typeof value.fatal !== "boolean") {
    throw new Error(`Packaged local media probe returned an invalid result: ${JSON.stringify(value)}`);
  }
  return value;
}

async function load(baseUrl: string, input: string): Promise<UiEnvelope> {
  return post(baseUrl, "/api/import/load", { input });
}

async function confirmIfNeeded(baseUrl: string, status: string): Promise<boolean> {
  if (status === "ready") return true;
  if (status !== "confirmation_required") return false;
  const confirmed = await post(baseUrl, "/api/import/confirm");
  return confirmed.import.status === "ready" && confirmed.import.trusted;
}

async function post(
  baseUrl: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<UiEnvelope> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || !isRecord(value.import)) {
    throw new Error(`Packaged E2E request failed: ${path} ${isRecord(value) ? JSON.stringify(value) : ""}`);
  }
  return {
    import: value.import as unknown as ImportState,
    state: isRecord(value.state) ? value.state as unknown as UiState : null,
    ...(isRecord(value.downloads) ? { downloads: value.downloads as unknown as DownloadState } : {}),
    ...(isRecord(value.push) ? { push: value.push as unknown as PushState } : {}),
    ...(isRecord(value.cast) ? { cast: value.cast as unknown as CastState } : {}),
  };
}

async function postPush(
  endpoint: string,
  body: Record<string, unknown>,
  allowFailure = false,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!isRecord(value) || (!response.ok && !allowFailure)) {
    throw new Error(`Packaged Push request failed: ${response.status}`);
  }
  return { ...value, _status: response.status };
}

function pushActionEndpoint(endpoint: string, action: "confirm" | "cancel"): string {
  return endpoint.endsWith("/push") ? `${endpoint}/${action}` : `${endpoint}/push/${action}`;
}

async function getState(baseUrl: string): Promise<UiEnvelope> {
  const response = await fetch(new URL("/api/state", baseUrl));
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || !isRecord(value.import)) {
    throw new Error("Packaged E2E state request failed");
  }
  return {
    import: value.import as unknown as ImportState,
    state: isRecord(value.state) ? value.state as unknown as UiState : null,
    ...(isRecord(value.downloads) ? { downloads: value.downloads as unknown as DownloadState } : {}),
    ...(isRecord(value.push) ? { push: value.push as unknown as PushState } : {}),
  };
}

function firstVodId(state: UiState | null): string {
  const aggregateId = state?.aggregateSearch?.groups[0]?.items[0]?.id;
  if (typeof aggregateId === "string" && aggregateId.length > 0) return aggregateId;
  const value = state?.items[0]?.vod_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Packaged E2E search returned no vod_id");
  }
  return value;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function emptyChecks(): PackagedE2eChecks {
  return {
    initialImportForm: false,
    urlImport: false,
    cancellation: false,
    fileImport: false,
    jsonImport: false,
    searchDetail: false,
    sidecarStopped: false,
    repeatedStart: false,
    trustedReimport: false,
    doubanUnavailable: false,
  };
}

function validCacheState(value: UiState["cache"]): value is NonNullable<UiState["cache"]> {
  return isRecord(value)
    && typeof value.totalBytes === "number"
    && typeof value.maxBytes === "number"
    && typeof value.entries === "number"
    && Array.isArray(value.byType)
    && value.byType.length === CACHE_TYPES.length
    && value.byType.every((item) => isRecord(item)
      && typeof item.type === "string"
      && typeof item.count === "number"
      && typeof item.bytes === "number");
}

function validStorageState(value: UiState["storage"]): value is NonNullable<UiState["storage"]> {
  return isRecord(value)
    && (value.mode === "normal" || value.mode === "portable")
    && typeof value.dataRoot === "string"
    && typeof value.databaseBytes === "number"
    && typeof value.cacheBytes === "number"
    && typeof value.totalBytes === "number"
    && typeof value.writable === "boolean";
}

function followItem(state: UiState | null, identity: string | null): Record<string, unknown> | null {
  if (!state || !identity || !state.follow) return null;
  const item = state.follow.items.find((candidate) => candidate.identity === identity);
  return isRecord(item) ? item : null;
}

interface UiEnvelope {
  import: ImportState;
  state: UiState | null;
  downloads?: DownloadState;
  push?: PushState;
  cast?: CastState;
}

interface ImportState {
  status: string;
  trusted: boolean;
}

interface DownloadState {
  tasks: readonly {
    id: string;
    title: string;
    targetDirectoryId: string;
    suggestedFilename: string;
    requestReference: string;
    status: string;
    error: string | null;
  }[];
  targetDirectories: readonly { id: string; displayName: string }[];
  backend?: string;
  aria2Available?: boolean;
  error?: { code: string; message: string } | null;
}

interface PushState {
  enabled: boolean;
  configuredPort: number;
  port: number | null;
  listening: boolean;
  endpoint: string | null;
  recent: readonly { status: string }[];
}

interface CastState {
  discoveryStatus: string;
  devices: readonly { deviceId: string }[];
  session: { state: string } | null;
}

interface UiState {
  page: string;
  status: string;
  items: readonly Record<string, unknown>[];
  detail: Record<string, unknown> | null;
  error?: { code?: string; message?: string } | null;
  player?: {
    status?: string;
    currentTime?: number;
    duration?: number;
    parse?: {
      status?: string;
      parserId?: string | null;
      attempts?: readonly { status?: string }[];
    };
    source?: {
      parse?: number;
      url?: string;
      headers?: Record<string, unknown>;
      subtitles?: readonly Record<string, unknown>[];
    } | null;
    error?: { code?: string; message?: string } | null;
  } | null;
  danmaku?: {
    status?: string;
    totalCount?: number;
    currentTimeMs?: number;
    playing?: boolean;
  };
  playbackSelection?: { lineIndex?: number; episodeIndex?: number } | null;
  playerHost?: "embedded" | "detached";
  playbackSession?: { id?: string; host?: "embedded" | "detached" } | null;
  aggregateSearch?: {
    status: string;
    completed: number;
    total: number;
    sources: readonly { status: string }[];
    groups: readonly { items: readonly { id?: string }[] }[];
  } | null;
  fallback?: {
    status?: string;
    tried?: readonly string[];
  };
  playbackHealth?: {
    bufferingCount?: { value?: number | null; samples?: number };
  };
  history?: {
    items: readonly { position: number; duration: number; sourceType?: "remote" | "local" }[];
    paused: boolean;
  };
  localMedia?: {
    items: readonly {
      id: string;
      displayName: string;
      fileReference: string;
    }[];
  };
  downloads?: DownloadState;
  push?: PushState;
  cast?: CastState;
  historyResume?: { position: number } | null;
  favoriteDetail?: { favoriteId?: string; groupId?: string | null } | null;
  favorites?: {
    items: readonly Record<string, unknown>[];
    groups: readonly { groupId: string; name: string; count: number }[];
  };
  follow?: {
    items: readonly Record<string, unknown>[];
    checking: boolean;
    updateCount: number;
  };
  followDetail?: { identity?: string } | null;
  cache?: {
    totalBytes: number;
    maxBytes: number;
    entries: number;
    byType: readonly { type: string; count: number; bytes: number }[];
  };
  storage?: {
    mode: "normal" | "portable";
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
  };
  backup?: {
    status: string;
    lastBackup?: { fileName?: string } | null;
    preview?: { compatibility?: string } | null;
  };
}

function playerSourceUrl(state: UiState | null): string | null {
  const source = state?.player?.source;
  return typeof source?.url === "string" ? source.url : null;
}

function isLocalProxyUrl(url: string | null): boolean {
  return typeof url === "string" && /\/__qx_playback\//u.test(url);
}

function playerSourceHeaders(state: UiState | null): Record<string, string> | null {
  const headers = state?.player?.source?.headers;
  return isRecord(headers)
    ? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : null;
}

async function probeWindow(
  options: PackagedE2eOptions,
  html: string,
): Promise<{ hasVideo: boolean; readyState: number; src: string; hlsLoaded: boolean } | null> {
  if (!options.reloadWindow || !options.evaluateWindow) return null;
  await options.reloadWindow();
  const value = await options.evaluateWindow(`(() => new Promise((resolve) => {
    window.setTimeout(() => {
      const video = document.querySelector('[data-testid="embedded-player"]');
      resolve({
        hasVideo: Boolean(video),
        readyState: video ? video.readyState : 0,
        src: video ? (video.currentSrc || video.src || '') : '',
        hlsLoaded: Boolean(window.Hls),
      });
    }, 500);
  }))()`);
  if (!isRecord(value)
    || typeof value.hasVideo !== "boolean"
    || typeof value.readyState !== "number"
    || typeof value.src !== "string"
    || typeof value.hlsLoaded !== "boolean") {
    throw new Error(`Packaged playback probe returned an invalid result: ${html.length}`);
  }
  return value as { hasVideo: boolean; readyState: number; src: string; hlsLoaded: boolean };
}

async function probePlaybackDebug(options: PackagedE2eOptions): Promise<boolean> {
  if (!options.evaluateWindow) return false;
  const value = await options.evaluateWindow(`(() => new Promise((resolve) => {
    const wait = () => window.setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
      window.setTimeout(() => {
        const panel = document.querySelector('[data-testid="playback-debug-panel"]');
        const fields = [...document.querySelectorAll('[data-debug-field]')].map((node) => node.getAttribute('data-debug-field'));
        const text = panel?.textContent || '';
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
        const input = document.querySelector('#search-key');
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
        window.setTimeout(() => resolve({
          opened: Boolean(panel),
          fieldCount: fields.length,
          hasTimeline: Boolean(panel?.querySelector('[data-testid="playback-debug-timeline"]')),
          inputDidNotOpen: !document.querySelector('[data-testid="playback-debug-panel"]'),
          redacted: !/token|cookie|authorization|private\\.example|127\\.0\\.0\\.1|Users\\\\/i.test(text),
        }), 25);
      }, 25);
    }, 25);
    wait();
  }))()`);
  return isRecord(value)
    && value.opened === true
    && value.fieldCount === 17
    && value.hasTimeline === true
    && value.inputDidNotOpen === true
    && value.redacted === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
