import { EventEmitter } from "node:events";

import {
  MpvBackend,
  type MpvIpcPort,
  type MpvIpcResponse,
  type MpvProcessPort,
} from "../desktop/player-backend.js";

export async function runFakeMpvExitProbe(): Promise<boolean> {
  const process = new FakeMpvProcess();
  const ipc = new FakeMpvIpc(process);
  const backend = new MpvBackend({
    mpvPath: "fake-mpv",
    fileExists: () => true,
    pipeNameFactory: () => "\\\\.\\pipe\\qx-fake-mpv-e2e",
    spawnMpv: () => process,
    createIpc: () => ipc,
  });

  try {
    await backend.load({
      parse: 0,
      url: "http://127.0.0.1:43123/__qx_playback/fake-mpv/media.m3u8",
      headers: {},
    });
    await backend.play();
    await backend.destroy();
    return ipc.commands.some((command) => command[0] === "quit")
      && ipc.closed
      && process.exited
      && process.killCalls === 0
      && backend.state.status === "stopped";
  } finally {
    await backend.destroy().catch(() => undefined);
  }
}

class FakeMpvProcess extends EventEmitter implements MpvProcessPort {
  public readonly pid = 43_219;
  public exited = false;
  public killCalls = 0;

  public kill(): boolean {
    this.killCalls += 1;
    this.exit(null, "SIGKILL");
    return true;
  }

  public exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

class FakeMpvIpc implements MpvIpcPort {
  public readonly commands: unknown[][] = [];
  public closed = false;

  public constructor(private readonly process: FakeMpvProcess) {}

  public async connect(): Promise<void> {}

  public async request(command: readonly unknown[]): Promise<MpvIpcResponse> {
    this.commands.push([...command]);
    if (command[0] === "quit") this.process.exit(0);
    return { error: "success" };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}
