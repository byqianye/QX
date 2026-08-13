import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version?: string };
const version = packageJson.version ?? "";
if (!/^\d+\.\d+\.\d+-rc\.\d+$/u.test(version)) throw new Error(`RC version is not a release-candidate semver: ${version}`);

if (process.env.QX_RC_SKIP_BUILD !== "1") {
  run("npm.cmd", ["run", "rc:build"]);
  run(join(projectRoot, "node_modules", ".bin", "electron-builder.cmd"), ["--config", "electron-builder.rc.yml", "--win", "nsis", "--x64"]);
  run(join(projectRoot, "node_modules", ".bin", "electron-builder.cmd"), ["--config", "electron-builder.rc.yml", "--win", "portable", "--x64"]);
}

const output = join(projectRoot, "release", "rc");
mkdirSync(output, { recursive: true });
const files = [
  join(output, `QX影视-RC-Setup-${version}-x64.exe`),
  join(output, `QX影视-RC-Portable-${version}-x64.exe`),
];
if (files.some((path) => !existsSync(path))) throw new Error(`RC artifacts are missing: ${files.join(", ")}`);

const sums = files.map((path) => `${hash(path)}  ${path.slice(output.length + 1)}`);
writeFileSync(join(output, "SHA256SUMS.txt"), `${sums.join("\n")}\n`, "utf8");
writeFileSync(join(output, "RELEASE-NOTES-RC.md"), readFileSync(join(projectRoot, "RELEASE-NOTES-RC.md"), "utf8"), "utf8");
writeFileSync(join(projectRoot, "WINDOWS-RC-BUILD-REPORT.md"), [
  "# QX影视 Windows Release Candidate V1",
  "",
  `Version: ${version}`,
  "Channel: RC",
  "",
  "| Artifact | Size | SHA256 |",
  "| --- | ---: | --- |",
  ...files.map((path) => `| ${path.slice(projectRoot.length + 1)} | ${statSync(path).size} | ${hash(path)} |`),
  "",
  "Signed: NO (code signing certificate was not supplied)",
  "",
  "Final build gate: PASS",
  "",
].join("\n"), "utf8");

console.log(JSON.stringify({
  status: "PASS",
  version,
  output,
  artifacts: files.map((path) => ({ path, size: statSync(path).size, sha256: hash(path) })),
  sums: join(output, "SHA256SUMS.txt"),
  releaseNotes: join(output, "RELEASE-NOTES-RC.md"),
}, null, 2));

function run(command: string, args: string[]): void {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")], {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
    })
    : spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function quoteWindowsArg(value: string): string {
  return /[\s"&|<>^]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}
