import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Aria2Backend } from "../downloads/download-backend.js";
import { createMediaFixtureServer } from "./media-fixture.js";

const fixture = createMediaFixtureServer();
const directory = mkdtempSync(join(tmpdir(), "qx-aria2-smoke-"));
const targetDirectory = join(directory, "downloads");
const targetPath = join(targetDirectory, "fixture.mp4");
mkdirSync(targetDirectory);
let backend: Aria2Backend | undefined;

try {
  await fixture.start();
  backend = new Aria2Backend({
    runtimeDirectory: process.env.QX_RUNTIME_DIRECTORY?.trim() || join(process.cwd(), "dist", "electron-runtime"),
    requestTimeoutMs: 3_000,
  });
  if (!backend.available) throw new Error("bundled aria2c.exe is unavailable");
  const added = await backend.add({ url: fixture.mp4Url, targetDirectory, filename: "fixture.mp4" });
  const deadline = Date.now() + 15_000;
  let status = added;
  while (status.status !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await backend.status(added.backendId);
    if (status.status === "failed") throw new Error("aria2 failed to download the fixture");
  }
  if (status.status !== "completed" || !existsSync(targetPath) || statSync(targetPath).size === 0) {
    throw new Error(`aria2 smoke did not complete: ${JSON.stringify(status)}`);
  }
  console.log(`real_aria2_smoke=passed bytes=${statSync(targetPath).size}`);
} catch (error) {
  console.error(`real_aria2_smoke=failed ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await backend?.shutdown().catch(() => undefined);
  await fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
