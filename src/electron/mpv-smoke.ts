import { MpvBackend } from "../desktop/player-backend.js";
import { createMediaFixtureServer } from "./media-fixture.js";
import { join } from "node:path";

const configuredPath = process.env.QX_MPV_PATH?.trim();
const runtimeDirectory = process.env.QX_RUNTIME_DIRECTORY?.trim() ?? join(process.cwd(), "dist", "electron-runtime");
const fixture = createMediaFixtureServer();
const backend = new MpvBackend({
  ...(configuredPath ? { mpvPath: configuredPath } : { runtimeDirectory }),
});
try {
  await fixture.start();
  const smokeUrl = process.env.QX_MPV_SMOKE_URL?.trim() || fixture.mp4Url;
  await backend.load({ parse: 0, url: smokeUrl, headers: {} });
  await backend.play();
  await backend.pause();
  await backend.destroy();
  console.log(`real_mpv_smoke=passed path=${backend.path}`);
} catch (error) {
  await backend.destroy().catch(() => undefined);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "MPV_SMOKE_ERROR";
  console.error(`real_mpv_smoke=failed code=${code}`);
  process.exitCode = 1;
} finally {
  await fixture.close();
}
