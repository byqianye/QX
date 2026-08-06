const API_KEY = "0ac44ae016490db2204ce0a042db2916";
const DETAIL_TIMEOUT_MS = 15_000;
const DETAIL_REFERER =
  "https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html";
const DETAIL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36 " +
  "MicroMessenger/7.0.9.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat";
const DETAIL_BASE_URL = "https://frodo.douban.com/api/v2";

export async function runDoubanPlayerProbe() {
  const movieId = process.env.QX_DOUBAN_MOVIE_ID ?? "36246195";
  const tvId = process.env.QX_DOUBAN_TV_ID ?? "36721173";
  const results = await Promise.all([
    probePlayback("movie", movieId),
    probePlayback("tv", tvId),
  ]);
  const passed = results.every((result) => result.status === "passed");

  return {
    probe: "douban-player-feasibility",
    status: passed ? ("passed" as const) : ("failed" as const),
    request: {
      baseUrl: DETAIL_BASE_URL,
      timeoutMs: DETAIL_TIMEOUT_MS,
    },
    dex: {
      playerContentOverride: false,
      source: "Spike 7 JADX method inspection",
    },
    results,
    decision: {
      fullContent: "The tested movie/TV details do not expose a direct full-content HTTP stream",
      trailer: "trailers[].video_url is a direct HTTP MP4 asset and is technically playable as a trailer",
      tvVendor: "TV vendors/linewatches expose app deep links, not desktop-resolvable stream URLs",
      next: "Do not add a general JVM playerContent RPC yet; only revisit if trailer playback or a source-specific resolver is explicitly required",
    },
  };
}

async function probePlayback(kind: "movie" | "tv", id: string): Promise<Record<string, unknown>> {
  const url = `${DETAIL_BASE_URL}/${kind}/${encodeURIComponent(id)}?apikey=${API_KEY}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Referer: DETAIL_REFERER,
        "User-Agent": DETAIL_USER_AGENT,
      },
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    const body = await response.text();
    const value = parseRecord(body);
    if (!response.ok || !value) {
      return {
        kind,
        id,
        status: "failed",
        httpStatus: response.status,
      };
    }

    const trailers = arrayOfRecords(value.trailers);
    const vendors = arrayOfRecords(value.vendors);
    const linewatches = arrayOfRecords(value.linewatches);
    const directTrailerUrls = trailers
      .map((trailer) => stringValue(trailer.video_url))
      .filter(isHttpUrl);
    const vendorUris = vendors
      .map((vendor) => stringValue(vendor.uri))
      .filter(Boolean);
    const linewatchUris = linewatches
      .map((linewatch) => stringValue(linewatch.source_uri ?? linewatch.url))
      .filter(Boolean);
    const directFullContentUrls = collectFullContentUrls(value);

    return {
      kind,
      id,
      status: "passed",
      httpStatus: response.status,
      title: stringValue(value.title),
      videoField: value.video === null ? "null" : typeof value.video,
      trailerCount: trailers.length,
      directTrailerCount: directTrailerUrls.length,
      directTrailerHosts: uniqueHosts(directTrailerUrls),
      vendorCount: vendors.length,
      vendorUris,
      linewatchCount: linewatches.length,
      linewatchUris,
      directFullContentHosts: uniqueHosts(directFullContentUrls),
      hasDirectFullContentUrl: directFullContentUrls.length > 0,
    };
  } catch (error) {
    return {
      kind,
      id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseRecord(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

function uniqueHosts(urls: string[]): string[] {
  return [...new Set(urls.flatMap((url) => {
    try {
      return [new URL(url).host];
    } catch {
      return [];
    }
  }))];
}

function collectFullContentUrls(
  value: unknown,
  path = "",
  playContext = false,
  trailerContext = false,
): string[] {
  if (typeof value === "string") {
    return !trailerContext && playContext && isHttpUrl(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectFullContentUrls(item, `${path}[${index}]`, playContext, trailerContext));
  }
  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => {
    const nextPath = path ? `${path}.${key}` : key;
    const nextPlayContext = playContext || /^(video|play|stream|m3u8|mp4)(_|$)/i.test(key);
    const nextTrailerContext = trailerContext || /(^|\.)trailers?(\.|$)/i.test(nextPath);
    return collectFullContentUrls(child, nextPath, nextPlayContext, nextTrailerContext);
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith("douban-player-probe.ts")) {
  runDoubanPlayerProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
