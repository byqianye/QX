const API_KEY = "0ac44ae016490db2204ce0a042db2916";
const DETAIL_TIMEOUT_MS = 15_000;
const DETAIL_REFERER =
  "https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html";
const DETAIL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36 " +
  "MicroMessenger/7.0.9.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat";

const baseUrl = "https://frodo.douban.com/api/v2";

export async function runDoubanDetailProbe() {
  const movieId = process.env.QX_DOUBAN_MOVIE_ID ?? "36246195";
  const tvId = process.env.QX_DOUBAN_TV_ID ?? "36721173";

  const current = await Promise.all([
    probeDetail(
      "movie",
      movieId,
      withApiKey(`${baseUrl}/movie/${encodeURIComponent(movieId)}`),
    ),
    probeDetail(
      "tv",
      tvId,
      withApiKey(`${baseUrl}/tv/${encodeURIComponent(tvId)}`),
    ),
  ]);

  const compatibility = await Promise.all([
    probeCompatibility(
      "frodo-subject-path",
      withApiKey(`${baseUrl}/movie/subject/${encodeURIComponent(movieId)}`),
    ),
    probeCompatibility(
      "legacy-api-v2",
      withApiKey(`https://api.douban.com/v2/movie/subject/${encodeURIComponent(movieId)}`),
    ),
  ]);

  const passed = current.every((result) => result.status === "passed");
  return {
    probe: "douban-detail-api",
    status: passed ? ("passed" as const) : ("failed" as const),
    request: {
      baseUrl,
      referer: DETAIL_REFERER,
      userAgent: DETAIL_USER_AGENT,
      timeoutMs: DETAIL_TIMEOUT_MS,
    },
    current,
    compatibility,
    decision: {
      endpoint: "Frodo /api/v2/{movie|tv}/{id} is usable for the tested IDs",
      legacy: "legacy subject paths are not the working path observed here",
      fields:
        "id/title/cover_url/rating/genres/intro/directors/actors/year/pubdate are present; TV also exposes episodes_count and episodes_info",
    },
  };
}

async function probeDetail(
  kind: "movie" | "tv",
  id: string,
  url: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    const body = await response.text();
    const parsed = parseJsonObject(body);
    if (!response.ok || !parsed) {
      return {
        kind,
        id,
        url,
        status: "failed",
        httpStatus: response.status,
        keys: parsed ? Object.keys(parsed).slice(0, 40) : [],
      };
    }

    const missing = missingDetailFields(parsed, kind);
    return {
      kind,
      id,
      url,
      status: missing.length === 0 ? "passed" : "failed",
      httpStatus: response.status,
      keys: Object.keys(parsed).slice(0, 40),
      fields: summarizeFields(parsed),
      missing,
    };
  } catch (error) {
    return {
      kind,
      id,
      url,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeCompatibility(label: string, url: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    const body = await response.text();
    const parsed = parseJsonObject(body);
    return {
      label,
      url,
      httpStatus: response.status,
      keys: parsed ? Object.keys(parsed).slice(0, 12) : [],
      errorCode: parsed?.code,
      errorMessage: parsed?.msg ?? parsed?.localized_message,
    };
  } catch (error) {
    return {
      label,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function requestHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    Referer: DETAIL_REFERER,
    "User-Agent": DETAIL_USER_AGENT,
  };
}

function withApiKey(url: string): string {
  return `${url}?apikey=${API_KEY}`;
}

function parseJsonObject(body: string): Record<string, any> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
  } catch {
    // The caller reports a non-JSON response through the empty key list.
  }
  return undefined;
}

function missingDetailFields(value: Record<string, any>, kind: "movie" | "tv"): string[] {
  const required = [
    "id",
    "title",
    "cover_url",
    "rating.value",
    "genres",
    "intro",
    "directors",
    "actors",
    "year",
    "pubdate",
  ];
  if (kind === "tv") required.push("episodes_count", "episodes_info");
  return required.filter((field) => {
    const parts = field.split(".");
    const root = parts[0];
    const nested = parts[1];
    if (!root) return true;
    if (nested) return value[root]?.[nested] === undefined;
    return value[root] === undefined;
  });
}

function summarizeFields(value: Record<string, any>): Record<string, unknown> {
  return {
    id: value.id,
    title: value.title,
    year: value.year,
    coverUrl: value.cover_url,
    rating: value.rating?.value,
    genres: value.genres,
    directors: names(value.directors),
    actors: names(value.actors, 5),
    introLength: typeof value.intro === "string" ? value.intro.length : undefined,
    pubdate: value.pubdate,
    episodesCount: value.episodes_count,
    episodesInfo: value.episodes_info,
  };
}

function names(value: unknown, limit = 3): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((entry) => (entry && typeof entry.name === "string" ? entry.name : ""))
    .filter(Boolean);
}

if (process.argv[1]?.endsWith("douban-detail-probe.ts")) {
  runDoubanDetailProbe()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
