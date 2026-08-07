import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn as nodeSpawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import {
  EmbeddedPlaybackController,
  validatePlaybackSource,
  type PlaybackError,
  type PlaybackSource,
  type PlaybackState,
} from "./playback.js";

export type PlayerBackendKind = "html-video" | "hls-js" | "mpv";

export interface MediaElementPort {
  src: string;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  ended: boolean;
  canPlayType(mime: string): string;
  load(): void;
  play(): Promise<void> | void;
  pause(): void;
  removeAttribute(name: string): void;
  addEventListener(event: string, listener: () => void): void;
  removeEventListener(event: string, listener: () => void): void;
}

export interface HlsInstancePort {
  loadSource(url: string): void;
  attachMedia(media: MediaElementPort): void;
  destroy(): void | Promise<void>;
}

export interface HlsFactory {
  isSupported(): boolean;
  create(): HlsInstancePort;
}

export interface PlayerBackend {
  readonly kind: PlayerBackendKind;
  readonly state: PlaybackState;
  readonly currentTime: number;
  readonly duration: number;
  readonly error: PlaybackError | null;
  canHandle(source: PlaybackSource): boolean;
  load(source: PlaybackSource): Promise<PlaybackState>;
  play(): Promise<PlaybackState>;
  pause(): Promise<PlaybackState>;
  stop(): Promise<PlaybackState>;
  seek(currentTime: number): Promise<PlaybackState>;
  volume(value: number): Promise<PlaybackState>;
  mute(value: boolean): Promise<PlaybackState>;
  destroy(): Promise<void>;
}

export class PlayerBackendError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PlayerBackendError";
    this.code = code;
  }
}

abstract class ControllerBackedBackend implements PlayerBackend {
  protected readonly controller = new EmbeddedPlaybackController();
  protected destroyed = false;

  public abstract readonly kind: PlayerBackendKind;

  public get state(): PlaybackState {
    return this.controller.state;
  }

  public get currentTime(): number {
    return this.controller.state.currentTime;
  }

  public get duration(): number {
    return this.controller.state.duration;
  }

  public get error(): PlaybackError | null {
    return this.controller.state.error;
  }

  public abstract canHandle(source: PlaybackSource): boolean;
  public abstract load(source: PlaybackSource): Promise<PlaybackState>;
  public abstract play(): Promise<PlaybackState>;
  public abstract pause(): Promise<PlaybackState>;
  public abstract stop(): Promise<PlaybackState>;
  public abstract seek(currentTime: number): Promise<PlaybackState>;
  public abstract volume(value: number): Promise<PlaybackState>;
  public abstract mute(value: boolean): Promise<PlaybackState>;
  public abstract destroy(): Promise<void>;

  protected ensureUsable(): void {
    if (this.destroyed) throw this.fail("PLAYER_BACKEND_DESTROYED", "The player backend has been destroyed.");
  }

  protected ensureLoaded(): void {
    if (!this.controller.state.source) throw this.fail("PLAYBACK_NOT_LOADED", "No playback source is loaded.");
  }

  protected loadController(source: PlaybackSource): PlaybackState {
    const validation = validatePlaybackSource(source);
    if (validation) throw this.fail(validation.code, validation.message);
    return this.controller.load(source);
  }

  protected fail(code: string, message: string): PlayerBackendError {
    this.controller.markError(code, message);
    return new PlayerBackendError(code, message);
  }
}

abstract class MediaBackend extends ControllerBackedBackend {
  private readonly listeners: Array<{ event: string; listener: () => void }> = [];

  protected constructor(
    protected readonly media: MediaElementPort,
    private readonly mediaErrorCode: string,
  ) {
    super();
  }

  public async load(source: PlaybackSource): Promise<PlaybackState> {
    this.ensureUsable();
    await this.disposeMediaSource();
    this.clearMediaElement();
    const state = this.loadController(source);
    this.bindMediaListeners();
    try {
      await this.loadMediaSource(source);
      return state;
    } catch (error) {
      this.detachMediaListeners();
      this.clearMediaElement();
      if (error instanceof PlayerBackendError) {
        throw error;
      }
      throw this.fail(this.mediaErrorCode, "The media backend could not load the source.");
    }
  }

  public async play(): Promise<PlaybackState> {
    this.ensureUsable();
    this.ensureLoaded();
    try {
      await Promise.resolve(this.media.play());
      return this.controller.markPlaying();
    } catch (error) {
      throw this.fail(
        this.kind === "html-video" ? "HTML_VIDEO_PLAY_ERROR" : "HLS_ERROR",
        error instanceof Error ? safeControlMessage(error.message) : "The media could not start.",
      );
    }
  }

  public async pause(): Promise<PlaybackState> {
    this.ensureUsable();
    this.ensureLoaded();
    try {
      this.media.pause();
      return this.controller.markPaused();
    } catch (error) {
      throw this.fail(this.mediaErrorCode, "The media backend could not pause the source.");
    }
  }

  public async stop(): Promise<PlaybackState> {
    if (this.destroyed) return this.controller.stop();
    this.detachMediaListeners();
    await this.disposeMediaSource();
    this.clearMediaElement();
    return this.controller.stop();
  }

  public async seek(currentTime: number): Promise<PlaybackState> {
    this.ensureUsable();
    this.ensureLoaded();
    const state = this.controller.seek(currentTime);
    try {
      this.media.currentTime = state.currentTime;
      return this.controller.state;
    } catch (error) {
      throw this.fail(this.mediaErrorCode, "The media backend could not seek the source.");
    }
  }

  public async volume(value: number): Promise<PlaybackState> {
    this.ensureUsable();
    const state = this.controller.setVolume(value);
    try {
      this.media.volume = state.volume;
      return this.controller.state;
    } catch (error) {
      throw this.fail(this.mediaErrorCode, "The media backend could not change volume.");
    }
  }

  public async mute(value: boolean): Promise<PlaybackState> {
    this.ensureUsable();
    const state = this.controller.setMuted(value);
    try {
      this.media.muted = state.muted;
      return this.controller.state;
    } catch (error) {
      throw this.fail(this.mediaErrorCode, "The media backend could not change mute state.");
    }
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.stop();
    this.destroyed = true;
  }

  protected abstract loadMediaSource(source: PlaybackSource): Promise<void> | void;

  protected async disposeMediaSource(): Promise<void> {}

  private bindMediaListeners(): void {
    this.detachMediaListeners();
    this.addMediaListener("playing", () => {
      if (this.controller.state.source) this.controller.markPlaying();
    });
    this.addMediaListener("pause", () => {
      if (this.controller.state.source && !this.media.ended) this.controller.markPaused();
    });
    this.addMediaListener("ended", () => {
      if (this.controller.state.source) this.controller.markEnded();
    });
    this.addMediaListener("durationchange", () => {
      if (Number.isFinite(this.media.duration)) this.controller.setDuration(this.media.duration);
    });
    this.addMediaListener("timeupdate", () => {
      if (Number.isFinite(this.media.currentTime)) this.controller.seek(this.media.currentTime);
    });
    this.addMediaListener("error", () => {
      if (this.controller.state.source) this.controller.markError(this.mediaErrorCode, "The media source reported an error.");
    });
  }

  private addMediaListener(event: string, listener: () => void): void {
    this.media.addEventListener(event, listener);
    this.listeners.push({ event, listener });
  }

  private detachMediaListeners(): void {
    for (const { event, listener } of this.listeners.splice(0)) {
      this.media.removeEventListener(event, listener);
    }
  }

  private clearMediaElement(): void {
    try {
      this.media.pause();
    } catch {}
    this.media.removeAttribute("src");
    this.media.load();
  }
}

export class HtmlVideoBackend extends MediaBackend {
  public readonly kind = "html-video" as const;

  public constructor(media: MediaElementPort) {
    super(media, "HTML_VIDEO_ERROR");
  }

  public canHandle(source: PlaybackSource): boolean {
    if (this.destroyed || !isBrowserSource(source)) return false;
    if (!isHlsUrl(source.url)) return true;
    return this.media.canPlayType("application/vnd.apple.mpegurl") !== "";
  }

  protected loadMediaSource(source: PlaybackSource): void {
    this.media.src = source.url;
    this.media.load();
  }
}

export class HlsJsBackend extends MediaBackend {
  public readonly kind = "hls-js" as const;
  private hls: HlsInstancePort | undefined;

  public constructor(
    media: MediaElementPort,
    private readonly factory: HlsFactory,
  ) {
    super(media, "HLS_ERROR");
  }

  public canHandle(source: PlaybackSource): boolean {
    if (this.destroyed || !isBrowserSource(source) || !isHlsUrl(source.url)) return false;
    try {
      return this.factory.isSupported();
    } catch {
      return false;
    }
  }

  protected loadMediaSource(source: PlaybackSource): void {
    try {
      this.hls = this.factory.create();
      this.hls.loadSource(source.url);
      this.hls.attachMedia(this.media);
    } catch {
      throw this.fail("HLS_ERROR", "The hls.js backend could not load the source.");
    }
  }

  protected async disposeMediaSource(): Promise<void> {
    const hls = this.hls;
    this.hls = undefined;
    if (hls) await hls.destroy();
  }
}

export class PlayerBackendChain extends ControllerBackedBackend {
  public readonly kind = "html-video" as const;
  private readonly idleController = new EmbeddedPlaybackController();
  private active: PlayerBackend | null = null;

  public constructor(private readonly backends: readonly PlayerBackend[]) {
    super();
  }

  public get activeKind(): PlayerBackendKind | null {
    return this.active?.kind ?? null;
  }

  public get state(): PlaybackState {
    return this.active?.state ?? this.idleController.state;
  }

  public get currentTime(): number {
    return this.state.currentTime;
  }

  public get duration(): number {
    return this.state.duration;
  }

  public get error(): PlaybackError | null {
    return this.state.error;
  }

  public canHandle(source: PlaybackSource): boolean {
    return this.backends.some((backend) => backend.canHandle(source));
  }

  public async load(source: PlaybackSource): Promise<PlaybackState> {
    this.ensureUsable();
    const validation = validatePlaybackSource(source);
    if (validation) throw this.fail(validation.code, validation.message);
    if (this.active) {
      await this.active.stop().catch(() => undefined);
      this.active = null;
    }

    let lastError: PlayerBackendError | null = null;
    for (const backend of this.backends) {
      if (!backend.canHandle(source)) continue;
      try {
        const state = await backend.load(source);
        this.active = backend;
        return state;
      } catch (error) {
        lastError = error instanceof PlayerBackendError
          ? error
          : new PlayerBackendError("PLAYER_BACKEND_ERROR", "The player backend failed to load the source.");
        await backend.destroy().catch(() => undefined);
      }
    }
    if (lastError) {
      this.idleController.markError(lastError.code, lastError.message);
      throw lastError;
    }
    throw this.fail(
      "PLAYER_BACKEND_UNAVAILABLE",
      "No configured player backend can play this source.",
    );
  }

  public async play(): Promise<PlaybackState> {
    return this.delegate((backend) => backend.play());
  }

  public async pause(): Promise<PlaybackState> {
    return this.delegate((backend) => backend.pause());
  }

  public async stop(): Promise<PlaybackState> {
    if (!this.active) return this.idleController.stop();
    return this.active.stop();
  }

  public async seek(currentTime: number): Promise<PlaybackState> {
    return this.delegate((backend) => backend.seek(currentTime));
  }

  public async volume(value: number): Promise<PlaybackState> {
    return this.delegate((backend) => backend.volume(value));
  }

  public async mute(value: boolean): Promise<PlaybackState> {
    return this.delegate((backend) => backend.mute(value));
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    for (const backend of this.backends) await backend.destroy();
    this.active = null;
    this.destroyed = true;
  }

  private async delegate(
    action: (backend: PlayerBackend) => Promise<PlaybackState>,
  ): Promise<PlaybackState> {
    this.ensureUsable();
    if (!this.active) throw this.fail("PLAYBACK_NOT_LOADED", "No playback source is loaded.");
    return action(this.active);
  }
}

export interface MpvPathResolutionOptions {
  mpvPath?: string;
  env?: NodeJS.ProcessEnv;
  runtimeDirectory?: string;
  probePaths?: readonly string[];
  exists?: (path: string) => boolean;
}

export function resolveMpvPath(options: MpvPathResolutionOptions = {}): string | null {
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const configured = nonEmpty(options.mpvPath);
  if (configured) return exists(configured) ? configured : null;
  const environmentPath = nonEmpty(env.QX_MPV_PATH);
  if (environmentPath) return exists(environmentPath) ? environmentPath : null;
  const bundledPath = nonEmpty(options.runtimeDirectory ?? env.QX_RUNTIME_DIRECTORY);
  if (bundledPath) {
    const candidate = join(bundledPath, "mpv", "mpv.exe");
    if (exists(candidate)) return candidate;
  }
  for (const candidate of options.probePaths ?? defaultMpvProbePaths(env)) {
    if (nonEmpty(candidate) && exists(candidate)) return candidate;
  }
  return null;
}

export interface MpvProcessPort {
  pid?: number | null | undefined;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: string | symbol, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface MpvSpawnOptions {
  shell: false;
  windowsHide: true;
  stdio: ["ignore", "ignore", "ignore"];
}

export type MpvSpawn = (
  file: string,
  args: readonly string[],
  options: MpvSpawnOptions,
) => MpvProcessPort;

export interface MpvIpcResponse {
  error?: string;
  data?: unknown;
}

export interface MpvIpcPort {
  connect(): Promise<void>;
  request(command: readonly unknown[], timeoutMs: number): Promise<MpvIpcResponse>;
  close(): Promise<void>;
}

export interface MpvBackendOptions extends MpvPathResolutionOptions {
  fileExists?: (path: string) => boolean;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pipeNameFactory?: () => string;
  spawnMpv?: MpvSpawn;
  createIpc?: (endpoint: string) => MpvIpcPort;
  killTree?: (pid: number) => Promise<void>;
}

export class MpvBackend extends ControllerBackedBackend {
  public readonly kind = "mpv" as const;
  private readonly executablePath: string | null;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly pipeNameFactory: () => string;
  private readonly spawnMpv: MpvSpawn;
  private readonly createIpc: (endpoint: string) => MpvIpcPort;
  private readonly killTree: (pid: number) => Promise<void>;
  private process: MpvProcessPort | undefined;
  private ipc: MpvIpcPort | undefined;
  private processExited = false;
  private processStarting: Promise<void> | undefined;
  private destroyPromise: Promise<void> | undefined;
  private destroying = false;

  public constructor(options: MpvBackendOptions = {}) {
    super();
    this.executablePath = resolveMpvPath({
      ...options,
      ...(options.fileExists ? { exists: options.fileExists } : {}),
    });
    this.requestTimeoutMs = positive(options.requestTimeoutMs, 5_000);
    this.shutdownTimeoutMs = positive(options.shutdownTimeoutMs, 750);
    this.pipeNameFactory = options.pipeNameFactory ?? createMpvEndpoint;
    this.spawnMpv = options.spawnMpv ?? defaultMpvSpawn;
    this.createIpc = options.createIpc ?? ((endpoint) => new SocketMpvIpc(endpoint));
    this.killTree = options.killTree ?? defaultKillTree;
  }

  public get available(): boolean {
    return this.executablePath !== null;
  }

  public get path(): string | null {
    return this.executablePath;
  }

  public canHandle(source: PlaybackSource): boolean {
    return !this.destroyed && isDirectSource(source);
  }

  public async load(source: PlaybackSource): Promise<PlaybackState> {
    this.ensureUsable();
    if (Object.keys(source.headers).length > 0) {
      throw this.fail("MPV_PROXY_REQUIRED", "Headered playback must use the LocalProxy URL.");
    }
    for (const track of source.subtitles ?? []) {
      if (track.headers && Object.keys(track.headers).length > 0
        || track.localPath
        || !track.url
        || !/^https?:\/\//i.test(track.url)) {
        throw this.fail("MPV_PROXY_REQUIRED", "远程字幕必须先经过 LocalProxy。");
      }
      if (track.format === "ass" || track.format === "ssa") {
        throw this.fail("MPV_SUBTITLE_FORMAT_UNSUPPORTED", "mpv 后端只接受已转换的 WebVTT/SRT 字幕。");
      }
    }
    const validation = validatePlaybackSource(source);
    if (validation) throw this.fail(validation.code, validation.message);
    if (!this.executablePath) throw this.fail("MPV_UNAVAILABLE", "mpv is not available on this development machine.");
    try {
      await this.ensureProcess();
      await this.command(["loadfile", source.url, "replace"]);
      for (const track of source.subtitles ?? []) {
        await this.command(["sub-add", track.url, track.default ? "select" : "auto"]);
      }
      return this.controller.load(source);
    } catch (error) {
      if (error instanceof PlayerBackendError) throw error;
      throw this.fail("MPV_IPC_ERROR", "mpv IPC could not load the source.");
    }
  }

  public async play(): Promise<PlaybackState> {
    return this.runLoadedCommand(["set_property", "pause", false], () => this.controller.play());
  }

  public async pause(): Promise<PlaybackState> {
    return this.runLoadedCommand(["set_property", "pause", true], () => this.controller.pause());
  }

  public async stop(): Promise<PlaybackState> {
    this.ensureUsable();
    if (!this.controller.state.source) return this.controller.stop();
    if (!this.processExited && this.ipc) await this.command(["stop"]);
    return this.controller.stop();
  }

  public async seek(currentTime: number): Promise<PlaybackState> {
    this.ensureLoaded();
    const state = this.controller.seek(currentTime);
    return this.runLoadedCommand(
      ["seek", state.currentTime, "absolute+exact"],
      () => this.controller.seek(state.currentTime),
    );
  }

  public async volume(value: number): Promise<PlaybackState> {
    this.ensureLoaded();
    const state = this.controller.setVolume(value);
    return this.runLoadedCommand(
      ["set_property", "volume", Math.round(state.volume * 100)],
      () => this.controller.setVolume(state.volume),
    );
  }

  public async mute(value: boolean): Promise<PlaybackState> {
    this.ensureLoaded();
    const state = this.controller.setMuted(value);
    return this.runLoadedCommand(
      ["set_property", "mute", state.muted],
      () => this.controller.setMuted(state.muted),
    );
  }

  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.destroyInternal();
    return this.destroyPromise;
  }

  private async ensureProcess(): Promise<void> {
    if (this.process && !this.processExited) return;
    if (this.processStarting) return this.processStarting;
    this.processStarting = this.startProcess();
    try {
      await this.processStarting;
    } finally {
      this.processStarting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    const executablePath = this.executablePath;
    if (!executablePath) throw this.fail("MPV_UNAVAILABLE", "mpv is not available on this development machine.");
    const endpoint = this.pipeNameFactory();
    const process = this.spawnMpv(executablePath, buildMpvArgs(endpoint), {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.process = process;
    this.processExited = false;
    this.attachProcessListeners(process);
    const ipc = this.createIpc(endpoint);
    this.ipc = ipc;
    try {
      await withTimeout(ipc.connect(), this.requestTimeoutMs, "mpv IPC connect timed out");
    } catch (error) {
      await ipc.close().catch(() => undefined);
      if (!this.processExited) await this.forceTerminate(process);
      this.process = undefined;
      this.ipc = undefined;
      throw this.mapIpcError(error, "mpv IPC could not connect.");
    }
  }

  private async runLoadedCommand(
    command: readonly unknown[],
    update: () => PlaybackState,
  ): Promise<PlaybackState> {
    this.ensureUsable();
    this.ensureLoaded();
    if (this.processExited || !this.ipc) throw this.fail("MPV_PROCESS_EXITED", "The mpv process is no longer running.");
    await this.command(command);
    return update();
  }

  private async command(command: readonly unknown[]): Promise<MpvIpcResponse> {
    const ipc = this.ipc;
    if (!ipc) throw this.fail("MPV_IPC_ERROR", "mpv IPC is not connected.");
    let response: MpvIpcResponse;
    try {
      response = await withTimeout(
        ipc.request(command, this.requestTimeoutMs),
        this.requestTimeoutMs,
        "mpv IPC request timed out",
      );
    } catch (error) {
      throw this.mapIpcError(error, "mpv IPC request failed.");
    }
    if (response.error && response.error !== "success") {
      throw this.fail("MPV_IPC_ERROR", "mpv rejected the playback command.");
    }
    return response;
  }

  private mapIpcError(error: unknown, fallback: string): PlayerBackendError {
    if (error instanceof MpvTimeoutError) return this.fail("MPV_TIMEOUT", "mpv did not respond before the timeout.");
    return this.fail("MPV_IPC_ERROR", fallback);
  }

  private attachProcessListeners(process: MpvProcessPort): void {
    process.on("exit", (code, signal) => {
      this.processExited = true;
      if (!this.destroying && !this.destroyed) {
        this.controller.markError("MPV_PROCESS_EXITED", `The mpv process exited (${code ?? "signal"}).`);
      }
      void this.ipc?.close().catch(() => undefined);
      void signal;
    });
    process.on("error", () => {
      if (!this.destroying && !this.destroyed) {
        this.controller.markError("MPV_PROCESS_EXITED", "The mpv process reported an error.");
      }
    });
  }

  private async destroyInternal(): Promise<void> {
    this.destroying = true;
    const process = this.process;
    const ipc = this.ipc;
    try {
      if (ipc && process && !this.processExited) {
        await withTimeout(
          ipc.request(["quit"], this.shutdownTimeoutMs),
          this.shutdownTimeoutMs,
          "mpv quit timed out",
        ).catch(() => undefined);
      }
    } finally {
      await ipc?.close().catch(() => undefined);
      if (process && !this.processExited) {
        const exited = await waitForProcessExit(process, this.shutdownTimeoutMs, () => this.processExited);
        if (!exited && !this.processExited) await this.forceTerminate(process);
      }
      this.processExited = true;
      this.process = undefined;
      this.ipc = undefined;
      this.controller.stop();
      this.destroyed = true;
    }
  }

  private async forceTerminate(process: MpvProcessPort): Promise<void> {
    if (typeof process.pid === "number") {
      await this.killTree(process.pid).catch(() => undefined);
    } else {
      try {
        process.kill("SIGKILL");
      } catch {}
    }
  }
}

class MpvTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MpvTimeoutError";
  }
}

class SocketMpvIpc implements MpvIpcPort {
  private readonly connectTimeoutMs = 2_000;
  private readonly pending = new Map<number, {
    resolve: (response: MpvIpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private socket: Socket | undefined;
  private buffer = "";
  private nextRequestId = 1;

  public constructor(private readonly endpoint: string) {}

  public async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await delay(25);
      }
    }
    throw lastError ?? new Error("mpv IPC connection failed");
  }

  public request(command: readonly unknown[], timeoutMs: number): Promise<MpvIpcResponse> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("mpv IPC is closed"));
    const requestId = this.nextRequestId++;
    return new Promise<MpvIpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new MpvTimeoutError("mpv IPC request timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.write(`${JSON.stringify({ command: [...command], request_id: requestId })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("mpv IPC closed"));
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint);
      const onConnect = () => {
        socket.removeListener("error", onConnectError);
        socket.on("data", (chunk: Buffer | string) => this.handleData(chunk.toString()));
        socket.on("error", (error) => this.rejectPending(error));
        this.socket = socket;
        resolve();
      };
      const onConnectError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onConnectError);
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.resolveResponse(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private resolveResponse(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value) || typeof value.request_id !== "number") return;
    const pending = this.pending.get(value.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.request_id);
    pending.resolve({
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...(Object.prototype.hasOwnProperty.call(value, "data") ? { data: value.data } : {}),
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isBrowserSource(source: PlaybackSource): boolean {
  return isDirectSource(source) && Object.keys(source.headers).length === 0;
}

function isDirectSource(source: PlaybackSource): boolean {
  return source.parse === 0 && /^https?:\/\//i.test(source.url);
}

function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

function safeControlMessage(message: string): string {
  return message.replace(/[\r\n]+/g, " ").slice(0, 160) || "The media could not start.";
}

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultMpvProbePaths(env: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform === "win32") {
    const candidates: string[] = [];
    if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "mpv", "mpv.exe"));
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "mpv", "mpv.exe"));
    return candidates;
  }
  return ["/usr/bin/mpv", "/usr/local/bin/mpv"];
}

function createMpvEndpoint(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\qx-mpv-${randomUUID()}`
    : join(tmpdir(), `qx-mpv-${randomUUID()}.sock`);
}

function buildMpvArgs(endpoint: string): readonly string[] {
  return [
    "--no-config",
    "--idle=yes",
    "--force-window=no",
    "--no-terminal",
    "--msg-level=all=no",
    `--input-ipc-server=${endpoint}`,
  ];
}

const defaultMpvSpawn: MpvSpawn = (file, args, options) => nodeSpawn(file, [...args], options);

async function defaultKillTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function waitForProcessExit(
  processPort: MpvProcessPort,
  timeoutMs: number,
  exited: () => boolean,
): Promise<boolean> {
  if (exited()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (processPort.removeListener) processPort.removeListener("exit", onExit as (...args: any[]) => void);
      clearTimeout(timer);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(exited()), timeoutMs);
    processPort.on("exit", onExit);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new MpvTimeoutError(message)), timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
