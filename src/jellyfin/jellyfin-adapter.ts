import type { PlaybackSource } from "../desktop/playback.js";
import { normalizeSubtitleTracks, subtitleFormatFromName } from "../subtitles.js";

export interface JellyfinConfig {
  baseUrl: string;
  token: string;
  userId: string;
}

export interface JellyfinAdapterOptions {
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface JellyfinConnection {
  serverName: string;
  version: string;
  serverId: string;
  userId: string;
  authenticated: true;
}

export interface JellyfinAuthResult {
  userId: string;
  authenticated: true;
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  collectionType: string | null;
}

export interface JellyfinItem {
  id: string;
  name: string;
  type: string;
  overview?: string;
  year?: number;
  parentId?: string;
  seriesId?: string;
  seasonId?: string;
}

export interface JellyfinPlayback extends PlaybackSource {
  directPlay: true;
  itemId: string;
  mediaSourceId: string;
}

export class JellyfinError extends Error {
  public readonly code: string;
  public readonly status: number | undefined;

  public constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "JellyfinError";
    this.code = code;
    this.status = status;
  }
}

export function readJellyfinEnvironment(
  environment: NodeJS.ProcessEnv,
): JellyfinConfig | null {
  const baseUrl = environment.QX_JELLYFIN_URL?.trim() ?? "";
  const token = environment.QX_JELLYFIN_TOKEN?.trim() ?? "";
  const userId = environment.QX_JELLYFIN_USER_ID?.trim() ?? "";
  if (!baseUrl && !token && !userId) return null;
  if (!baseUrl || !token || !userId) {
    throw new JellyfinError(
      "JELLYFIN_CONFIG_INVALID",
      "Jellyfin environment configuration is incomplete.",
    );
  }
  return validateJellyfinConfig({ baseUrl, token, userId });
}

export function hasCompleteJellyfinEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.QX_JELLYFIN_URL?.trim()
      && environment.QX_JELLYFIN_TOKEN?.trim()
      && environment.QX_JELLYFIN_USER_ID?.trim(),
  );
}

export function validateJellyfinConfig(value: unknown): JellyfinConfig {
  if (!isRecord(value)) throw invalidConfig();
  const baseUrl = stringValue(value.baseUrl);
  const token = stringValue(value.token);
  const userId = stringValue(value.userId);
  if (!baseUrl || !token || !userId) throw invalidConfig();

  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  } catch {
    throw invalidConfig();
  }
  return { baseUrl: normalizedBaseUrl, token, userId };
}

export class JellyfinAdapter {
  public readonly origin: string;
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly userId: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(config: JellyfinConfig, options: JellyfinAdapterOptions = {}) {
    const validated = validateJellyfinConfig(config);
    this.baseUrl = new URL(validated.baseUrl);
    this.origin = this.baseUrl.origin;
    this.token = validated.token;
    this.userId = validated.userId;
    this.requestTimeoutMs = positiveOrDefault(options.requestTimeoutMs, 10_000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  public async connect(): Promise<JellyfinConnection> {
    const system = await this.requestJson("/System/Info/Public", false);
    const user = await this.authenticate();
    const serverName = requiredString(system, "ServerName");
    const version = requiredString(system, "Version");
    const serverId = requiredString(system, "Id");
    return {
      serverName,
      version,
      serverId,
      userId: user.id,
      authenticated: true,
    };
  }

  public async authenticateByName(username: string, password: string): Promise<JellyfinAuthResult> {
    if (!username || !password) {
      throw new JellyfinError("JELLYFIN_AUTH_FAILED", "Jellyfin username and password are required.");
    }
    const value = await this.requestJson("/Users/AuthenticateByName", false, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    const user = isRecord(value.User) ? normalizeUser(value.User) : null;
    if (!user || typeof value.AccessToken !== "string" || value.AccessToken.length === 0) {
      throw new JellyfinError("JELLYFIN_AUTH_FAILED", "Jellyfin authentication response is invalid.");
    }
    return { userId: user.id, authenticated: true };
  }

  public async listLibraries(): Promise<readonly JellyfinLibrary[]> {
    const value = await this.requestJson(`/Users/${segment(this.userId)}/Views`);
    if (!isRecord(value) || !Array.isArray(value.Items)) {
      throw invalidResponse();
    }
    return value.Items.map(normalizeLibrary);
  }

  public listMovies(libraryId: string): Promise<readonly JellyfinItem[]> {
    return this.listItems(libraryId, "Movie");
  }

  public listSeries(libraryId: string): Promise<readonly JellyfinItem[]> {
    return this.listItems(libraryId, "Series");
  }

  public async listSeasons(seriesId: string): Promise<readonly JellyfinItem[]> {
    const value = await this.requestJson(`/Shows/${segment(seriesId)}/Seasons?UserId=${segment(this.userId)}`);
    return itemsFrom(value, "Items");
  }

  public async listEpisodes(
    seriesId: string,
    seasonId?: string,
  ): Promise<readonly JellyfinItem[]> {
    const query = new URLSearchParams({ UserId: this.userId });
    if (seasonId) query.set("SeasonId", seasonId);
    const value = await this.requestJson(`/Shows/${segment(seriesId)}/Episodes?${query.toString()}`);
    return itemsFrom(value, "Items");
  }

  public async search(term: string): Promise<readonly JellyfinItem[]> {
    const query = new URLSearchParams({
      UserId: this.userId,
      SearchTerm: term,
      IncludeItemTypes: "Movie,Series,Season,Episode",
      Limit: "100",
    });
    const value = await this.requestJson(`/Search/Hints?${query.toString()}`);
    return itemsFrom(value, "SearchHints");
  }

  public async getDetails(itemId: string): Promise<JellyfinItem> {
    const value = await this.requestJson(
      `/Users/${segment(this.userId)}/Items/${segment(itemId)}?Fields=Overview,ProductionYear,ParentId,SeriesId,SeasonId`,
    );
    return normalizeItem(value);
  }

  public async getPlayback(itemId: string): Promise<JellyfinPlayback> {
    const query = new URLSearchParams({
      UserId: this.userId,
      EnableDirectPlay: "true",
      EnableDirectStream: "false",
      EnableTranscoding: "false",
    });
    const value = await this.requestJson(`/Items/${segment(itemId)}/PlaybackInfo?${query.toString()}`);
    if (!isRecord(value) || !Array.isArray(value.MediaSources)) throw invalidResponse();

    const directSource = value.MediaSources.find((candidate) => (
      isRecord(candidate) && candidate.SupportsDirectPlay === true
    ));
    if (!isRecord(directSource)) {
      const hasTranscoding = value.MediaSources.some((candidate) => (
        isRecord(candidate) && typeof candidate.TranscodingUrl === "string"
      ));
      if (hasTranscoding) {
        throw new JellyfinError(
          "JELLYFIN_TRANSCODING_UNSUPPORTED",
          "Jellyfin only offered transcoding; Direct Play is unavailable.",
        );
      }
      throw new JellyfinError(
        "JELLYFIN_DIRECT_PLAY_UNAVAILABLE",
        "Jellyfin did not offer a Direct Play media source.",
      );
    }

    const mediaSourceId = requiredString(directSource, "Id");
    const directUrl = typeof directSource.DirectPlayUrl === "string"
      ? directSource.DirectPlayUrl
      : `/Videos/${segment(itemId)}/stream?static=true&mediaSourceId=${encodeURIComponent(mediaSourceId)}`;
    const subtitles = jellyfinSubtitleTracks(
      directSource.MediaStreams,
      itemId,
      mediaSourceId,
      (value) => this.normalizePlaybackUrl(value),
      this.token,
    );
    return {
      parse: 0,
      url: this.normalizePlaybackUrl(directUrl),
      headers: { "X-Emby-Token": this.token },
      directPlay: true,
      itemId,
      mediaSourceId,
      ...(subtitles.length > 0 ? { subtitles } : {}),
    };
  }

  private async authenticate(): Promise<{ id: string }> {
    const value = await this.requestJson(`/Users/${segment(this.userId)}`);
    if (!isRecord(value)) throw invalidResponse();
    return normalizeUser(value);
  }

  private async listItems(libraryId: string, itemType: "Movie" | "Series"): Promise<readonly JellyfinItem[]> {
    const query = new URLSearchParams({
      UserId: this.userId,
      ParentId: libraryId,
      IncludeItemTypes: itemType,
      Recursive: "true",
      Fields: "Overview,ProductionYear,ParentId,SeriesId,SeasonId",
    });
    const value = await this.requestJson(`/Users/${segment(this.userId)}/Items?${query.toString()}`);
    return itemsFrom(value, "Items");
  }

  private async requestJson(
    path: string,
    authenticated = true,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (authenticated) headers.set("x-emby-token", this.token);
    try {
      const response = await this.fetchImpl(this.resolve(path), {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? "JELLYFIN_AUTH_FAILED"
          : "JELLYFIN_REQUEST_FAILED";
        const message = code === "JELLYFIN_AUTH_FAILED"
          ? "Jellyfin authentication failed."
          : `Jellyfin request failed (HTTP ${response.status}).`;
        throw new JellyfinError(code, message, response.status);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw invalidResponse();
      }
      if (!isRecord(value)) throw invalidResponse();
      return value;
    } catch (error) {
      if (error instanceof JellyfinError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new JellyfinError("JELLYFIN_CONNECTION_FAILED", "Jellyfin request timed out.");
      }
      throw new JellyfinError("JELLYFIN_CONNECTION_FAILED", "Unable to connect to Jellyfin.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolve(path: string): string {
    return new URL(path.replace(/^\/+/, ""), this.baseUrl).toString();
  }

  private normalizePlaybackUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value, this.baseUrl);
    } catch {
      throw new JellyfinError("JELLYFIN_PLAYBACK_URL_INVALID", "Jellyfin returned an invalid Direct Play URL.");
    }
    if (url.origin !== this.origin || url.username || url.password) {
      throw new JellyfinError(
        "JELLYFIN_PLAYBACK_URL_INVALID",
        "Jellyfin Direct Play URL must stay on the configured server.",
      );
    }
    url.searchParams.delete("api_key");
    url.searchParams.delete("apiKey");
    url.searchParams.delete("ApiKey");
    return url.toString();
  }
}

function jellyfinSubtitleTracks(
  value: unknown,
  itemId: string,
  mediaSourceId: string,
  normalizeUrl: (value: string) => string,
  token: string,
): ReturnType<typeof normalizeSubtitleTracks> {
  if (!Array.isArray(value)) return [];
  const tracks = value.flatMap((candidate, index) => {
    if (!isRecord(candidate) || String(candidate.Type ?? "").toLowerCase() !== "subtitle") return [];
    const codec = typeof candidate.Codec === "string" ? candidate.Codec.toLowerCase() : "";
    const path = typeof candidate.Path === "string" ? candidate.Path : "";
    const format = codec === "webvtt" || codec === "vtt"
      ? "vtt"
      : codec === "subrip" || codec === "srt"
        ? "srt"
        : codec === "ass"
          ? "ass"
          : codec === "ssa"
            ? "ssa"
            : subtitleFormatFromName(path) ?? "";
    const streamIndex = typeof candidate.Index === "number" && Number.isInteger(candidate.Index)
      ? candidate.Index
      : index;
    const deliveryUrl = typeof candidate.DeliveryUrl === "string" && candidate.DeliveryUrl.length > 0
      ? candidate.DeliveryUrl
      : `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${streamIndex}/Stream`;
    const label = typeof candidate.DisplayTitle === "string" && candidate.DisplayTitle.length > 0
      ? candidate.DisplayTitle
      : typeof candidate.Language === "string" && candidate.Language.length > 0
        ? candidate.Language
        : `字幕 ${index + 1}`;
    return [{
      id: `jellyfin-subtitle-${streamIndex}`,
      label,
      language: typeof candidate.Language === "string" && candidate.Language.length > 0 ? candidate.Language : "und",
      format,
      url: normalizeUrl(deliveryUrl),
      headers: { "X-Emby-Token": token },
      default: candidate.IsDefault === true,
      forced: candidate.IsForced === true,
      source: "jellyfin" as const,
    }];
  });
  return normalizeSubtitleTracks(tracks);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidConfig();
  if (url.username || url.password || url.search || url.hash) throw invalidConfig();
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function normalizeLibrary(value: unknown): JellyfinLibrary {
  if (!isRecord(value)) throw invalidResponse();
  return {
    id: requiredString(value, "Id"),
    name: requiredString(value, "Name"),
    collectionType: typeof value.CollectionType === "string" ? value.CollectionType : null,
  };
}

function normalizeUser(value: Record<string, unknown>): { id: string } {
  return { id: requiredString(value, "Id") };
}

function normalizeItem(value: unknown): JellyfinItem {
  if (!isRecord(value)) throw invalidResponse();
  const item: JellyfinItem = {
    id: requiredString(value, "Id"),
    name: requiredString(value, "Name"),
    type: requiredString(value, "Type"),
  };
  if (typeof value.Overview === "string") item.overview = value.Overview;
  if (typeof value.ProductionYear === "number") item.year = value.ProductionYear;
  if (typeof value.ParentId === "string") item.parentId = value.ParentId;
  if (typeof value.SeriesId === "string") item.seriesId = value.SeriesId;
  if (typeof value.SeasonId === "string") item.seasonId = value.SeasonId;
  return item;
}

function itemsFrom(value: Record<string, unknown>, key: string): JellyfinItem[] {
  if (!Array.isArray(value[key])) throw invalidResponse();
  return value[key].map(normalizeItem);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) throw invalidResponse();
  return result;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function invalidConfig(): JellyfinError {
  return new JellyfinError(
    "JELLYFIN_CONFIG_INVALID",
    "Jellyfin configuration requires an HTTP(S) URL, token and user ID.",
  );
}

function invalidResponse(): JellyfinError {
  return new JellyfinError(
    "JELLYFIN_RESPONSE_INVALID",
    "Jellyfin returned an unsupported response.",
  );
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
