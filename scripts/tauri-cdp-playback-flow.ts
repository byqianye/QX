export function watchPlaybackActivationExpression(click: boolean): string {
  return `(() => {
    if (document.querySelector('[data-testid="embedded-player"]')) return 'player-ready';
    if (document.querySelector('#vue-renderer')?.getAttribute('data-pending')) return false;
    const button = document.querySelector('[data-action="core-watch-play"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    ${click ? "button.click(); return 'watch-start-clicked';" : "return 'watch-ready';"}
  })()`;
}

export function homeObservationExpression(allowEmpty: boolean): string {
  return `(() => {
    const page = document.querySelector('[data-testid="core-app-shell"][data-route="home"] [data-testid="core-browse-page"][data-route="home"]');
    if (!page) return false;
    const cards = [...page.querySelectorAll('[data-testid="vod-card"]')];
    if (cards.length === 0) return ${allowEmpty
      ? `JSON.stringify({
          homeCardCount: 0,
          homeFirstTitle: null,
          homePosterLoaded: false,
          homePosterNaturalWidth: 0,
          homePosterNaturalHeight: 0,
        })`
      : "false"};
    const visibleCards = cards.filter((candidate) => candidate instanceof HTMLElement && candidate.getClientRects().length > 0);
    const candidates = visibleCards.length > 0 ? visibleCards : cards;
    const title = candidates
      .map((candidate) => candidate.querySelector('h3')?.textContent?.trim() ?? '')
      .find(Boolean) ?? '';
    const poster = candidates
      .map((candidate) => candidate.querySelector('[data-testid="vod-poster"]'))
      .find((candidate) => candidate instanceof HTMLImageElement
        && candidate.complete
        && candidate.naturalWidth > 0
        && candidate.naturalHeight > 0);
    if (!title
      || !(poster instanceof HTMLImageElement)
      || !poster.complete) return false;
    return JSON.stringify({
      homeCardCount: cards.length,
      homeFirstTitle: title,
      homePosterLoaded: true,
      homePosterNaturalWidth: poster.naturalWidth,
      homePosterNaturalHeight: poster.naturalHeight,
    });
  })()`;
}

export function playbackProxyObservationExpression(): string {
  return `(() => {
    const trace = window.__TAURI_INTERNALS__?.__qxInvokeTrace;
    if (Array.isArray(trace)) {
      const entry = [...trace].reverse().find((candidate) => candidate?.command === 'backend_playback_start'
        && candidate?.status === 'resolved');
      const value = entry?.value;
      const response = value?.payload ?? value;
      const playerSource = response?.playerSource ?? response?.payload?.playerSource;
      if (typeof playerSource?.url === 'string' && playerSource.url.includes('/__qx_playback/')) return true;
    }
    const video = document.querySelector('[data-testid="embedded-player"]');
    if (video instanceof HTMLVideoElement
      && [video.currentSrc, video.src].some((url) => url.includes('/__qx_playback/'))) return true;
    return performance.getEntriesByType('resource')
      .some((entry) => typeof entry.name === 'string' && entry.name.includes('/__qx_playback/'));
  })()`;
}

interface PlaybackNavigationInput {
  detailId?: string | undefined;
  homeTitle?: string | undefined;
  searchKey: string;
}

export function playbackNavigationEvidence({
  detailId,
  homeTitle,
  searchKey,
}: PlaybackNavigationInput) {
  const navigationMode = detailId ? "direct-detail" : homeTitle ? "home-card" : "search";
  return {
    navigationMode,
    detailId: detailId ?? null,
    homeTitle: homeTitle ?? null,
    searchKey: navigationMode === "search" ? searchKey : null,
    nativeSearchAndDetail: navigationMode === "search",
  };
}
