import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import {
  resolvePackagedExecutable,
  runPackagedExecutable,
} from "./packaged-process.js";

const workDirectory = mkdtempSync(join(tmpdir(), "qx-network-timeout-"));
const resultPath = join(workDirectory, "result.json");
const userData = join(workDirectory, "user-data");
const config = JSON.stringify({
  spider: "csp_Douban.jvm.jar",
  sites: [{ key: "douban", api: "csp_Douban", ext: "fixture" }],
});
let server: Server | undefined;

try {
  const configUrl = await startDelayedConfigServer(config);
  const processResult = await runPackagedExecutable(resolvePackagedExecutable(), {
    QX_ELECTRON_E2E: "1",
    QX_E2E_SCENARIO: "network-timeout",
    QX_ELECTRON_REQUEST_TIMEOUT_MS: "50",
    QX_E2E_CONFIG_URL: configUrl,
    QX_E2E_RESULT_PATH: resultPath,
    QX_E2E_USER_DATA: userData,
  });
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  if (processResult.code !== 0 || result.status !== "passed" || result.errorCode !== "IMPORT_FETCH_ERROR") {
    throw new Error(`Network timeout validation failed: ${JSON.stringify({ processResult, result })}`);
  }
  console.log(JSON.stringify({ probe: "packaged-network-timeout", status: "passed", result }, null, 2));
} finally {
  if (server) await closeServer(server);
  rmSync(workDirectory, { recursive: true, force: true });
}

async function startDelayedConfigServer(payload: string): Promise<string> {
  server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    }, 500);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/slow-config.json`;
}

function closeServer(target: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}
