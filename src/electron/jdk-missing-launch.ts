import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { defaultDoubanEndpoint } from "../spikes/douban-probe.js";
import {
  resolvePackagedExecutable,
  runPackagedExecutable,
} from "./packaged-process.js";

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
const workDirectory = mkdtempSync(join(tmpdir(), "qx-jre-runtime-"));
const configFile = join(workDirectory, "config.json");
const configUserData = join(workDirectory, "config-user-data");
const noSystemJdkResult = join(workDirectory, "no-system-jdk-result.json");
const missingJreResult = join(workDirectory, "missing-jre-result.json");
writeFileSync(configFile, config, "utf8");

let configServer: Server | undefined;

try {
  const configUrl = await startConfigServer(config);
  const executable = resolvePackagedExecutable();
  const noSystemJdk = await runPackagedExecutable(executable, {
    QX_ELECTRON_E2E: "1",
    QX_ELECTRON_FORCE_NO_EXTERNAL_JAVA: "1",
    QX_E2E_CONFIG_URL: configUrl,
    QX_E2E_CONFIG_FILE: configFile,
    QX_E2E_CONFIG_JSON: config,
    QX_E2E_FRESH_TRUST: "1",
    QX_E2E_RESULT_PATH: noSystemJdkResult,
    QX_E2E_USER_DATA: configUserData,
  });
  const noSystemJdkValue = readResult(noSystemJdkResult);
  if (noSystemJdk.code !== 0 || noSystemJdkValue.status !== "passed") {
    throw new Error(`No-system-JDK validation failed: ${JSON.stringify({ noSystemJdk, noSystemJdkValue })}`);
  }

  const missingJre = await runPackagedExecutable(executable, {
    QX_ELECTRON_E2E: "1",
    QX_ELECTRON_FORCE_NO_EXTERNAL_JAVA: "1",
    QX_ELECTRON_FORCE_NO_BUNDLED_JRE: "1",
    QX_E2E_RESULT_PATH: missingJreResult,
    QX_E2E_USER_DATA: join(workDirectory, "missing-jre-user-data"),
  });
  const missingJreValue = readResult(missingJreResult);
  if (missingJre.code !== 0
    || missingJreValue.status !== "blocked"
    || missingJreValue.reason !== "JAVA_RUNTIME_NOT_FOUND") {
    throw new Error(`Missing bundled JRE validation failed: ${JSON.stringify({ missingJre, missingJreValue })}`);
  }

  console.log(JSON.stringify({
    probe: "packaged-jre-runtime",
    status: "passed",
    noSystemJdk: noSystemJdkValue,
    missingJre: missingJreValue,
  }, null, 2));
} finally {
  if (configServer) await closeServer(configServer);
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

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
