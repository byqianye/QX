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
  proxyRequired?: boolean;
  noExternalBrowser?: boolean;
  embeddedMp4Dom?: boolean;
  embeddedHlsDom?: boolean;
  proxyHlsDom?: boolean;
}

export interface PackagedE2eResult {
  status: "passed" | "failed";
  checks: PackagedE2eChecks;
  searchVodId: string | null;
  detailVodId: string | null;
  sidecarPid: number | null;
  error?: string;
}

export async function runPackagedE2e(options: PackagedE2eOptions): Promise<PackagedE2eResult> {
  const checks = emptyChecks();
  let searchVodId: string | null = null;
  let detailVodId: string | null = null;
  let sidecarPid: number | null = null;

  try {
    const initial = await fetch(new URL("/", options.baseUrl));
    const initialHtml = await initial.text();
    checks.initialImportForm = initial.ok
      && initialHtml.includes('data-testid="config-import-form"');

    const firstUrl = await load(options.baseUrl, options.configUrl);
    const warningHtml = await page(options.baseUrl);
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
    const search = await post(options.baseUrl, "/api/search", {
      key: "蜘蛛侠",
      quick: false,
      page: 1,
    });
    searchVodId = firstVodId(search.state);
    const detail = await post(options.baseUrl, "/api/detail", { vodId: searchVodId });
    detailVodId = stringField(detail.state?.detail?.vod_id);
    const doubanPlayback = await post(options.baseUrl, "/api/player", {
      flag: "default",
      id: searchVodId,
    });
    const closed = await post(options.baseUrl, "/api/import/cancel");
    checks.searchDetail = jsonReady
      && opened.state?.status === "ready"
      && /^msearch:\d+$/.test(searchVodId)
      && detail.state?.page === "detail"
      && detailVodId === searchVodId;
    checks.jsonImport = jsonReady && closed.import.status === "cancelled";
    checks.doubanUnavailable = doubanPlayback.state?.error?.code === "PLAYBACK_UNAVAILABLE";

    if (options.playback) {
      const playbackImport = await load(options.baseUrl, options.playback.configJson);
      const playbackReady = await confirmIfNeeded(options.baseUrl, playbackImport.import.status);
      const playbackOpened = await post(options.baseUrl, "/api/open");
      const mp4 = await post(options.baseUrl, "/api/player", {
        flag: "default",
        id: "direct-mp4",
      });
      const mp4Html = await page(options.baseUrl);
      const mp4Dom = await probeWindow(options, mp4Html);
      const hls = await post(options.baseUrl, "/api/player", {
        flag: "default",
        id: "direct-hls",
      });
      const hlsHtml = await page(options.baseUrl);
      const hlsDom = await probeWindow(options, hlsHtml);
      const headered = await post(options.baseUrl, "/api/player", {
        flag: "default",
        id: "headered",
      });
      const headeredHtml = await page(options.baseUrl);
      const headeredDom = await probeWindow(options, headeredHtml);
      checks.embeddedMp4 = playbackReady
        && playbackOpened.state?.status === "ready"
        && mp4.state?.player?.status === "loading"
        && playerSourceUrl(mp4.state) !== null
        && playerSourceUrl(mp4.state)?.endsWith("/media/fixture.mp4") === true
        && mp4Html.includes('data-testid="embedded-player"');
      checks.embeddedHls = hls.state?.player?.status === "loading"
        && playerSourceUrl(hls.state)?.endsWith("/media/fixture.m3u8") === true
        && hlsHtml.includes('data-testid="embedded-player"')
        && hlsHtml.includes("/assets/hls.min.js");
      checks.proxyRequired = headered.state?.error?.code === "PLAYBACK_PROXY_REQUIRED"
        ? false
        : headered.state?.player?.status === "loading"
          && playerSourceUrl(headered.state)?.includes("/__qx_playback/") === true
          && playerSourceHeaders(headered.state) !== null
          && Object.keys(playerSourceHeaders(headered.state) ?? {}).length === 0
          && headeredHtml.includes('data-testid="embedded-player"');
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

    return {
      status: Object.values(checks).every(Boolean) ? "passed" : "failed",
      checks,
      searchVodId,
      detailVodId,
      sidecarPid,
    };
  } catch (error) {
    return {
      status: "failed",
      checks,
      searchVodId,
      detailVodId,
      sidecarPid,
      error: errorMessage(error),
    };
  }
}

async function page(baseUrl: string): Promise<string> {
  const response = await fetch(new URL("/", baseUrl));
  return response.text();
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

function firstVodId(state: UiState | null): string {
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
    source?: { url?: string; headers?: Record<string, unknown> } | null;
    error?: { code?: string; message?: string } | null;
  } | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
