import { MpvBackend } from "../desktop/player-backend.js";

const configuredPath = process.env.QX_MPV_PATH?.trim();
if (!configuredPath) {
  console.log("real_mpv_external_environment_blocked");
} else if (!process.env.QX_MPV_SMOKE_URL?.trim()) {
  console.log("real_mpv_external_environment_blocked=QX_MPV_SMOKE_URL_missing");
} else {
  const backend = new MpvBackend({ mpvPath: configuredPath });
  const smokeUrl = process.env.QX_MPV_SMOKE_URL.trim();
  try {
    await backend.load({ parse: 0, url: smokeUrl, headers: {} });
    await backend.play();
    await backend.pause();
    await backend.destroy();
    console.log("real_mpv_smoke=passed");
  } catch (error) {
    await backend.destroy().catch(() => undefined);
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "MPV_SMOKE_ERROR";
    console.error(`real_mpv_smoke=failed code=${code}`);
    process.exitCode = 1;
  }
}
