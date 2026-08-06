import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  JellyfinAdapter,
  JellyfinError,
  hasCompleteJellyfinEnvironment,
  readJellyfinEnvironment,
  validateJellyfinConfig,
} from "../src/jellyfin/jellyfin-adapter.js";
import { JellyfinPlaybackSession } from "../src/jellyfin/jellyfin-playback.js";

const FIXTURE_TOKEN = "fixture-token";
const FIXTURE_USER_ID = "user-1";
const fixtureRequests: FixtureRequest[] = [];

describe("JellyfinAdapter", () => {
  let server: Server;
  let origin: string;
  const requests = fixtureRequests;

  beforeAll(async () => {
    server = createServer((request, response) => {
      void handleFixtureRequest(request, response, origin);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => requests.splice(0));

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("validates a safe base URL and reports partial environment without secrets", () => {
    expect(readJellyfinEnvironment({})).toBeNull();
    expect(hasCompleteJellyfinEnvironment({ QX_JELLYFIN_URL: origin })).toBe(false);
    expect(hasCompleteJellyfinEnvironment({
      QX_JELLYFIN_URL: origin,
      QX_JELLYFIN_TOKEN: FIXTURE_TOKEN,
      QX_JELLYFIN_USER_ID: FIXTURE_USER_ID,
    })).toBe(true);
    expect(() => readJellyfinEnvironment({ QX_JELLYFIN_URL: origin }))
      .toThrowError("Jellyfin environment configuration is incomplete.");
    expect(() => validateJellyfinConfig({
      baseUrl: "file:///private",
      token: FIXTURE_TOKEN,
      userId: FIXTURE_USER_ID,
    })).toThrowError(JellyfinError);
    expect(() => validateJellyfinConfig({
      baseUrl: origin,
      token: "",
      userId: FIXTURE_USER_ID,
    })).toThrowError(JellyfinError);
  });

  it("connects with token auth and covers libraries, media types, search, detail, seasons and episodes", async () => {
    const adapter = createAdapter();

    await expect(adapter.connect()).resolves.toMatchObject({
      serverName: "Fixture Jellyfin",
      version: "10.10.0",
      userId: FIXTURE_USER_ID,
    });
    await expect(adapter.listLibraries()).resolves.toEqual([
      { id: "library-movies", name: "Movies", collectionType: "movies" },
      { id: "library-shows", name: "Shows", collectionType: "tvshows" },
    ]);
    await expect(adapter.listMovies("library-movies")).resolves.toMatchObject([
      { id: "movie-1", name: "Fixture Movie", type: "Movie" },
    ]);
    await expect(adapter.listSeries("library-shows")).resolves.toMatchObject([
      { id: "series-1", name: "Fixture Series", type: "Series" },
    ]);
    await expect(adapter.search("fixture")).resolves.toMatchObject([
      { id: "movie-1", name: "Fixture Movie", type: "Movie" },
      { id: "series-1", name: "Fixture Series", type: "Series" },
    ]);
    await expect(adapter.getDetails("series-1")).resolves.toMatchObject({
      id: "series-1",
      name: "Fixture Series",
      type: "Series",
      overview: "A local Jellyfin contract fixture.",
    });
    await expect(adapter.listSeasons("series-1")).resolves.toMatchObject([
      { id: "season-1", name: "Season 1", type: "Season" },
    ]);
    await expect(adapter.listEpisodes("series-1", "season-1")).resolves.toMatchObject([
      { id: "episode-1", name: "Episode 1", type: "Episode", seasonId: "season-1" },
    ]);

    const authenticated = requests.filter((request) => request.path !== "/System/Info/Public");
    expect(authenticated.length).toBeGreaterThan(0);
    expect(authenticated.every((request) => request.headers["x-emby-token"] === FIXTURE_TOKEN)).toBe(true);
  });

  it("supports username authentication without returning or logging the access token", async () => {
    const adapter = createAdapter();

    await expect(adapter.authenticateByName("fixture-user", "fixture-password")).resolves.toEqual({
      userId: FIXTURE_USER_ID,
      authenticated: true,
    });
    const authRequest = requests.find((request) => request.path === "/Users/AuthenticateByName");
    expect(authRequest?.headers["x-emby-token"]).toBeUndefined();
    expect(authRequest?.headers["content-type"]).toContain("application/json");
  });

  it("selects Direct Play, strips URL credentials and supplies protected playback headers", async () => {
    const adapter = createAdapter();
    const playback = await adapter.getPlayback("episode-1");

    expect(playback).toEqual({
      parse: 0,
      url: `${origin}/Videos/episode-1/stream?static=true`,
      headers: { "X-Emby-Token": FIXTURE_TOKEN },
      directPlay: true,
      itemId: "episode-1",
      mediaSourceId: "source-1",
    });
  });

  it("maps a direct-play source into the embedded player through LocalProxy", async () => {
    const adapter = createAdapter();
    const session = new JellyfinPlaybackSession(adapter);
    let proxyUrl = "";
    try {
      const state = await session.load("episode-1");
      expect(state.player).toMatchObject({ status: "loading" });
      expect(state.player.source?.headers).toEqual({});
      expect(state.player.source?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__qx_playback\//);
      proxyUrl = state.player.source?.url ?? "";

      const media = await fetch(state.player.source?.url as string);
      expect(media.status).toBe(200);
      expect(await media.text()).toBe("fixture-jellyfin-media");
      expect(requests.at(-1)?.headers["x-emby-token"]).toBe(FIXTURE_TOKEN);
    } finally {
      await session.close();
    }
    await expect(fetch(proxyUrl)).rejects.toThrow();
  });

  it("rejects transcode-only playback and sanitizes upstream error bodies", async () => {
    const adapter = createAdapter();

    await expect(adapter.getPlayback("episode-transcode")).rejects.toMatchObject({
      code: "JELLYFIN_TRANSCODING_UNSUPPORTED",
    });
    await expect(adapter.getDetails("error-item")).rejects.toMatchObject({
      code: "JELLYFIN_REQUEST_FAILED",
    });
    await expect(adapter.getDetails("error-item")).rejects.not.toThrow(FIXTURE_TOKEN);
  });

  const realEnvironment = hasCompleteJellyfinEnvironment(process.env)
    ? readJellyfinEnvironment(process.env)
    : null;
  if (realEnvironment) {
    it("runs the optional authorized Jellyfin E2E when all credentials are present", async () => {
      const adapter = new JellyfinAdapter(realEnvironment, { requestTimeoutMs: 10_000 });
      const connection = await adapter.connect();
      const libraries = await adapter.listLibraries();

      expect(connection.authenticated).toBe(true);
      expect(libraries).toBeInstanceOf(Array);
    });
  } else {
    it("marks the optional real Jellyfin E2E as external-environment-blocked", () => {
      expect(readJellyfinEnvironment({})).toBeNull();
    });
  }

  function createAdapter(): JellyfinAdapter {
    return new JellyfinAdapter({
      baseUrl: origin,
      token: FIXTURE_TOKEN,
      userId: FIXTURE_USER_ID,
    }, { requestTimeoutMs: 1_000 });
  }
});

interface FixtureRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", baseUrl);
  fixtureRequests.push({
    method: request.method ?? "GET",
    path: url.pathname,
    headers: request.headers,
  });

  if (url.pathname === "/System/Info/Public") {
    return json(response, { ServerName: "Fixture Jellyfin", Version: "10.10.0", Id: "server-1" });
  }
  if (url.pathname === "/Users/AuthenticateByName") {
    await readBody(request);
    return json(response, {
      AccessToken: "fixture-authenticated-token",
      User: { Id: FIXTURE_USER_ID, Name: "fixture-user" },
    });
  }
  if (url.pathname === `/Users/${FIXTURE_USER_ID}`) {
    if (!authorized(request)) return failure(response, 401, "fixture-token must not be logged");
    return json(response, { Id: FIXTURE_USER_ID, Name: "fixture-user" });
  }
  if (!authorized(request)) return failure(response, 401, "unauthorized fixture request");

  if (url.pathname === `/Users/${FIXTURE_USER_ID}/Views`) {
    return json(response, { Items: [
      { Id: "library-movies", Name: "Movies", CollectionType: "movies" },
      { Id: "library-shows", Name: "Shows", CollectionType: "tvshows" },
    ] });
  }
  if (url.pathname === `/Users/${FIXTURE_USER_ID}/Items`) {
    const type = url.searchParams.get("IncludeItemTypes");
    return json(response, { Items: type === "Series"
      ? [{ Id: "series-1", Name: "Fixture Series", Type: "Series" }]
      : [{ Id: "movie-1", Name: "Fixture Movie", Type: "Movie" }] });
  }
  if (url.pathname === "/Search/Hints") {
    return json(response, { SearchHints: [
      { Id: "movie-1", Name: "Fixture Movie", Type: "Movie" },
      { Id: "series-1", Name: "Fixture Series", Type: "Series" },
    ] });
  }
  if (url.pathname === `/Users/${FIXTURE_USER_ID}/Items/series-1`) {
    return json(response, {
      Id: "series-1",
      Name: "Fixture Series",
      Type: "Series",
      Overview: "A local Jellyfin contract fixture.",
    });
  }
  if (url.pathname === `/Users/${FIXTURE_USER_ID}/Items/error-item`) {
    return failure(response, 500, `upstream body contains ${FIXTURE_TOKEN}`);
  }
  if (url.pathname === "/Shows/series-1/Seasons") {
    return json(response, { Items: [{ Id: "season-1", Name: "Season 1", Type: "Season" }] });
  }
  if (url.pathname === "/Shows/series-1/Episodes") {
    return json(response, {
      Items: [{ Id: "episode-1", Name: "Episode 1", Type: "Episode", SeasonId: "season-1" }],
    });
  }
  if (url.pathname === "/Items/episode-1/PlaybackInfo") {
    return json(response, { MediaSources: [{
      Id: "source-1",
      SupportsDirectPlay: true,
      DirectPlayUrl: "/Videos/episode-1/stream?static=true&api_key=fixture-token",
    }] });
  }
  if (url.pathname === "/Items/episode-transcode/PlaybackInfo") {
    return json(response, { MediaSources: [{
      Id: "source-transcode",
      SupportsDirectPlay: false,
      TranscodingUrl: "/Videos/episode-transcode/master.m3u8",
    }] });
  }
  if (url.pathname === "/Videos/episode-1/stream") {
    return authorized(request)
      ? text(response, 200, "fixture-jellyfin-media")
      : failure(response, 403, "protected media");
  }
  return failure(response, 404, "not found");
}

function authorized(request: IncomingMessage): boolean {
  return request.headers["x-emby-token"] === FIXTURE_TOKEN;
}

function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function text(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { "content-type": "video/mp4" });
  response.end(value);
}

function failure(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: message }));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
