import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const child = spawn(electronExecutable, ["."], {
  env: { ...process.env, QX_ELECTRON_SMOKE: "1" },
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`electron smoke exited with signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
