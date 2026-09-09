import { createServer, type Server } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

import {
  resolvePackagedExecutable,
  runPackagedExecutable,
  type PackagedProcessResult,
} from "./packaged-process.js";
import { createMediaFixtureServer, mediaFixtureBytes } from "./media-fixture.js";

const workDirectory = mkdtempSync(join(tmpdir(), "qx-packaged-e2e-"));
const configFile = join(workDirectory, "config.json");
const userData = process.env.QX_E2E_USER_DATA?.trim()
  ? resolve(process.env.QX_E2E_USER_DATA)
  : join(workDirectory, "user-data");
const localMediaFile = join(workDirectory, "local-fixture.mp4");
const downloadDirectory = join(workDirectory, "downloads");
const firstResult = join(workDirectory, "first-result.json");
const secondResult = join(workDirectory, "second-result.json");
let config = "";
const useRealAria2 = process.env.QX_E2E_REAL_ARIA2 === "1";

let configServer: Server | undefined;
const mediaFixture = createMediaFixtureServer();
let dlnaFixture: DlnaFixture | undefined;

function parserEnvironment(): Record<string, string> {
  return {
    QX_PARSE_CANDIDATES_JSON: JSON.stringify([
      {
        id: "fixture-parser-first",
        name: "Fixture parser first",
        type: "json",
        endpoint: mediaFixture.parserFailureUrl,
        enabled: true,
        priority: 1,
        timeout: 5_000,
      },
      {
        id: "fixture-parser-second",
        name: "Fixture parser second",
        type: "json",
        endpoint: mediaFixture.parserUrl,
        enabled: true,
        priority: 2,
        timeout: 5_000,
      },
    ]),
    QX_PARSE_ALLOWED_ORIGINS: mediaFixture.baseUrl,
  };
}

function playbackRuleEnvironment(configJson: string): Record<string, string> {
  const parsed = JSON.parse(configJson) as { sites?: Array<{ key?: unknown; api?: unknown }> };
  const firstSite = parsed.sites?.[0];
  const sourceId = typeof firstSite?.key === "string" && firstSite.key.trim()
    ? firstSite.key.trim()
    : typeof firstSite?.api === "string" ? firstSite.api.trim() : "playable";
  return {
    QX_PLAYBACK_RULES_JSON: JSON.stringify([{
      id: "fixture-remove-cue-marker",
      sourceId,
      enabled: true,
      priority: 1,
      match: { pathPrefix: "/protected" },
      action: { type: "marker-filter", markers: ["#EXT-X-CUE-OUT"] },
      scope: "path",
      safeDescription: "Remove the explicit local fixture cue marker",
    }]),
  };
}

try {
  writeFileSync(localMediaFile, mediaFixtureBytes());
  mkdirSync(downloadDirectory);
  await mediaFixture.start();
  dlnaFixture = createDlnaFixture(mediaFixture.mp4Url);
  await dlnaFixture.start();
  config = JSON.stringify({
    spider: "csp_Douban.jvm.jar",
    sites: [
      {
        key: "douban",
        name: "Local Douban fixture",
        type: 3,
        api: "csp_Douban",
        ext: mediaFixture.doubanEndpoint,
      },
      {
        key: "douban-alt",
        name: "Local Douban fixture 2",
        type: 3,
        api: "csp_Douban",
        ext: mediaFixture.doubanEndpoint,
      },
    ],
  });
  writeFileSync(configFile, config, "utf8");
  const playbackConfig = JSON.stringify({
    spider: "csp_PlayableFixture.jvm.jar",
    sites: [{
      key: "playable",
      name: "Playable fixture",
      type: 3,
      api: "csp_PlayableFixture",
      ext: mediaFixture.playerUrl,
    }],
  });
  const configUrl = await startConfigServer(config);
  const executable = process.env.QX_PACKAGED_EXECUTABLE ?? resolvePackagedExecutable();
  const executableArgs = process.env.QX_E2E_DEV_APP?.trim()
    ? [resolve(process.env.QX_E2E_DEV_APP)]
    : [];
  const first = await runPackagedExecutable(executable, {
    QX_ELECTRON_E2E: "1",
    QX_E2E_CONFIG_URL: configUrl,
    QX_E2E_CONFIG_FILE: configFile,
    QX_E2E_CONFIG_JSON: config,
    QX_E2E_FRESH_TRUST: "1",
    QX_E2E_RESULT_PATH: firstResult,
    QX_E2E_USER_DATA: userData,
    QX_E2E_PLAYBACK_CONFIG: playbackConfig,
    QX_E2E_LOCAL_MEDIA_FILE: localMediaFile,
    QX_E2E_DOWNLOAD_DIR: downloadDirectory,
    QX_E2E_PUSH_URL: mediaFixture.mp4Url,
    QX_E2E_CAST_SSDP_PORT: String(dlnaFixture.ssdpPort),
    QX_E2E_WEB_CONTROL: "1",
    QX_E2E_BACKUP: "1",
    QX_CAST_ADVERTISED_HOST: "127.0.0.1",
    QX_PUSH_TRUSTED_LOCAL_ORIGINS: mediaFixture.baseUrl,
    ...(useRealAria2 ? { QX_E2E_DOWNLOAD_URL: mediaFixture.mp4Url } : { QX_E2E_FAKE_ARIA2: "1" }),
    QX_PLAYBACK_PROXY_ORIGINS: mediaFixture.baseUrl,
    QX_PLAYBACK_FALLBACK_MODE: "auto",
    QX_E2E_HLS_MASTER_URL: mediaFixture.hlsMasterUrl,
    QX_E2E_HLS_CHILD_URL: mediaFixture.hlsChildUrl,
    QX_E2E_FAKE_MPV: "1",
    QX_SNIFF_ENABLED: "1",
    QX_E2E_SNIFF_URL: mediaFixture.sniffUrl,
    ...parserEnvironment(),
    ...playbackRuleEnvironment(playbackConfig),
  }, executableArgs);
  const firstResultValue = readResult(firstResult);
  assertRun("first packaged E2E", first, firstResultValue);
  const firstFavoriteId = stringValue(firstResultValue.favoriteId, "Packaged E2E did not return a favorite identity");
  const firstFollowIdentity = stringValue(firstResultValue.followIdentity, "Packaged E2E did not return a follow identity");
  assertPersistedDesktopState(userData, "douban");
  assertPersistedHistoryPrivacy(userData);
  assertPersistedFavoritesPrivacy(userData);
  assertPersistedFollowPrivacy(userData);
  assertPersistedCacheRoot(userData);

  const second = await runPackagedExecutable(executable, {
    QX_ELECTRON_E2E: "1",
    QX_E2E_CONFIG_URL: configUrl,
    QX_E2E_CONFIG_FILE: configFile,
    QX_E2E_CONFIG_JSON: config,
    QX_E2E_FRESH_TRUST: "0",
    QX_E2E_RESULT_PATH: secondResult,
    QX_E2E_USER_DATA: userData,
    QX_E2E_PLAYBACK_CONFIG: playbackConfig,
    QX_E2E_LOCAL_MEDIA_FILE: localMediaFile,
    QX_E2E_DOWNLOAD_DIR: downloadDirectory,
    QX_E2E_PUSH_URL: mediaFixture.mp4Url,
    QX_E2E_CAST_SSDP_PORT: String(dlnaFixture.ssdpPort),
    QX_E2E_WEB_CONTROL: "1",
    QX_E2E_BACKUP: "1",
    QX_CAST_ADVERTISED_HOST: "127.0.0.1",
    QX_PUSH_TRUSTED_LOCAL_ORIGINS: mediaFixture.baseUrl,
    ...(useRealAria2 ? { QX_E2E_DOWNLOAD_URL: mediaFixture.mp4Url } : { QX_E2E_FAKE_ARIA2: "1" }),
    QX_E2E_EXPECTED_FAVORITE_ID: firstFavoriteId,
    QX_E2E_EXPECTED_FOLLOW_ID: firstFollowIdentity,
    QX_PLAYBACK_PROXY_ORIGINS: mediaFixture.baseUrl,
    QX_PLAYBACK_FALLBACK_MODE: "auto",
    QX_E2E_HLS_MASTER_URL: mediaFixture.hlsMasterUrl,
    QX_E2E_HLS_CHILD_URL: mediaFixture.hlsChildUrl,
    QX_E2E_FAKE_MPV: "1",
    QX_SNIFF_ENABLED: "1",
    QX_E2E_SNIFF_URL: mediaFixture.sniffUrl,
    ...parserEnvironment(),
    ...playbackRuleEnvironment(playbackConfig),
  }, executableArgs);
  const secondResultValue = readResult(secondResult);
  assertRun("restarted packaged E2E", second, secondResultValue);
  assertPersistedDesktopState(userData, "douban");
  assertPersistedHistoryPrivacy(userData);
  assertPersistedFavoritesPrivacy(userData);
  assertPersistedFollowPrivacy(userData);
  assertPersistedCacheRoot(userData);

  console.log(JSON.stringify({
    probe: "packaged-electron-e2e",
    status: "passed",
    first: firstResultValue,
    restarted: secondResultValue,
  }, null, 2));
} finally {
  if (configServer) await closeServer(configServer);
  if (dlnaFixture) await dlnaFixture.close();
  await mediaFixture.close();
  rmSync(workDirectory, { recursive: true, force: true });
}

interface DlnaFixture {
  readonly ssdpPort: number;
  start(): Promise<void>;
  close(): Promise<void>;
}

function createDlnaFixture(mediaUrl: string): DlnaFixture {
  let httpServer: Server | undefined;
  let ssdpSocket: Socket | undefined;
  let descriptionUrl = "";
  let ssdpPort = 0;
  return {
    get ssdpPort() {
      if (!ssdpPort) throw new Error("DLNA fixture is not running");
      return ssdpPort;
    },
    async start() {
      httpServer = createServer((request, response) => {
        void handleDlnaHttp(request, response, mediaUrl);
      });
      await listenServer(httpServer);
      const httpAddress = httpServer.address() as AddressInfo;
      descriptionUrl = `http://127.0.0.1:${httpAddress.port}/description.xml`;
      ssdpSocket = createSocket("udp4");
      ssdpSocket.on("message", (_message, remote) => {
        const payload = Buffer.from([
          "HTTP/1.1 200 OK",
          "CACHE-CONTROL: max-age=60",
          `LOCATION: ${descriptionUrl}`,
          "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
          "USN: uuid:packaged-renderer::urn:schemas-upnp-org:device:MediaRenderer:1",
          "",
          "",
        ].join("\r\n"), "utf8");
        ssdpSocket?.send(payload, remote.port, remote.address);
      });
      await new Promise<void>((resolve, reject) => {
        ssdpSocket?.once("error", reject);
        ssdpSocket?.bind(0, "127.0.0.1", resolve);
      });
      ssdpPort = (ssdpSocket.address() as AddressInfo).port;
    },
    async close() {
      if (ssdpSocket) {
        await new Promise<void>((resolve) => ssdpSocket?.close(resolve));
        ssdpSocket = undefined;
      }
      if (httpServer) {
        await closeServer(httpServer);
        httpServer = undefined;
      }
      ssdpPort = 0;
    },
  };
}

async function handleDlnaHttp(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  mediaUrl: string,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1/").pathname;
  if (path === "/description.xml") {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end("<?xml version=\"1.0\"?><root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Packaged Fixture TV</friendlyName><manufacturer>QX Fixture</manufacturer><modelName>Cast Model</modelName><UDN>uuid:packaged-renderer</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><SCPDURL>/scpd.xml</SCPDURL><controlURL>/control</controlURL></service></serviceList></device></root>");
    return;
  }
  if (path === "/scpd.xml") {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end("<scpd><actionList><action><name>SetAVTransportURI</name></action><action><name>Play</name></action><action><name>Pause</name></action><action><name>Stop</name></action><action><name>Seek</name></action><action><name>GetPositionInfo</name></action></actionList></scpd>");
    return;
  }
  if (path !== "/control") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  const action = body.match(/<u:([A-Za-z]+)\s+xmlns:u=/u)?.[1] ?? "Unknown";
  if (action === "SetAVTransportURI" && !body.includes(mediaUrl) && !body.includes("/__qx_cast/")) {
    response.writeHead(400);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/xml" });
  response.end(`<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:${action}Response xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\" /></s:Body></s:Envelope>`);
}

async function listenServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function startConfigServer(payload: string): Promise<string> {
  configServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    configServer?.once("error", reject);
    configServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = configServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/config.json`;
}

function readResult(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function stringValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function assertRun(name: string, process: PackagedProcessResult, result: Record<string, unknown>): void {
  if (process.code !== 0 || result.status !== "passed") {
    throw new Error(`${name} failed: ${JSON.stringify({ process, result })}`);
  }
}

function assertPersistedDesktopState(userDataPath: string, expectedSiteKey: string): void {
  const database = new DatabaseSync(join(userDataPath, "qx-yingshi.db"), { readOnly: true });
  let value: Record<string, unknown>;
  try {
    const row = database.prepare(
      "SELECT value_json FROM settings WHERE key = ?",
    ).get("desktop-state") as { value_json?: unknown } | undefined;
    if (typeof row?.value_json !== "string") {
      throw new Error("Packaged E2E desktop state row was not persisted");
    }
    value = JSON.parse(row.value_json) as Record<string, unknown>;
  } finally {
    database.close();
  }
  const page = value.page as Record<string, unknown> | undefined;
  const window = value.window as Record<string, unknown> | undefined;
  if (value.version !== 1
    || (value.theme !== "light" && value.theme !== "dark")
    || page?.siteKey !== expectedSiteKey
    || typeof page?.navigation !== "string"
    || typeof page?.scrollTop !== "number"
    || typeof window?.width !== "number"
    || typeof window?.height !== "number"
    || typeof window?.isMaximized !== "boolean"
    || JSON.stringify(value).match(/authorization|cookie|token|api[_-]?key/i)) {
    throw new Error("Packaged E2E desktop state persistence contract failed");
  }
}

function assertPersistedHistoryPrivacy(userDataPath: string): void {
  const database = new DatabaseSync(join(userDataPath, "qx-yingshi.db"), { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT identity, source_id, vod_id, season_id, episode_id, title, poster,
             episode, episode_name, playback_line, position, duration,
             updated_at, completed, source_display_name
      FROM history
    `).all();
    if (rows.length === 0) throw new Error("Packaged E2E history row was not persisted");
    const serialized = JSON.stringify(rows);
    if (/https?:\/\/|token|cookie|authorization|bearer|__qx_playback/i.test(serialized)) {
      throw new Error("Packaged E2E history privacy contract failed");
    }
  } finally {
    database.close();
  }
}

function assertPersistedFavoritesPrivacy(userDataPath: string): void {
  const database = new DatabaseSync(join(userDataPath, "qx-yingshi.db"), { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT favorite_id, source_id, vod_id, title, poster, year, category,
             source_name, group_id, sort_order, metadata_json, added_at, updated_at
      FROM favorites
    `).all();
    if (rows.length === 0) throw new Error("Packaged E2E favorite row was not persisted");
    const serialized = JSON.stringify(rows);
    if (/token|cookie|authorization|bearer|__qx_playback|m3u8|\.mp4|\.mkv|\.webm|\.mpd|\/(?:stream|playback|playlist|session|proxy)(?:\/|["?])/i.test(serialized)) {
      throw new Error("Packaged E2E favorites privacy contract failed");
    }
  } finally {
    database.close();
  }
}

function assertPersistedFollowPrivacy(userDataPath: string): void {
  const database = new DatabaseSync(join(userDataPath, "qx-yingshi.db"), { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT identity, source_id, vod_id, title, poster, latest_episode_id,
             latest_episode_name, watched_episode_id, watched_episode_name,
             known_episode_count, last_checked_at, last_updated_at,
             update_available, check_error, enabled
      FROM follow_items
    `).all();
    if (rows.length === 0) throw new Error("Packaged E2E follow row was not persisted");
    const serialized = JSON.stringify(rows);
    if (/token|cookie|authorization|bearer|__qx_playback|m3u8|\.mp4|\.mkv|\.webm|\.mpd|\/(?:stream|playback|playlist|session|proxy)(?:\/|["?])/i.test(serialized)) {
      throw new Error("Packaged E2E follow privacy contract failed");
    }
  } finally {
    database.close();
  }
}

function assertPersistedCacheRoot(userDataPath: string): void {
  if (!existsSync(join(userDataPath, "cache")) || !existsSync(join(userDataPath, "qx-yingshi.db"))) {
    throw new Error("Packaged E2E cache root or user database was not preserved");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
