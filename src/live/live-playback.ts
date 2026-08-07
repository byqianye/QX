import { randomUUID } from "node:crypto";

import { LiveRepository } from "../data/repositories.js";
import { EmbeddedPlaybackController, type PlaybackMediaSync } from "../desktop/playback.js";
import {
  PlaybackProxyError,
  PlaybackProxyServer,
  type PlaybackProxySession,
} from "../desktop/playback-proxy.js";
import { buildLiveCatalog } from "./live-catalog.js";
import type {
  LiveChannelWithStreams,
  LivePlaybackBackend,
  LivePlaybackSessionState,
  LivePlaybackSessionUiState,
  LiveUiError,
  LiveUiState,
} from "./live-types.js";

export class LivePlaybackError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LivePlaybackError";
    this.code = code;
  }
}

export interface LivePlaybackServiceOptions {
  repository: LiveRepository;
  proxy?: LivePlaybackProxyPort;
  proxyAllowedOrigins?: readonly string[];
  requestTimeoutMs?: number;
  now?: () => number;
}

export interface LivePlaybackProxyPort {
  readonly activeSessionCount: number;
  createSession(source: {
    parse: number;
    url: string;
    headers: Record<string, string>;
    sourceId?: string;
    playbackSessionId?: string;
  }): Promise<PlaybackProxySession>;
  close(): Promise<void>;
}

interface InternalLivePlaybackSession extends LivePlaybackSessionUiState {
  proxy: PlaybackProxySession | undefined;
}

interface PendingSwitch {
  generation: number;
  controller: AbortController;
}

export class LivePlaybackService {
  private readonly repository: LiveRepository;
  private readonly proxy: LivePlaybackProxyPort;
  private readonly now: () => number;
  private readonly playerController = new EmbeddedPlaybackController();
  private current: InternalLivePlaybackSession | null = null;
  private pending: PendingSwitch | null = null;
  private generationValue = 0;
  private errorValue: LiveUiError | null = null;
  private closed = false;

  public constructor(options: LivePlaybackServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.proxy = options.proxy ?? new PlaybackProxyServer({
      ...(options.proxyAllowedOrigins ? { allowedOrigins: options.proxyAllowedOrigins } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    });
  }

  public uiState(base: LiveUiState): LiveUiState {
    return {
      ...base,
      catalog: buildLiveCatalog(this.repository),
      session: this.current ? toUiSession(this.current) : null,
      player: this.current ? this.playerController.state : null,
      error: this.errorValue ? { ...this.errorValue } : base.error,
    };
  }

  public async selectChannel(channelId: string, streamId?: string): Promise<LivePlaybackSessionUiState> {
    if (this.closed) throw new LivePlaybackError("LIVE_SOURCE_UNAVAILABLE", "直播播放服务已关闭。");
    let selected: { channel: LiveChannelWithStreams; stream: LiveChannelWithStreams["streams"][number] };
    try {
      selected = this.resolveSelection(channelId, streamId);
    } catch (error) {
      const mapped = mapLivePlaybackError(error);
      this.errorValue = { code: mapped.code, message: mapped.message };
      throw mapped;
    }
    const generation = ++this.generationValue;
    this.pending?.controller.abort();
    const controller = new AbortController();
    this.pending = { generation, controller };
    const hadCurrent = this.current !== null && this.current.state !== "stopped";
    await this.stopCurrent();
    this.errorValue = null;

    let createdProxy: PlaybackProxySession | undefined;
    try {
      const startedAt = this.now();
      const session: InternalLivePlaybackSession = {
        sessionId: randomUUID(),
        sourceId: selected.channel.sourceId,
        channelId: selected.channel.id,
        streamId: selected.stream.id,
        state: hadCurrent ? "switching" : "resolving",
        backend: backendFor(selected.stream.url),
        startedAt,
        firstFrameAt: null,
        error: null,
        generation,
        proxy: undefined,
      };
      this.current = session;
      this.playerController.stop();
      this.ensureCurrent(generation, controller.signal);

      const source = { parse: 0 as const, url: selected.stream.url, headers: selected.stream.headers };
      const mediaSource = Object.keys(source.headers).length === 0
        ? source
        : await this.createProxy(source, session.sourceId, session.sessionId, controller.signal).then((value) => {
            createdProxy = value.session;
            return { parse: 0 as const, url: value.session.url, headers: {} };
          });
      this.ensureCurrent(generation, controller.signal);
      session.proxy = createdProxy;
      session.state = "loading";
      this.playerController.load(mediaSource);
      this.repository.upsertRecent({
        channelId: selected.channel.id,
        sourceId: selected.channel.sourceId,
        lastPlayedAt: startedAt,
        lastStreamId: selected.stream.id,
      });
      return toUiSession(session);
    } catch (error) {
      if (createdProxy) await createdProxy.close().catch(() => undefined);
      const mapped = this.isCancelled(generation, controller.signal)
        ? new LivePlaybackError("LIVE_SWITCH_CANCELLED", "频道切换已取消。", { cause: error })
        : mapLivePlaybackError(error);
      if (this.current?.generation === generation) {
        this.current.proxy = undefined;
        this.current.state = "error";
        this.current.error = { code: mapped.code, message: mapped.message };
        this.playerController.markError(mapped.code, mapped.message);
        this.errorValue = { code: mapped.code, message: mapped.message };
      }
      throw mapped;
    } finally {
      if (this.pending?.generation === generation) this.pending = null;
    }
  }

  public async selectLine(streamId: string): Promise<LivePlaybackSessionUiState> {
    const channelId = this.current?.channelId;
    if (!channelId) throw new LivePlaybackError("LIVE_CHANNEL_UNAVAILABLE", "当前没有可切换的频道。");
    return this.selectChannel(channelId, streamId);
  }

  public sync(sessionId: string | undefined, patch: PlaybackMediaSync, backend?: LivePlaybackBackend): LivePlaybackSessionUiState | null {
    const session = this.current;
    if (!session || session.state === "stopped" || (sessionId && session.sessionId !== sessionId)) return null;
    if (backend) session.backend = backend;
    this.playerController.syncMedia(patch);
    const event = patch.event;
    if (event?.type === "first-frame" && session.firstFrameAt === null) session.firstFrameAt = this.now();
    if (event?.type === "buffer-start") session.state = "buffering";
    else if (event?.type === "buffer-end" && session.state === "buffering") session.state = "playing";
    else if (patch.status === "playing") session.state = "playing";
    else if (patch.status === "loading" || patch.status === "resolving") session.state = "loading";
    else if (patch.status === "error" || patch.error) {
      const error = mapLivePlaybackError(patch.error ?? { code: "LIVE_STREAM_FAILED", message: "直播流播放失败。" });
      session.state = "error";
      session.error = { code: error.code, message: error.message };
      this.errorValue = { code: error.code, message: error.message };
    }
    return toUiSession(session);
  }

  public async stop(): Promise<void> {
    ++this.generationValue;
    this.pending?.controller.abort();
    this.pending = null;
    const previous = this.current;
    await this.stopCurrent();
    if (previous) {
      this.current = {
        ...previous,
        state: "stopped",
        error: null,
        proxy: undefined,
      };
    }
    this.errorValue = null;
  }

  public async stopIfSource(sourceId: string): Promise<void> {
    if (this.current?.sourceId === sourceId) await this.stop();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
    await this.proxy.close();
  }

  public get proxySessionCount(): number {
    return this.proxy.activeSessionCount;
  }

  private resolveSelection(channelId: string, streamId?: string): { channel: LiveChannelWithStreams; stream: LiveChannelWithStreams["streams"][number] } {
    const channel = this.repository.getAllChannels().find((candidate) => candidate.id === channelId);
    if (!channel) throw new LivePlaybackError("LIVE_CHANNEL_UNAVAILABLE", "频道不存在或已被移除。");
    const source = this.repository.getSource(channel.sourceId);
    if (!source || !source.enabled) throw new LivePlaybackError("LIVE_SOURCE_UNAVAILABLE", "直播源不存在或已停用。");
    if (!channel.enabled) throw new LivePlaybackError("LIVE_CHANNEL_UNAVAILABLE", "频道不存在或已停用。");
    const stream = streamId
      ? channel.streams.find((candidate) => candidate.id === streamId)
      : channel.streams[0];
    if (!stream) throw new LivePlaybackError("LIVE_STREAM_UNAVAILABLE", "当前频道没有可用线路。");
    if (!/^https?:\/\//iu.test(stream.url)) {
      throw new LivePlaybackError("LIVE_PROTOCOL_UNSUPPORTED", "当前直播线路不是受支持的 HTTP(S) 媒体地址。");
    }
    if (!isSupportedLiveProtocol(stream.protocol, stream.url)) {
      throw new LivePlaybackError("LIVE_PROTOCOL_UNSUPPORTED", "当前直播线路协议暂不受支持。");
    }
    return { channel, stream };
  }

  private async createProxy(
    source: { parse: 0; url: string; headers: Record<string, string> },
    sourceId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ session: PlaybackProxySession }> {
    if (signal.aborted) throw new LivePlaybackError("LIVE_SWITCH_CANCELLED", "频道切换已取消。");
    const session = await this.proxy.createSession({
      ...source,
      sourceId,
      playbackSessionId: sessionId,
    });
    if (signal.aborted) {
      await session.close();
      throw new LivePlaybackError("LIVE_SWITCH_CANCELLED", "频道切换已取消。");
    }
    return { session };
  }

  private ensureCurrent(generation: number, signal: AbortSignal): void {
    if (this.isCancelled(generation, signal)) {
      throw new LivePlaybackError("LIVE_SWITCH_CANCELLED", "频道切换已取消。");
    }
  }

  private isCancelled(generation: number, signal: AbortSignal): boolean {
    return signal.aborted || generation !== this.generationValue;
  }

  private async stopCurrent(): Promise<void> {
    const session = this.current;
    this.current = null;
    this.playerController.stop();
    if (session?.proxy) {
      const proxy = session.proxy;
      session.proxy = undefined;
      await proxy.close().catch(() => undefined);
    }
  }
}

function toUiSession(session: InternalLivePlaybackSession): LivePlaybackSessionUiState {
  return {
    sessionId: session.sessionId,
    sourceId: session.sourceId,
    channelId: session.channelId,
    streamId: session.streamId,
    state: session.state,
    backend: session.backend,
    startedAt: session.startedAt,
    firstFrameAt: session.firstFrameAt,
    error: session.error ? { ...session.error } : null,
    generation: session.generation,
  };
}

function backendFor(url: string): LivePlaybackBackend {
  return /\.m3u8(?:$|[?#])/iu.test(url) ? "hls-js" : "html-video";
}

function isSupportedLiveProtocol(protocol: string | null, url: string): boolean {
  if (!/^https?:\/\//iu.test(url)) return false;
  return protocol === null || /^(?:HLS|HTTP|HTTPS|MP4|WEBM)$/iu.test(protocol);
}

function mapLivePlaybackError(error: { code: string; message: string }): LivePlaybackError;
function mapLivePlaybackError(error: unknown): LivePlaybackError;
function mapLivePlaybackError(error: unknown): LivePlaybackError {
  if (error instanceof LivePlaybackError) return error;
  if (error instanceof PlaybackProxyError) {
    return new LivePlaybackError(
      error.code.includes("TIMEOUT") ? "LIVE_STREAM_TIMEOUT" : "LIVE_STREAM_FAILED",
      "直播流无法加载。",
      { cause: error },
    );
  }
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "LIVE_STREAM_FAILED";
  const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "直播流播放失败。";
  if (code === "PLAYBACK_STARTUP_TIMEOUT" || code === "PLAYBACK_PROXY_TIMEOUT") {
    return new LivePlaybackError("LIVE_STREAM_TIMEOUT", "直播流起播超时。", { cause: error });
  }
  if (code.startsWith("LIVE_")) return new LivePlaybackError(code, message, { cause: error });
  return new LivePlaybackError("LIVE_STREAM_FAILED", message, { cause: error });
}
