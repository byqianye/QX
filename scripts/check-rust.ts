import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const cargo = process.env.CARGO ?? join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
if (!existsSync(cargo)) {
  console.error(`Rust toolchain missing: ${cargo}`);
  process.exit(1);
}

const cargoBin = join(homedir(), ".cargo", "bin");
const rustupToolchains = join(homedir(), ".rustup", "toolchains");
const readyToolchain = existsSync(rustupToolchains)
  && readdirSync(rustupToolchains).some((name) => existsSync(join(rustupToolchains, name, "bin", process.platform === "win32" ? "rustc.exe" : "rustc")));
if (!readyToolchain) {
  console.error(`Rust compiler toolchain is not installed under ${rustupToolchains}`);
  process.exit(1);
}
const env = {
  ...process.env,
  Path: `${cargoBin}${delimiter}${process.env.Path ?? ""}`,
};
const manifest = join(process.cwd(), "src-tauri", "Cargo.toml");

const rustc = process.env.RUSTC ?? join(cargoBin, process.platform === "win32" ? "rustc.exe" : "rustc");
const version = spawnSync(rustc, ["--version"], { encoding: "utf8", env, windowsHide: true });
if (version.error || version.status !== 0) {
  console.error(`Rust compiler unavailable: ${String(version.stderr || version.error?.message || "unknown error").trim()}`);
  process.exit(1);
}

for (const args of [
  ["fmt", "--manifest-path", manifest, "--", "--check"],
  ["check", "--manifest-path", manifest],
]) {
  const result = spawnSync(cargo, args, { stdio: "inherit", env, windowsHide: true });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
