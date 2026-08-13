import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface AndroidRuntimeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface AndroidRuntimeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AndroidRuntimeRunningProcess {
  readonly pid?: number;
  readonly exited: Promise<number>;
  readonly output?: () => { stdout: string; stderr: string };
  isRunning(): boolean;
  stop(): Promise<void>;
}

export interface AndroidRuntimeCommandRunner {
  run(file: string, args: readonly string[], options?: AndroidRuntimeCommandOptions): Promise<AndroidRuntimeCommandResult>;
  start(file: string, args: readonly string[], options?: Omit<AndroidRuntimeCommandOptions, "input" | "timeoutMs">): AndroidRuntimeRunningProcess;
}

export class NodeAndroidRuntimeCommandRunner implements AndroidRuntimeCommandRunner {
  public run(file: string, args: readonly string[], options: AndroidRuntimeCommandOptions = {}): Promise<AndroidRuntimeCommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(file, args, options, true);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`Android runtime command timed out: ${file}`));
          }, options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
      child.once("error", (error) => {
        if (timer) clearTimeout(timer);
        if (!settled) reject(error);
      });
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      if (options.input !== undefined && child.stdin) {
        child.stdin.end(options.input);
      }
    });
  }

  public start(file: string, args: readonly string[], options: Omit<AndroidRuntimeCommandOptions, "input" | "timeoutMs"> = {}): AndroidRuntimeRunningProcess {
    const child = this.spawn(file, args, options, false);
    let stdout = "";
    let stderr = "";
    const appendTail = (current: string, chunk: Buffer | string): string => {
      const next = current + String(chunk);
      return next.length > 16_384 ? next.slice(-16_384) : next;
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr = appendTail(stderr, chunk); });
    let running = true;
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    child.once("close", (code) => {
      running = false;
      resolveExit(code ?? 1);
    });
    child.once("error", () => {
      running = false;
      resolveExit(1);
    });
    return {
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
      exited,
      output: () => ({ stdout, stderr }),
      isRunning: () => running,
      stop: async () => {
        if (!running) return;
        if (process.platform === "win32" && typeof child.pid === "number") {
          const terminated = await terminateWindowsProcessTree(child.pid);
          if (!terminated && running) child.kill();
        } else {
          child.kill();
        }
        await exited;
      },
    };
  }

  private spawn(file: string, args: readonly string[], options: AndroidRuntimeCommandOptions, captureOutput: boolean): ChildProcess {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: captureOutput ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Windows .bat launchers need cmd.exe; native binaries remain direct.
      shell: process.platform === "win32" && /\.(?:bat|cmd)$/iu.test(file),
    });
    return child;
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  return new Promise<boolean>((resolve) => {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolve(false));
    killer.once("exit", (code) => resolve(code === 0));
  });
}
