import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  HtmlVideoBackend,
  HlsJsBackend,
  MpvBackend,
  PlayerBackendChain,
  PlayerBackendError,
  resolveMpvPath,
  type HlsFactory,
  type HlsInstancePort,
  type MediaElementPort,
  type MpvIpcPort,
  type MpvProcessPort,
  type MpvSpawn,
} from "../src/desktop/player-backend.js";
import type { PlaybackSource } from "../src/desktop/playback.js";

class FakeMedia implements MediaElementPort {
  public src = "";
  public currentTime = 0;
  public duration = 0;
  public volume = 1;
  public muted = false;
  public ended = false;
  public loadCalls = 0;
  public playCalls = 0;
  public pauseCalls = 0;
  public readonly listeners = new Map<string, Set<() => void>>();
  public nativeHls = "";

  public canPlayType(_mime: string): string {
    return this.nativeHls;
  }

  public load(): void {
    this.loadCalls += 1;
  }

  public play(): Promise<void> {
    this.playCalls += 1;
    this.dispatch("playing");
    return Promise.resolve();
  }

  public pause(): void {
    this.pauseCalls += 1;
    this.dispatch("pause");
  }

  public removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  public addEventListener(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  public removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  public dispatch(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeHls implements HlsInstancePort {
  public loadedSource = "";
  public attachedMedia: MediaElementPort | null = null;
  public destroyCalls = 0;

  public loadSource(url: string): void {
    this.loadedSource = url;
  }

  public attachMedia(media: MediaElementPort): void {
    this.attachedMedia = media;
  }

  public destroy(): void {
    this.destroyCalls += 1;
  }
}

class FakeHlsFactory implements HlsFactory {
  public readonly instances: FakeHls[] = [];

  public constructor(private readonly supported: boolean) {}

  public isSupported(): boolean {
    return this.supported;
  }

  public create(): HlsInstancePort {
    const instance = new FakeHls();
    this.instances.push(instance);
    return instance;
  }
}

class FakeProcess extends EventEmitter implements MpvProcessPort {
  public readonly pid = 43210;
  public killCalls = 0;

  public kill(_signal?: NodeJS.Signals): boolean {
    this.killCalls += 1;
    this.emit("exit", null, "SIGKILL");
    return true;
  }

  public exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

class FakeIpc implements MpvIpcPort {
  public connectCalls = 0;
  public closeCalls = 0;
  public readonly commands: readonly unknown[][] = [];
  public onRequest: ((command: readonly unknown[]) => Promise<{ error?: string; data?: unknown }> | { error?: string; data?: unknown }) | undefined;
  public requestCalls: unknown[][] = [];

  public async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  public request(command: readonly unknown[], _timeoutMs: number): Promise<{ error?: string; data?: unknown }> {
    this.requestCalls.push([...command]);
    const response = this.onRequest?.(command);
    return Promise.resolve(response ?? { error: "success" });
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const mp4: PlaybackSource = {
  parse: 0,
  url: "http://127.0.0.1:43123/media/fixture.mp4",
  headers: {},
};

const hls: PlaybackSource = {
  parse: 0,
  url: "http://127.0.0.1:43123/media/fixture.m3u8",
  headers: {},
};

function createMpv(
  overrides: {
    ipc?: FakeIpc;
    process?: FakeProcess;
    onSpawn?: (path: string, args: readonly string[], options: Parameters<MpvSpawn>[2]) => void;
    killTree?: (pid: number) => Promise<void>;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
  } = {},
): { backend: MpvBackend; ipc: FakeIpc; process: FakeProcess; spawnCalls: number } {
  const ipc = overrides.ipc ?? new FakeIpc();
  const process = overrides.process ?? new FakeProcess();
  let spawnCalls = 0;
  const spawnMpv: MpvSpawn = (path, args, options) => {
    spawnCalls += 1;
    overrides.onSpawn?.(path, args, options);
    return process;
  };
  const backend = new MpvBackend({
    mpvPath: "C:\\tools\\mpv.exe",
    fileExists: () => true,
    spawnMpv,
    createIpc: () => ipc,
    ...(overrides.killTree ? { killTree: overrides.killTree } : {}),
    ...(overrides.requestTimeoutMs !== undefined ? { requestTimeoutMs: overrides.requestTimeoutMs } : {}),
    ...(overrides.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: overrides.shutdownTimeoutMs } : {}),
  });
  return { backend, ipc, process, get spawnCalls() { return spawnCalls; } };
}

describe("player backend contract", () => {
  it("uses HTML video for direct media and exposes unified controls", async () => {
    const media = new FakeMedia();
    const backend = new HtmlVideoBackend(media);

    expect(backend.canHandle(mp4)).toBe(true);
    await backend.load(mp4);
    expect(media.src).toBe(mp4.url);
    expect(backend.state.status).toBe("loading");

    await backend.play();
    await backend.pause();
    await backend.seek(42);
    await backend.volume(0.35);
    await backend.mute(true);

    expect(media.playCalls).toBe(1);
    expect(media.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(backend.state).toMatchObject({
      status: "paused",
      currentTime: 42,
      volume: 0.35,
      muted: true,
    });

    await backend.stop();
    expect(backend.state.status).toBe("stopped");
    await backend.destroy();
  });

  it("selects hls.js only after native HTML HLS support is unavailable", async () => {
    const media = new FakeMedia();
    const factory = new FakeHlsFactory(true);
    const html = new HtmlVideoBackend(media);
    const hlsBackend = new HlsJsBackend(media, factory);
    const chain = new PlayerBackendChain([html, hlsBackend]);

    expect(html.canHandle(hls)).toBe(false);
    expect(hlsBackend.canHandle(hls)).toBe(true);
    await chain.load(hls);

    expect(chain.activeKind).toBe("hls-js");
    expect(factory.instances).toHaveLength(1);
    expect(factory.instances[0]?.loadedSource).toBe(hls.url);
    await chain.destroy();
    expect(factory.instances[0]?.destroyCalls).toBe(1);
  });

  it("falls back to mpv without making mpv the default backend", async () => {
    const media = new FakeMedia();
    const factory = new FakeHlsFactory(false);
    const { backend: mpv, ipc } = createMpv();
    const chain = new PlayerBackendChain([
      new HtmlVideoBackend(media),
      new HlsJsBackend(media, factory),
      mpv,
    ]);

    await chain.load(hls);

    expect(chain.activeKind).toBe("mpv");
    expect(ipc.requestCalls[0]).toEqual(["loadfile", hls.url, "replace"]);
    await chain.destroy();
  });

  it("resolves user, environment, then controlled development paths", () => {
    const exists = (value: string) => value === "probe" || value === "env" || value === "user";

    expect(resolveMpvPath({
      mpvPath: "user",
      env: { QX_MPV_PATH: "env" },
      probePaths: ["probe"],
      exists,
    })).toBe("user");
    expect(resolveMpvPath({
      env: { QX_MPV_PATH: "env" },
      probePaths: ["probe"],
      exists,
    })).toBe("env");
    expect(resolveMpvPath({
      env: {},
      probePaths: ["probe"],
      exists,
    })).toBe("probe");
    expect(resolveMpvPath({ env: {}, probePaths: [], exists: () => false })).toBeNull();
  });

  it("starts one isolated mpv process with argument arrays and IPC commands", async () => {
    const calls: { path: string; args: readonly string[]; shell: false }[] = [];
    const fixture = createMpv({
      onSpawn: (path, args, options) => calls.push({ path, args, shell: options.shell }),
    });

    await fixture.backend.load({ ...mp4, url: "http://127.0.0.1:43123/__qx_playback/session/media.mp4" });
    await fixture.backend.play();
    await fixture.backend.pause();
    await fixture.backend.seek(12);
    await fixture.backend.volume(0.4);
    await fixture.backend.mute(true);

    expect(fixture.spawnCalls).toBe(1);
    expect(calls[0]?.path).toBe("C:\\tools\\mpv.exe");
    expect(calls[0]?.shell).toBe(false);
    expect(calls[0]?.args).toContain("--idle=yes");
    expect(calls[0]?.args.some((arg) => arg.startsWith("--input-ipc-server=\\\\.\\pipe\\qx-mpv-"))).toBe(true);
    expect(calls[0]?.args.some((arg) => arg.includes("Cookie") || arg.includes("Authorization") || arg.includes("Referer"))).toBe(false);
    expect(fixture.ipc.requestCalls).toEqual([
      ["loadfile", "http://127.0.0.1:43123/__qx_playback/session/media.mp4", "replace"],
      ["set_property", "pause", false],
      ["set_property", "pause", true],
      ["seek", 12, "absolute+exact"],
      ["set_property", "volume", 40],
      ["set_property", "mute", true],
    ]);

    await fixture.backend.destroy();
    expect(fixture.ipc.closeCalls).toBe(1);
  });

  it("loads only proxy subtitle tracks through mpv IPC", async () => {
    const fixture = createMpv();
    await fixture.backend.load({
      ...mp4,
      url: "http://127.0.0.1:43123/__qx_playback/session/media.mp4",
      subtitles: [{
        id: "zh",
        label: "中文",
        language: "zh-CN",
        format: "vtt",
        url: "http://127.0.0.1:43123/__qx_playback/session/zh.vtt",
        default: true,
        forced: false,
      }],
    });
    expect(fixture.ipc.requestCalls).toContainEqual([
      "sub-add",
      "http://127.0.0.1:43123/__qx_playback/session/zh.vtt",
      "select",
    ]);
    await fixture.backend.destroy();

    const unsupported = createMpv();
    await expect(unsupported.backend.load({
      ...mp4,
      subtitles: [{
        id: "ass",
        label: "ASS",
        language: "und",
        format: "ass",
        url: "http://127.0.0.1:43123/__qx_playback/session/ass.ass",
        default: false,
        forced: false,
      }],
    })).rejects.toMatchObject({ code: "MPV_SUBTITLE_FORMAT_UNSUPPORTED" });
    expect(unsupported.spawnCalls).toBe(0);
  });

  it("rejects missing mpv without attempting a download or spawn", async () => {
    const backend = new MpvBackend({
      mpvPath: "C:\\missing\\mpv.exe",
      fileExists: () => false,
      spawnMpv: () => { throw new Error("must not spawn"); },
      createIpc: () => new FakeIpc(),
    });

    await expect(backend.load(hls)).rejects.toMatchObject({ code: "MPV_UNAVAILABLE" });
    expect(backend.state.error?.code).toBe("MPV_UNAVAILABLE");
  });

  it("reports process crashes and request timeouts as stable errors", async () => {
    const fixture = createMpv({ requestTimeoutMs: 10, shutdownTimeoutMs: 5 });
    await fixture.backend.load(mp4);
    fixture.process.exit(1, "SIGTERM");
    expect(fixture.backend.state).toMatchObject({ status: "error", error: { code: "MPV_PROCESS_EXITED" } });

    const timeoutIpc = new FakeIpc();
    timeoutIpc.onRequest = () => new Promise<{ error?: string; data?: unknown }>(() => undefined);
    const timeoutFixture = createMpv({ ipc: timeoutIpc, requestTimeoutMs: 10, shutdownTimeoutMs: 5 });
    await expect(timeoutFixture.backend.load(mp4)).rejects.toMatchObject({ code: "MPV_TIMEOUT" });
    expect(timeoutFixture.backend.state.error?.code).toBe("MPV_TIMEOUT");
    await timeoutFixture.backend.destroy();
  });

  it("waits for normal exit and force-kills an unresponsive process tree", async () => {
    const normal = createMpv({ shutdownTimeoutMs: 10 });
    normal.ipc.onRequest = (command) => {
      if (command[0] === "quit") normal.process.exit(0);
      return { error: "success" };
    };
    await normal.backend.load(mp4);
    await normal.backend.destroy();
    expect(normal.process.killCalls).toBe(0);

    let killTreeCalls = 0;
    const forced = createMpv({
      shutdownTimeoutMs: 5,
      killTree: async (pid) => {
        expect(pid).toBe(43210);
        killTreeCalls += 1;
      },
    });
    await forced.backend.load(mp4);
    await forced.backend.destroy();
    expect(killTreeCalls).toBe(1);
  });

  it("keeps headered sources on LocalProxy instead of passing headers to mpv", async () => {
    const fixture = createMpv();

    await expect(fixture.backend.load({
      ...mp4,
      headers: { Cookie: "secret", Authorization: "Bearer secret" },
    })).rejects.toMatchObject({ code: "MPV_PROXY_REQUIRED" });
    expect(fixture.spawnCalls).toBe(0);
    expect(fixture.ipc.requestCalls).toHaveLength(0);
  });

  it("uses a typed backend error for unsupported controls before load", async () => {
    const backend = new HtmlVideoBackend(new FakeMedia());

    await expect(backend.play()).rejects.toBeInstanceOf(PlayerBackendError);
    await expect(backend.play()).rejects.toMatchObject({ code: "PLAYBACK_NOT_LOADED" });
  });
});
