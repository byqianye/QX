import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface PackagedProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function resolvePackagedExecutable(
  packageRoot = join(process.cwd(), "dist", "electron-package"),
): string {
  if (!existsSync(packageRoot)) {
    throw new Error("Windows package is missing; run npm run electron:package:win first");
  }
  const directory = readdirSync(packageRoot).find((name) => name.endsWith("-win32-x64"));
  if (!directory) throw new Error("Windows x64 package directory was not found");
  const appName = directory.slice(0, -"-win32-x64".length);
  const executable = join(packageRoot, directory, `${appName}.exe`);
  if (!existsSync(executable)) throw new Error(`Packaged executable was not found: ${executable}`);
  return executable;
}

export function runPackagedExecutable(
  executable: string,
  variables: Record<string, string>,
  args: readonly string[] = [],
): Promise<PackagedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
