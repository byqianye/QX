import type { SniffedMedia } from "./isolated-sniffer.js";

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
  readWindowHtml?: () => Promise<string>;
  verifyPlaybackRules?: boolean;
  verifyPlaybackDebug?: boolean;
  verifySubtitleTracks?: boolean;
  verifyPlaybackHealth?: boolean;
  verifyPlaybackFallback?: boolean;
  verifyHistory?: boolean;
  verifyFavorites?: boolean;
  verifyFollow?: boolean;
  verifyCache?: boolean;
  verifyStorage?: boolean;
  verifyLiveSources?: boolean;
  liveUrl?: string;
  verifyLivePlayback?: boolean;
  livePlaybackUrl?: string;
  verifySmartChannels?: boolean;
  smartBackupUrl?: string;
  verifyEpg?: boolean;
  epgUrl?: string;
  verifyEpgMatching?: boolean;
  expectedFavoriteId?: string;
  expectedFollowIdentity?: string;
  verifyParserFallback?: boolean;
  verifySniffFallback?: boolean;
  verifyAggregateSearch?: boolean;
  verifyFakeMpv?: boolean;
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
  playbackHealth?: boolean;
  playbackFallback?: boolean;
  parserFallback?: boolean;
  sniffFallback?: boolean;
  fakeMpvExit?: boolean;
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
  liveSources?: boolean;
  liveRestart?: boolean;
  liveSourceDisable?: boolean;
  livePlayback?: boolean;
  liveProxy?: boolean;
  liveLineSwitch?: boolean;
  livePlaybackRestart?: boolean;
  liveRecent?: boolean;
  smartChannels?: boolean;
  smartRestart?: boolean;
  epgImport?: boolean;
  epgRestart?: boolean;
  epgRefresh?: boolean;
  epgMapping?: boolean;
  epgMappingRestart?: boolean;
  epgTimeline?: boolean;
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
}

export async function runPackagedE2e(options: PackagedE2eOptions): Promise<PackagedE2eResult> {
  const checks = emptyChecks();
  let searchVodId: string | null = null;
  let detailVodId: string | null = null;
  let favoriteId: string | null = null;
  let followIdentity: string | null = null;
  let sidecarPid: number | null = null;

  try {
    const initialHtml = await readPage(options);
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
    if (options.verifyLiveSources) {
      if (!options.liveUrl) throw new Error("Packaged live source E2E URL is not configured");
      const beforeLive = await getState(options.baseUrl);
      if (!options.freshTrust) {
        checks.liveRestart = (beforeLive.state?.live?.sources ?? []).some((source) => source.channelCount > 0)
          && (beforeLive.state?.live?.sources ?? []).some((source) => source.enabled === false);
      }
      const remotePreview = await post(options.baseUrl, "/api/live/source/preview", {
        name: "Packaged E2E 直播源",
        type: "m3u-url",
        location: options.liveUrl,
      });
      const remotePreviewState = remotePreview.state?.live?.preview;
      const remoteApplied = remotePreviewState
        ? await post(options.baseUrl, "/api/live/source/apply", { previewId: remotePreviewState.id })
        : null;
      const remoteSource = remoteApplied?.state?.live?.sources.find((source) => source.name === "Packaged E2E 直播源" && source.enabled);
      const refreshed = remoteSource
        ? await post(options.baseUrl, "/api/live/source/refresh", { sourceId: remoteSource.id })
        : null;
      const filePreview = await post(options.baseUrl, "/api/live/source/preview", {
        name: "Packaged E2E 文件源",
        type: "m3u-file",
        fileName: "e2e.m3u",
        content: "#EXTM3U\n#EXTINF:-1 group-title=\"E2E\",E2E 文件频道\nhttps://media.example.invalid/e2e.m3u8\n",
      });
      const filePreviewState = filePreview.state?.live?.preview;
      const fileApplied = filePreviewState
        ? await post(options.baseUrl, "/api/live/source/apply", { previewId: filePreviewState.id })
        : null;
      const disabled = remoteSource
        ? await post(options.baseUrl, "/api/live/source/toggle", { sourceId: remoteSource.id, enabled: false })
        : null;
      checks.liveSources = remotePreviewState?.stats.channelCount === 2
        && remoteApplied?.state?.live?.sources.some((source) => source.name === "Packaged E2E 直播源" && source.channelCount === 2) === true
        && refreshed?.state?.live?.sources.some((source) => source.name === "Packaged E2E 直播源" && source.lastError === null) === true
        && filePreviewState?.stats.channelCount === 1
        && fileApplied?.state?.live?.sources.some((source) => source.name === "Packaged E2E 文件源" && source.channelCount === 1) === true;
      checks.liveSourceDisable = disabled?.state?.live?.sources.some((source) => source.name === "Packaged E2E 直播源" && source.enabled === false) === true;
    }
    if (options.verifyLivePlayback) {
      if (!options.livePlaybackUrl) throw new Error("Packaged live playback E2E URL is not configured");
      const beforePlayback = await getState(options.baseUrl);
      if (!options.freshTrust) {
        checks.livePlaybackRestart = (beforePlayback.state?.live?.catalog?.recent ?? []).some(
          (recent) => recent.channelName === "Fixture Channel B" || recent.channelName === "Fixture Channel E",
        );
      }
      const playbackPreview = await post(options.baseUrl, "/api/live/source/preview", {
        name: "Packaged G57 Live",
        type: "m3u-url",
        location: options.livePlaybackUrl,
      });
      const playbackPreviewState = playbackPreview.state?.live?.preview;
      const playbackApplied = playbackPreviewState
        ? await post(options.baseUrl, "/api/live/source/apply", { previewId: playbackPreviewState.id })
        : null;
      const playbackSource = playbackApplied?.state?.live?.sources.find((source) => source.name === "Packaged G57 Live");
      const catalogChannels = playbackApplied?.state?.live?.catalog?.channels ?? [];
      const channelB = catalogChannels.find((channel) => channel.name === "Fixture Channel B");
      const channelE = catalogChannels.find((channel) => channel.name === "Fixture Channel E");
      const playedB = channelB
        ? await post(options.baseUrl, "/api/live/play", { channelId: channelB.id })
        : null;
      const protectedUrl = livePlayerSourceUrl(playedB?.state ?? null);
      const protectedResponse = protectedUrl ? await fetch(protectedUrl) : null;
      const protectedBody = protectedResponse ? await protectedResponse.text() : "";
      checks.liveProxy = playedB?.state?.live?.session?.channelId === channelB?.id
        && playedB?.state?.live?.session?.backend === "hls-js"
        && protectedUrl?.includes("/__qx_playback/") === true
        && protectedResponse?.ok === true
        && protectedBody.includes("#EXTM3U")
        && Object.keys(livePlayerSourceHeaders(playedB?.state ?? null) ?? {}).length === 0;

      const selectedE = channelE
        ? await post(options.baseUrl, "/api/live/play", { channelId: channelE.id })
        : null;
      const line = channelE?.streams[1];
      const switchedE = line
        ? await post(options.baseUrl, "/api/live/line", { streamId: line.id })
        : null;
      checks.liveLineSwitch = selectedE?.state?.live?.session?.channelId === channelE?.id
        && channelE?.streams.length === 2
        && switchedE?.state?.live?.session?.channelId === channelE?.id
        && switchedE?.state?.live?.session?.streamId === line?.id;
      const recent = switchedE?.state?.live?.catalog?.recent ?? [];
      checks.liveRecent = recent.some((item) => item.channelName === "Fixture Channel E" && item.lastStreamId === line?.id);
      checks.livePlayback = playbackPreviewState?.stats.channelCount === 5
        && playbackApplied?.state?.live?.sources.some((source) => source.name === "Packaged G57 Live" && source.channelCount === 5) === true
        && playbackSource?.enabled === true;
      await post(options.baseUrl, "/api/live/stop");
    }
    if (options.verifyEpg) {
      if (!options.epgUrl) throw new Error("Packaged EPG E2E URL is not configured");
      const beforeEpg = await getState(options.baseUrl);
      const existingEpg = beforeEpg.state?.live?.epg?.sources.find((source) => source.name === "Packaged G58 EPG");
      if (!options.freshTrust) {
        checks.epgRestart = existingEpg?.enabled === true
          && existingEpg.channelCount === 2
          && existingEpg.programmeCount === 3
          && existingEpg.lastError === null;
        checks.epgMappingRestart = (beforeEpg.state?.live?.epg?.mappings ?? []).some((mapping) =>
          (mapping.liveChannelName === "Fixture Channel A" || mapping.liveChannelName === "Fixture Channel E")
          && mapping.mapping?.userConfirmed === true,
        );
      }
      const epgPreview = await post(options.baseUrl, "/api/epg/source/preview", {
        name: "Packaged G58 EPG",
        type: "xmltv-url",
        location: options.epgUrl,
        ...(existingEpg ? { sourceId: existingEpg.id } : {}),
      });
      const epgPreviewState = epgPreview.state?.live?.epg?.preview;
      const epgApplied = epgPreviewState
        ? await post(options.baseUrl, "/api/epg/source/apply", { previewId: epgPreviewState.id })
        : null;
      const epgSource = epgApplied?.state?.live?.epg?.sources.find((source) => source.name === "Packaged G58 EPG");
      const epgRefreshed = epgSource
        ? await post(options.baseUrl, "/api/epg/source/refresh", { sourceId: epgSource.id })
        : null;
      const refreshedEpgSource = epgRefreshed?.state?.live?.epg?.sources.find((source) => source.name === "Packaged G58 EPG");
      checks.epgImport = epgPreviewState?.stats.channelCount === 2
        && epgPreviewState.stats.programmeCount === 3
        && epgPreviewState.stats.invalidCount === 0
        && epgSource?.enabled === true
        && epgSource.channelCount === 2
        && epgSource.programmeCount === 3
        && epgSource.lastError === null;
      checks.epgRefresh = refreshedEpgSource?.channelCount === 2
        && refreshedEpgSource.programmeCount === 3
        && refreshedEpgSource.lastError === null;
      if (options.verifyEpgMatching) {
        const epgState = epgRefreshed?.state ?? epgApplied?.state;
        const catalogChannels = epgState?.live?.catalog?.channels ?? [];
        const channelA = catalogChannels.find((channel) => channel.name === "Fixture Channel A");
        const channelE = catalogChannels.find((channel) => channel.name === "Fixture Channel E");
        const mappingA = epgState?.live?.epg?.mappings.find((mapping) => mapping.liveChannelName === "Fixture Channel A");
        const candidateA = mappingA?.candidates.find((candidate) => candidate.method === "tvg-id");
        const manuallyConfirmed = channelA && candidateA
          ? await post(options.baseUrl, "/api/epg/mapping/set", {
              liveChannelId: channelA.id,
              epgSourceId: candidateA.epgSourceId,
              epgChannelId: candidateA.epgChannelId,
            })
          : null;
        const highConfidenceConfirmed = await post(options.baseUrl, "/api/epg/mapping/confirm-high");
        const confirmedMappings = highConfidenceConfirmed.state?.live?.epg?.mappings
          ?? manuallyConfirmed?.state?.live?.epg?.mappings
          ?? [];
        const confirmedA = confirmedMappings.find((mapping) => mapping.liveChannelName === "Fixture Channel A");
        const confirmedE = confirmedMappings.find((mapping) => mapping.liveChannelName === "Fixture Channel E");
        checks.epgMapping = channelA?.epgStatus === "mapped"
          && channelE?.epgStatus === "mapped"
          && confirmedA?.mapping?.userConfirmed === true
          && confirmedA.mapping.method === "explicit"
          && confirmedE?.mapping?.userConfirmed === true;

        const timelineResponse = channelA
          ? await post(options.baseUrl, "/api/epg/timeline", {
              liveChannelId: channelA.id,
              fromAt: Date.UTC(2026, 7, 7, 11),
              toAt: Date.UTC(2026, 7, 7, 14),
            })
          : null;
        const timeline = timelineResponse?.state?.live?.epg?.timeline;
        checks.epgTimeline = timeline !== null
          && timeline !== undefined
          && timeline.liveChannelId === channelA?.id
          && timeline.items.map((item) => item.title).join("|") === "Fixture News Current|Fixture News Next"
          && timeline.toAt - timeline.fromAt === 3 * 60 * 60 * 1000;
      }
    }
    if (options.verifySmartChannels) {
      if (!options.smartBackupUrl) throw new Error("Packaged Smart Channel E2E URL is not configured");
      const beforeSmart = await getState(options.baseUrl);
      const existingSmart = beforeSmart.state?.live?.smartChannels?.find((channel) => channel.name === "Packaged G60 Smart Renamed");
      if (!options.freshTrust) {
        checks.smartRestart = existingSmart?.members.length === 1
          && existingSmart.available === true
          && existingSmart.epg.mode === "explicit";
        checks.smartChannels = checks.smartRestart;
      } else {
        const backupPreview = await post(options.baseUrl, "/api/live/source/preview", {
          name: "Packaged G60 Backup",
          type: "m3u-url",
          location: options.smartBackupUrl,
        });
        const backupPreviewState = backupPreview.state?.live?.preview;
        const backupApplied = backupPreviewState
          ? await post(options.baseUrl, "/api/live/source/apply", { previewId: backupPreviewState.id })
          : null;
        const backupSource = backupApplied?.state?.live?.sources.find((source) => source.name === "Packaged G60 Backup");
        const smartCatalog = backupApplied?.state?.live?.catalog?.channels ?? [];
        const primaryChannel = smartCatalog.find((channel) => channel.name === "Fixture Channel A" && channel.sourceName === "Packaged G57 Live");
        const backupChannel = smartCatalog.find((channel) => channel.name === "Fixture Channel A" && channel.sourceName === "Packaged G60 Backup");
        const suggestionState = backupApplied?.state?.live?.smartSuggestions ?? [];
        const created = primaryChannel
          ? await post(options.baseUrl, "/api/live/smart/create", {
              name: "Packaged G60 Smart",
              group: "Packaged",
              memberIds: [primaryChannel.id],
            })
          : null;
        const createdSmart = created?.state?.live?.smartChannels?.find((channel) => channel.name === "Packaged G60 Smart");
        const smartId = createdSmart?.id;
        const primaryMember = createdSmart?.members.find((member) => member.liveChannelId === primaryChannel?.id);
        const added = smartId && backupChannel
          ? await post(options.baseUrl, "/api/live/smart/member/add", {
              smartChannelId: smartId,
              liveChannelId: backupChannel.id,
              priority: 1,
            })
          : null;
        const addedSmart = added?.state?.live?.smartChannels?.find((channel) => channel.id === smartId);
        if (smartId && primaryChannel && backupChannel) {
          await post(options.baseUrl, "/api/live/smart/member/health", { liveChannelId: primaryChannel.id, score: 10 });
          await post(options.baseUrl, "/api/live/smart/member/health", { liveChannelId: backupChannel.id, score: 95 });
        }
        const defaultPlay = smartId
          ? await post(options.baseUrl, "/api/live/smart/play", { smartChannelId: smartId })
          : null;
        const manualPlay = smartId && primaryMember
          ? await post(options.baseUrl, "/api/live/smart/play", { smartChannelId: smartId, memberId: primaryMember.id })
          : null;
        const primaryMapping = manualPlay?.state?.live?.epg?.mappings?.find((mapping) => mapping.liveChannelId === primaryChannel?.id)?.mapping;
        const epgSet = smartId && primaryMapping
          ? await post(options.baseUrl, "/api/live/smart/epg", {
              smartChannelId: smartId,
              epgSourceId: primaryMapping.epgSourceId,
              epgChannelId: primaryMapping.epgChannelId,
            })
          : null;
        const renamed = smartId
          ? await post(options.baseUrl, "/api/live/smart/update", { smartChannelId: smartId, name: "Packaged G60 Smart Renamed" })
          : null;
        const disabledBackup = backupSource
          ? await post(options.baseUrl, "/api/live/source/toggle", { sourceId: backupSource.id, enabled: false })
          : null;
        const fallbackPlay = smartId
          ? await post(options.baseUrl, "/api/live/smart/play", { smartChannelId: smartId })
          : null;
        const removedBackup = backupSource
          ? await post(options.baseUrl, "/api/live/source/remove", { sourceId: backupSource.id })
          : null;
        const finalSmart = removedBackup?.state?.live?.smartChannels?.find((channel) => channel.id === smartId);
        checks.smartChannels = backupPreviewState?.stats.channelCount === 2
          && suggestionState.some((suggestion) => suggestion.reason === "exact-tvg-id")
          && createdSmart?.members.length === 1
          && addedSmart?.members.length === 2
          && defaultPlay?.state?.live?.activeSmartChannel?.liveChannelId === backupChannel?.id
          && defaultPlay?.state?.live?.session?.channelId === backupChannel?.id
          && manualPlay?.state?.live?.activeSmartChannel?.liveChannelId === primaryChannel?.id
          && epgSet?.state?.live?.smartChannels?.find((channel) => channel.id === smartId)?.epg.mode === "explicit"
          && renamed?.state?.live?.smartChannels?.find((channel) => channel.id === smartId)?.name === "Packaged G60 Smart Renamed"
          && disabledBackup?.state?.live?.smartChannels?.find((channel) => channel.id === smartId)?.available === true
          && fallbackPlay?.state?.live?.activeSmartChannel?.liveChannelId === primaryChannel?.id
          && finalSmart?.members.length === 1
          && finalSmart.available === true;
      }
    }
    const opened = await post(options.baseUrl, "/api/open");
    const search = await post(options.baseUrl, "/api/search", {
      key: "蜘蛛侠",
      quick: false,
      page: 1,
    });
    searchVodId = firstVodId(search.state);
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

    if (options.playback) {
      const playbackImport = await load(options.baseUrl, options.playback.configJson);
      const playbackReady = await confirmIfNeeded(options.baseUrl, playbackImport.import.status);
      const playbackOpened = await post(options.baseUrl, "/api/open");
      const playbackHome = await post(options.baseUrl, "/api/home");
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
      const hlsDom = await probeWindow(options, hlsHtml);
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
        && playerSourceUrl(mp4.state)?.endsWith("/media/fixture.mp4") === true
        && mp4Html.includes('data-testid="embedded-player"');
      checks.embeddedHls = hls.state?.player?.status === "loading"
        && playerSourceUrl(hls.state)?.endsWith("/media/fixture.m3u8") === true
        && hlsHtml.includes('data-testid="embedded-player"')
        && (hlsHtml.includes("/assets/hls.min.js") || hlsDom?.hlsLoaded === true);
      checks.parseChain = parsed.state?.player?.status === "loading"
        && parsed.state?.error === null
        && parsed.state?.player?.error === null
        && parsed.state?.player?.source?.parse === 0
        && playerSourceUrl(parsed.state)?.endsWith("/media/fixture.m3u8") === true;
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
          && mp4Dom.src.endsWith("/media/fixture.mp4");
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
          && playerSourceUrl(fallback.state)?.endsWith("/media/fixture.m3u8") === true;
      }
    }

    const repeated = await load(options.baseUrl, options.configJson);
    checks.trustedReimport = repeated.import.status === "ready" && repeated.import.trusted;
    if (options.startAgain) {
      const startedAgain = await options.startAgain();
      checks.repeatedStart = startedAgain.url === options.baseUrl;
    } else {
      checks.repeatedStart = false;
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
      error: errorMessage(error),
    };
  }
}

async function page(baseUrl: string): Promise<string> {
  const response = await fetch(new URL("/", baseUrl));
  return response.text();
}

async function readPage(options: PackagedE2eOptions): Promise<string> {
  return options.readWindowHtml ? options.readWindowHtml() : page(options.baseUrl);
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
    throw new Error(`Packaged E2E request failed: ${path}`);
  }
  return {
    import: value.import as unknown as ImportState,
    state: isRecord(value.state) ? value.state as unknown as UiState : null,
  };
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
    && value.byType.length >= 11
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
}

interface ImportState {
  status: string;
  trusted: boolean;
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
    items: readonly { position: number; duration: number }[];
    paused: boolean;
  };
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
  live?: {
    sources: readonly {
      id: string;
      name: string;
      enabled: boolean;
      channelCount: number;
      groupCount: number;
      streamCount: number;
      lastError: string | null;
    }[];
    preview: {
      id: string;
      channelNames: readonly string[];
      stats: {
        channelCount: number;
        groupCount: number;
        streamCount: number;
        invalidCount: number;
      };
    } | null;
    loading: boolean;
    error: { code: string; message: string } | null;
    catalog?: {
      groups: readonly { id: string; name: string; channelCount: number }[];
      channels: readonly {
        id: string;
        sourceId: string;
        sourceName: string;
        name: string;
        group: string | null;
        streamCount: number;
        epgStatus: string;
        currentProgramme: { title: string } | null;
        nextProgramme: { title: string } | null;
        streams: readonly { id: string; label: string; protocol: string; status: string }[];
      }[];
      recent: readonly { channelId: string; sourceId: string; channelName: string; lastStreamId: string | null }[];
    };
    session?: {
      sessionId: string;
      channelId: string;
      streamId: string;
      state: string;
      backend: string;
    } | null;
    player?: {
      source?: {
        url?: string;
        headers?: Record<string, unknown>;
      } | null;
    } | null;
    epg?: {
      sources: readonly {
        id: string;
        name: string;
        enabled: boolean;
        channelCount: number;
        programmeCount: number;
        lastError: string | null;
      }[];
      preview: {
        id: string;
        stats: {
          channelCount: number;
          programmeCount: number;
          invalidCount: number;
        };
      } | null;
      mappings: readonly {
        liveChannelId: string;
        liveChannelName: string;
        status: string;
        mapping: {
          epgSourceId: string;
          epgChannelId: string;
          method: string;
          confidence: string;
          userConfirmed: boolean;
        } | null;
        candidates: readonly {
          epgSourceId: string;
          epgChannelId: string;
          method: string;
        }[];
      }[];
      timeline: {
        liveChannelId: string;
        fromAt: number;
        toAt: number;
        items: readonly { title: string }[];
      } | null;
    };
    smartChannels?: readonly {
      id: string;
      name: string;
      available: boolean;
      epg: { mode: string };
      members: readonly { id: string; liveChannelId: string; priority: number }[];
    }[];
    smartSuggestions?: readonly { reason: string }[];
    activeSmartChannel?: { smartChannelId: string; memberId: string; liveChannelId: string } | null;
  };
}

function playerSourceUrl(state: UiState | null): string | null {
  const source = state?.player?.source;
  return typeof source?.url === "string" ? source.url : null;
}

function playerSourceHeaders(state: UiState | null): Record<string, string> | null {
  const headers = state?.player?.source?.headers;
  return isRecord(headers)
    ? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : null;
}

function livePlayerSourceUrl(state: UiState | null): string | null {
  const source = state?.live?.player?.source;
  return typeof source?.url === "string" ? source.url : null;
}

function livePlayerSourceHeaders(state: UiState | null): Record<string, string> | null {
  const headers = state?.live?.player?.source?.headers;
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
