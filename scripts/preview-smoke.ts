import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const projectRoot = resolve(import.meta.dirname, "..");
const executable = resolve(projectRoot, process.argv[2] ?? "release/preview/win-unpacked/QX影视.exe");
const isPortable = /Portable.*\.exe$/iu.test(executable);
const resourcesPath = isPortable ? "portable-self-extracted" : join(dirname(executable), "resources");
if (!existsSync(executable)) throw new Error(`Preview executable is missing: ${executable}`);
if (!isPortable) {
  if (!existsSync(join(resourcesPath, "app.asar"))) throw new Error("Preview app.asar is missing");
}

const workDirectory = mkdtempSync(join(tmpdir(), "qx-preview-smoke-"));
const runner = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
try {
  const result = await run(process.execPath, [runner, join(projectRoot, "src", "electron", "e2e-launch.ts")], {
    QX_PACKAGED_EXECUTABLE: executable,
  }, workDirectory);
  if (result.code !== 0) {
    throw new Error(`Preview packaged smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify({
    status: "PASS",
    executable,
    resourcesPath,
    cwd: workDirectory,
    stdout: result.stdout.slice(-2_000),
    stderr: result.stderr.slice(-2_000),
  }, null, 2));
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(executablePath: string, args: string[], variables: Record<string, string>, cwd: string): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      cwd,
      env: { ...process.env, ...variables },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}
