import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseTvBoxConfig } from "../config/decoder.js";
import { ImportTrustStore } from "../config/trust.js";
import { DesktopSpiderSession } from "../desktop/spider-session.js";
import { DesktopSpiderUiController, DesktopSpiderUiServer } from "../desktop/spider-ui.js";
import { AndroidDeviceManager } from "../spider/android-device-manager.js";
import { AndroidArtifactRegistry, AndroidSpiderBridgeClient } from "../spider/android-spider-bridge-client.js";
import { SpiderArtifactCache } from "../spider/spider-artifact-cache.js";
import { SpiderRuntimeManager } from "../spider/spider-runtime.js";
import { defaultConfigUrl } from "./config-probe.js";

const keyword = process.env.QX_ANDROID_POC_KEYWORD?.trim() || "庆余年";
const configUrl = process.env.QX_ANDROID_POC_CONFIG_URL?.trim() || defaultConfigUrl;

const configResponse = await fetch(configUrl, { signal: AbortSignal.timeout(30_000) });
if (!configResponse.ok) throw new Error(`Configuration request failed: HTTP ${configResponse.status}`);
const config = parseTvBoxConfig(await configResponse.text());
const site = config.sites?.find((candidate) => candidate.api === "csp_Jianpian");
if (!site || !site.api) throw new Error("csp_Jianpian is missing from the configuration");
const siteKey = typeof site.key === "string" && site.key.trim() ? site.key : site.api;
const ext = typeof site.ext === "string" ? site.ext : "";

const artifactCache = new SpiderArtifactCache(
  process.env.QX_ANDROID_POC_CACHE?.trim() || join(tmpdir(), "qx-android-spider-poc-cache"),
);
const deviceManager = new AndroidDeviceManager({
  ...(process.env.QX_ANDROID_SDK_PATH ? { sdkPath: process.env.QX_ANDROID_SDK_PATH } : {}),
  ...(process.env.QX_ANDROID_DEVICE_SERIAL ? { serial: process.env.QX_ANDROID_DEVICE_SERIAL } : {}),
});
await deviceManager.startHost();
const artifactRegistry = new AndroidArtifactRegistry();
let nextLocalPort = 8780;
const runtimeManager = new SpiderRuntimeManager({
  config,
  sourceUrl: configUrl,
  artifactCache,
  androidBridgeClientFactory: async (selectedSite, support) => new AndroidSpiderBridgeClient({
    deviceManager,
    localPort: nextLocalPort++,
    ...(selectedSite.key ?? selectedSite.api ? { siteKey: selectedSite.key ?? selectedSite.api } : {}),
    ...(selectedSite.name ? { sourceName: selectedSite.name } : {}),
    ...(support.artifactUrl ? { artifactUrl: support.artifactUrl } : {}),
    artifactRegistry,
    operationTimeoutMs: 20_000,
  }),
});

const session = new DesktopSpiderSession({
  source: configUrl,
  config,
  trustStore: new ImportTrustStore(),
  requestTimeoutMs: 30_000,
  createClient: () => {
    throw new Error("Android playback UI verification must use the Android runtime");
  },
  createRuntime: (selectedSite) => runtimeManager.getRuntime(selectedSite),
});
const ui = new DesktopSpiderUiController({ session });
const server = new DesktopSpiderUiServer({
  ui,
  siteKey,
  ext,
});

try {
  ui.confirmImport();
  await server.start();
  await ui.open(siteKey, ext);
  const search = await ui.search(keyword);
  const first = search.items[0];
  if (!first) {
    throw new Error(`Jianpian returned no search result: ${JSON.stringify({ status: search.status, error: search.error, api: search.api })}`);
  }
  const vodId = typeof first.vod_id === "string" ? first.vod_id : String(first.id ?? "");
  if (!vodId) throw new Error("Jianpian search result is missing vod_id");
  await ui.detail(vodId);
  const detail = ui.state;
  const line = detail.playbackCatalog?.lines[0];
  const episode = line?.episodes[0];
  if (!line || !episode) throw new Error("Jianpian returned no playback episode");
  const played = await ui.playEpisode(0, 0);
  const playerSource = played.player.source;
  if (!playerSource || !playerSource.url.includes("/__qx_playback/")) {
    throw new Error("The real Jianpian player did not enter the localhost proxy");
  }

  console.log(JSON.stringify({
    serverUrl: server.url,
    sourceKey: siteKey,
    sourceName: site.name ?? siteKey,
    keyword,
    searchCount: search.items.length,
    vodId,
    lineCount: detail.playbackCatalog?.lines.length ?? 0,
    episodeCount: detail.playbackCatalog?.lines.reduce((sum, current) => sum + current.episodes.length, 0) ?? 0,
    playerStatus: played.player.status,
    playerUrlIsLocalProxy: true,
    mediaType: playerSource.mediaType ?? "unknown",
    rendererHeaders: Object.keys(playerSource.headers).length,
    trace: played.player.trace,
  }, null, 2));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 120_000);
    timer.unref();
  });
} finally {
  await ui.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await runtimeManager.destroy().catch(() => undefined);
}
