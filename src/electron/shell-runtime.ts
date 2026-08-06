import type {
  ElectronRuntime,
  ElectronRuntimeErrorCode,
  ElectronRuntimeResolution,
} from "./runtime.js";

export interface DesktopShellServerPort {
  readonly url: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

export type DesktopShellErrorCode = ElectronRuntimeErrorCode | "UI_SERVER_START_ERROR";

export interface DesktopShellState {
  status: "idle" | "starting" | "running" | "error" | "closed";
  url: string | null;
  error: { code: DesktopShellErrorCode; message: string } | null;
}

export interface DesktopShellRuntimeOptions {
  resolveRuntime: () => ElectronRuntimeResolution;
  createServer: (runtime: ElectronRuntime) => DesktopShellServerPort;
}

export class DesktopShellRuntime {
  private readonly resolveRuntime: DesktopShellRuntimeOptions["resolveRuntime"];
  private readonly createServer: DesktopShellRuntimeOptions["createServer"];
  private stateValue: DesktopShellState = {
    status: "idle",
    url: null,
    error: null,
  };
  private server: DesktopShellServerPort | undefined;
  private startPromise: Promise<DesktopShellState> | null = null;

  public constructor(options: DesktopShellRuntimeOptions) {
    this.resolveRuntime = options.resolveRuntime;
    this.createServer = options.createServer;
  }

  public get state(): DesktopShellState {
    return {
      ...this.stateValue,
      error: this.stateValue.error ? { ...this.stateValue.error } : null,
    };
  }

  public start(): Promise<DesktopShellState> {
    if (this.stateValue.status === "running") return Promise.resolve(this.state);
    if (this.startPromise) return this.startPromise;

    this.stateValue = { status: "starting", url: null, error: null };
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  public async close(): Promise<void> {
    if (this.startPromise) await this.startPromise;
    const server = this.server;
    this.server = undefined;
    if (server) await server.close();
    this.stateValue = { status: "closed", url: null, error: null };
  }

  private async startInternal(): Promise<DesktopShellState> {
    try {
      const resolution = this.resolveRuntime();
      if (resolution.status === "error") {
        this.stateValue = {
          status: "error",
          url: null,
          error: { code: resolution.code, message: resolution.message },
        };
        return this.state;
      }

      const server = this.createServer(resolution.runtime);
      this.server = server;
      await server.start();
      this.stateValue = { status: "running", url: server.url, error: null };
      return this.state;
    } catch (error) {
      const server = this.server;
      this.server = undefined;
      if (server) {
        try {
          await server.close();
        } catch {
          // Preserve the startup error as the useful user-facing failure.
        }
      }
      this.stateValue = {
        status: "error",
        url: null,
        error: { code: "UI_SERVER_START_ERROR", message: errorMessage(error) },
      };
      return this.state;
    } finally {
      this.startPromise = null;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
