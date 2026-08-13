import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = join(process.cwd(), "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(cli)) {
  console.error(`Tauri CLI missing: ${cli}`);
  process.exit(1);
}

const cargoBin = join(homedir(), ".cargo", "bin");
const args = process.argv.slice(2);
const envScript = join(process.cwd(), "scripts", "tauri-env.cmd");
const command = existsSync(envScript)
  ? ["scripts\\tauri-env.cmd", ...args].join(" ")
  : `"${process.execPath}" "${cli}" ${args.map(quoteCmdArg).join(" ")}`;
const result = spawnSync(process.platform === "win32" ? "cmd.exe" : process.execPath,
  process.platform === "win32" ? ["/d", "/c", command] : [cli, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    Path: `${cargoBin}${delimiter}${process.env.Path ?? ""}`,
  },
  windowsHide: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

function quoteCmdArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
