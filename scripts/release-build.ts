import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm run electron:build"]
  : ["run", "electron:build"];
const pinnedJdk = join(projectRoot, "dist", "release-assets", "temurin-jdk", "jdk-21.0.7+6");
const result = spawnSync(command, args, {
  env: {
    ...process.env,
    QX_RELEASE_BUILD: "1",
    ...(process.env.QX_TEMURIN_JDK || !existsSync(join(pinnedJdk, "bin", "java.exe"))
      ? {}
      : { QX_TEMURIN_JDK: pinnedJdk }),
  },
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
