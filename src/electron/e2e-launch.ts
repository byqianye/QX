import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { defaultDoubanEndpoint } from "../spikes/douban-probe.js";
import {
  resolvePackagedExecutable,
  runPackagedExecutable,
  type PackagedProcessResult,
} from "./packaged-process.js";
import { createMediaFixtureServer } from "./media-fixture.js";

const config = JSON.stringify({
  spider: "csp_Douban.jvm.jar",
  sites: [{
    key: "douban",
    name: "Douban",
    type: 3,
    api: "csp_Douban",
    ext: process.env.QX_DOUBAN_ENDPOINT ?? defaultDoubanEndpoint,
  }],
});
const workDirectory = mkdtempSync(join(tmpdir(), "qx-packaged-e2e-"));
const configFile = join(workDirectory, "config.json");
const userData = join(workDirectory, "user-data");
const firstResult = join(workDirectory, "first-result.json");
const secondResult = join(workDirectory, "second-result.json");
writeFileSync(configFile, config, "utf8");

let configServer: Server | undefined;
const mediaFixture = createMediaFixtureServer();

try {
  await mediaFixture.start();
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
  const executable = resolvePackagedExecutable();
  const first = await runPackagedExecutable(executable, {
    QX_ELECTRON_E2E: "1",
    QX_E2E_CONFIG_URL: configUrl,
    QX_E2E_CONFIG_FILE: configFile,
    QX_E2E_CONFIG_JSON: config,
    QX_E2E_FRESH_TRUST: "1",
    QX_E2E_RESULT_PATH: firstResult,
    QX_E2E_USER_DATA: userData,
    QX_E2E_PLAYBACK_CONFIG: playbackConfig,
    QX_PLAYBACK_PROXY_ORIGINS: mediaFixture.baseUrl,
  });
  const firstResultValue = readResult(firstResult);
  assertRun("first packaged E2E", first, firstResultValue);

  const second = await runPackagedExecutable(executable, {
    QX_ELECTRON_E2E: "1",
    QX_E2E_CONFIG_URL: configUrl,
    QX_E2E_CONFIG_FILE: configFile,
    QX_E2E_CONFIG_JSON: config,
    QX_E2E_FRESH_TRUST: "0",
    QX_E2E_RESULT_PATH: secondResult,
    QX_E2E_USER_DATA: userData,
    QX_E2E_PLAYBACK_CONFIG: playbackConfig,
    QX_PLAYBACK_PROXY_ORIGINS: mediaFixture.baseUrl,
  });
  const secondResultValue = readResult(secondResult);
  assertRun("restarted packaged E2E", second, secondResultValue);

  console.log(JSON.stringify({
    probe: "packaged-electron-e2e",
    status: "passed",
    first: firstResultValue,
    restarted: secondResultValue,
  }, null, 2));
} finally {
  if (configServer) await closeServer(configServer);
  await mediaFixture.close();
  rmSync(workDirectory, { recursive: true, force: true });
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

function assertRun(name: string, process: PackagedProcessResult, result: Record<string, unknown>): void {
  if (process.code !== 0 || result.status !== "passed") {
    throw new Error(`${name} failed: ${JSON.stringify({ process, result })}`);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
