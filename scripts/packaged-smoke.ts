import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolve(projectRoot, process.argv[2] ?? join("release", "win-unpacked", "QX影视.exe"));
if (!existsSync(executable)) {
  throw new Error(`Packaged executable is missing: ${executable}`);
}

const runner = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const result = spawnSync(process.execPath, [runner, join(projectRoot, "src", "electron", "e2e-launch.ts")], {
  cwd: projectRoot,
  env: { ...process.env, QX_PACKAGED_EXECUTABLE: executable },
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
