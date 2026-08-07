import { randomUUID } from "node:crypto";

import { LiveRepository } from "../data/repositories.js";
import { EmbeddedPlaybackController, type PlaybackMediaSync } from "../desktop/playback.js";
import {
  PlaybackProxyError,
  PlaybackProxyServer,
  type PlaybackProxySession,
} from "../desktop/playback-proxy.js";
import { buildLiveCatalog } from "./live-catalog.js";
import {
  LiveFailoverCoordinator,
  LiveHealthRegistry,
  LiveStreamCircuitBreaker,
  LIVE_LONG_BUFFER_THRESHOLD_MS,
  type LiveHealthStore,
} from "./live-health.js";
import type {
  LiveChannelWithStreams,
  LiveFailoverCandidateUiState,
  LiveFailoverMode,
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
  healthStore?: LiveHealthStore;
  failoverMode?: LiveFailoverMode;
  failoverMaxAttempts?: number;
  failoverTimeoutMs?: number;
  failoverCooldownMs?: number;
  manualOverrideMs?: number;
  onSelection?: (selection: {
    channelId: string;
    streamId: string;
    smartChannelId: string | null;
    smartMemberId: string | null;
    reason: "user" | "failover";
  }) => void | Promise<void>;
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

interface LiveSelectionOptions {
  reason?: "user" | "failover";
  smartChannelId?: string | null;
  smartMemberId?: string | null;
  failoverCandidates?: readonly LiveFailoverCandidateUiState[];
}

export class LivePlaybackService {
  private readonly repository: LiveRepository;
  private readonly proxy: LivePlaybackProxyPort;
  private readonly now: () => number;
  private readonly playerController = new EmbeddedPlaybackController();
  private readonly healthRegistry: LiveHealthRegistry;
  private readonly circuitBreaker: LiveStreamCircuitBreaker;
  private readonly failoverCoordinator: LiveFailoverCoordinator;
  private readonly manualOverrideMs: number;
  private readonly onSelection: LivePlaybackServiceOptions["onSelection"];
  private current: InternalLivePlaybackSession | null = null;
  private pending: PendingSwitch | null = null;
  private failoverCandidatesValue: LiveFailoverCandidateUiState[] = [];
  private failoverAttemptController: AbortController | null = null;
  private failoverAttemptTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferFailoverTimer: ReturnType<typeof setTimeout> | undefined;
  private failoverTask: Promise<void> | null = null;
  private stableCandidate: LiveFailoverCandidateUiState | null = null;
  private readonly manualExcludedCandidateIds = new Set<string>();
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
    this.healthRegistry = new LiveHealthRegistry({
      now: this.now,
      ...(options.healthStore ? { store: options.healthStore } : {}),
    });
    this.circuitBreaker = new LiveStreamCircuitBreaker({
      now: this.now,
      ...(options.failoverCooldownMs ? { cooldownMs: options.failoverCooldownMs } : {}),
    });
    this.manualOverrideMs = positiveInteger(options.manualOverrideMs, 60_000);
    this.failoverCoordinator = new LiveFailoverCoordinator({
      now: this.now,
      ...(options.failoverMode ? { mode: options.failoverMode } : {}),
      ...(options.failoverMaxAttempts ? { maxAttempts: options.failoverMaxAttempts } : {}),
      ...(options.failoverTimeoutMs ? { totalTimeoutMs: options.failoverTimeoutMs } : {}),
    });
    this.onSelection = options.onSelection;
  }

  public uiState(base: LiveUiState): LiveUiState {
    const catalog = this.decorateCatalog(buildLiveCatalog(this.repository));
    const health = this.current
      ? this.healthRegistry.snapshot(this.current.streamId, this.current.sourceId)
      : null;
    return {
      ...base,
      catalog,
      session: this.current ? toUiSession(this.current) : null,
      player: this.current ? this.playerController.state : null,
      error: this.errorValue ? { ...this.errorValue } : base.error,
      health,
      failover: this.failoverCoordinator.state,
    };
  }

  public async selectChannel(
    channelId: string,
    streamId?: string,
    options: LiveSelectionOptions = {},
  ): Promise<LivePlaybackSessionUiState> {
    if (this.closed) throw new LivePlaybackError("LIVE_SOURCE_UNAVAILABLE", "直播播放服务已关闭。");
    const reason = options.reason ?? "user";
    if (reason === "user") this.prepareManualSelection();
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

    this.failoverCandidatesValue = options.failoverCandidates
      ? [...options.failoverCandidates]
      : this.candidatesForChannel(selected.channel.id);

    let createdProxy: PlaybackProxySession | undefined;
    const tracker = this.healthRegistry.tracker(selected.stream.id, selected.channel.sourceId);
    try {
      const startedAt = this.now();
      const session: InternalLivePlaybackSession = {
        sessionId: randomUUID(),
        sourceId: selected.channel.sourceId,
        channelId: selected.channel.id,
        streamId: selected.stream.id,
        smartChannelId: options.smartChannelId ?? null,
        smartMemberId: options.smartMemberId ?? null,
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
      tracker.beginAttempt(startedAt);
      this.healthRegistry.markDirty(selected.stream.id);
      this.playerController.load(mediaSource);
      this.repository.upsertRecent({
        channelId: selected.channel.id,
        sourceId: selected.channel.sourceId,
        lastPlayedAt: startedAt,
        lastStreamId: selected.stream.id,
      });
      await this.onSelection?.({
        channelId: session.channelId,
        streamId: session.streamId,
        smartChannelId: session.smartChannelId,
        smartMemberId: session.smartMemberId,
        reason,
      });
      this.ensureCurrent(generation, controller.signal);
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
      if (!this.isCancelled(generation, controller.signal)) {
        tracker.recordStartupFailure(mapped.message, this.now());
        this.healthRegistry.markDirty(selected.stream.id);
        if (reason === "user" && this.current?.generation === generation) {
          void this.advanceFailover("startup-failure", mapped.message);
        }
      }
      throw mapped;
    } finally {
      if (this.pending?.generation === generation) this.pending = null;
    }
  }

  public async selectLine(streamId: string): Promise<LivePlaybackSessionUiState> {
    const channelId = this.current?.channelId;
    if (!channelId) throw new LivePlaybackError("LIVE_CHANNEL_UNAVAILABLE", "当前没有可切换的频道。");
    return this.selectChannel(channelId, streamId, {
      smartChannelId: this.current?.smartChannelId ?? null,
      smartMemberId: this.current?.smartMemberId ?? null,
      ...(this.failoverCandidatesValue.length > 0 ? { failoverCandidates: this.failoverCandidatesValue } : {}),
    });
  }

  public sync(sessionId: string | undefined, patch: PlaybackMediaSync, backend?: LivePlaybackBackend): LivePlaybackSessionUiState | null {
    const session = this.current;
    if (!session || session.state === "stopped" || (sessionId && session.sessionId !== sessionId)) return null;
    if (backend) session.backend = backend;
    this.playerController.syncMedia(patch);
    this.processSync(session, patch);
    return toUiSession(session);
  }

  public async syncAndMaybeFailover(
    sessionId: string | undefined,
    patch: PlaybackMediaSync,
    backend?: LivePlaybackBackend,
  ): Promise<LivePlaybackSessionUiState | null> {
    const result = this.sync(sessionId, patch, backend);
    await this.failoverTask;
    return result;
  }

  public setFailoverMode(mode: LiveFailoverMode): void {
    if (mode === "off") void this.cancelFailover("故障转移已关闭");
    this.failoverCoordinator.setMode(mode);
  }

  public async approveFailover(): Promise<void> {
    const decision = this.failoverCoordinator.approve(this.now());
    if (decision.kind === "attempt") await this.startFailoverAttempt(decision.candidate);
  }

  public async cancelFailover(reason = "用户取消故障转移"): Promise<void> {
    this.clearFailoverAttempt();
    this.failoverCoordinator.cancel(reason);
    await this.restoreStableCandidate();
  }

  public async stayOnCurrentLine(reason = "用户选择保持当前线路"): Promise<void> {
    this.clearFailoverAttempt();
    const until = this.now() + this.manualOverrideMs;
    this.failoverCoordinator.setManualOverride(until);
    this.failoverCoordinator.stay(reason);
    await this.restoreStableCandidate();
  }

  public async returnToStable(): Promise<void> {
    const stable = this.stableCandidate;
    await this.stayOnCurrentLine("返回最近稳定线路");
    if (!stable || this.current?.streamId === stable.streamId) return;
    await this.selectChannel(stable.channelId, stable.streamId, {
      reason: "user",
      smartChannelId: stable.smartChannelId,
      smartMemberId: stable.memberId,
      failoverCandidates: this.failoverCandidatesValue,
    });
  }

  public async stop(): Promise<void> {
    this.clearFailoverAttempt();
    this.failoverCoordinator.stop("用户停止播放", this.now());
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
    this.healthRegistry.flush();
  }

  public async stopIfSource(sourceId: string): Promise<void> {
    if (this.current?.sourceId === sourceId) await this.stop();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
    this.healthRegistry.close();
    await this.proxy.close();
  }

  public get proxySessionCount(): number {
    return this.proxy.activeSessionCount;
  }

  private processSync(session: InternalLivePlaybackSession, patch: PlaybackMediaSync): void {
    const tracker = this.healthRegistry.tracker(session.streamId, session.sourceId);
    const event = patch.event;
    if (event?.type === "first-frame") {
      this.clearBufferFailoverTimer();
      if (session.firstFrameAt === null) session.firstFrameAt = event.at ?? this.now();
      session.state = "playing";
      session.error = null;
      tracker.recordFirstFrame(event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      this.stableCandidate = this.currentCandidate();
      this.circuitBreaker.recover(session.streamId);
      tracker.setCooldown(null);
      this.healthRegistry.markDirty(session.streamId);
      if (this.failoverCoordinator.state.status === "trying") {
        this.clearFailoverAttemptTimer();
        this.failoverCoordinator.finishAttempt(true);
      }
    } else if (event?.type === "buffer-start") {
      this.clearBufferFailoverTimer();
      session.state = "buffering";
      tracker.recordBufferStart(event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      const generation = session.generation;
      this.bufferFailoverTimer = setTimeout(() => {
        this.bufferFailoverTimer = undefined;
        if (this.current?.generation === generation && this.current.state === "buffering") {
          void this.advanceFailover("long-buffer", `连续缓冲超过 ${LIVE_LONG_BUFFER_THRESHOLD_MS}ms`);
        }
      }, LIVE_LONG_BUFFER_THRESHOLD_MS);
    } else if (event?.type === "buffer-end") {
      this.clearBufferFailoverTimer();
      const duration = tracker.recordBufferEnd(event.at ?? this.now());
      session.state = "playing";
      this.healthRegistry.markDirty(session.streamId);
      if (tracker.shouldTriggerLongBuffer(duration)) {
        void this.advanceFailover("long-buffer", `连续缓冲 ${duration}ms`);
      }
    } else if (event?.type === "startup-timeout") {
      const reason = event.reason ?? "起播超时";
      session.state = "error";
      session.error = { code: "LIVE_STREAM_TIMEOUT", message: "直播流起播超时。" };
      this.errorValue = { ...session.error };
      tracker.recordStartupFailure(reason, event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      void this.advanceFailover("startup-timeout", reason);
    } else if (event?.type === "playlist-refresh-failure") {
      const reason = event.reason ?? "播放列表刷新失败";
      tracker.recordPlaylistRefreshFailure(reason, event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      if (tracker.shouldTriggerPlaylistFailure()) void this.advanceFailover("playlist-failures", reason);
    } else if (event?.type === "segment-failure") {
      const reason = event.reason ?? "分片失败";
      tracker.recordSegmentFailure(reason, event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      if (tracker.shouldTriggerSegmentFailure()) void this.advanceFailover("segment-errors", reason);
    } else if (event?.type === "fatal-error") {
      const reason = event.code ?? "播放器致命错误";
      session.state = "error";
      session.error = { code: "LIVE_STREAM_FAILED", message: "直播流播放失败。" };
      this.errorValue = { ...session.error };
      tracker.recordFatalError(reason, event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      void this.advanceFailover("fatal-error", reason);
    } else if (event?.type === "disconnect") {
      const reason = event.reason ?? "播放器连接断开";
      tracker.recordDisconnect(reason, event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
      void this.advanceFailover("backend-crash", reason);
    } else if (event?.type === "http-status") {
      const status = event.status ?? 0;
      if (status >= 500) {
        tracker.recordPlaylistRefreshFailure(`HTTP ${status}`, event.at ?? this.now());
        this.healthRegistry.markDirty(session.streamId);
        if (tracker.shouldTriggerPlaylistFailure()) void this.advanceFailover("playlist-failures", `HTTP ${status}`);
      }
    } else if (event?.type === "completion") {
      tracker.recordStop(event.at ?? this.now(), "completion");
      this.healthRegistry.markDirty(session.streamId);
    } else if (event?.type === "user-pause") {
      tracker.recordUserPause(event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
    } else if (event?.type === "seek") {
      tracker.recordSeek(event.at ?? this.now());
      this.healthRegistry.markDirty(session.streamId);
    }

    if (patch.status === "playing" && event?.type !== "buffer-start") session.state = "playing";
    else if (patch.status === "loading" || patch.status === "resolving") session.state = "loading";
    if (patch.status === "error" || patch.error) {
      const error = mapLivePlaybackError(patch.error ?? { code: "LIVE_STREAM_FAILED", message: "直播流播放失败。" });
      session.state = "error";
      session.error = { code: error.code, message: error.message };
      this.errorValue = { code: error.code, message: error.message };
      if (!event || ![
        "startup-timeout",
        "fatal-error",
        "disconnect",
        "playlist-refresh-failure",
        "segment-failure",
      ].includes(event.type)) {
        if (error.code === "LIVE_STREAM_TIMEOUT") {
          tracker.recordStartupFailure(error.message, this.now());
          void this.advanceFailover("startup-timeout", error.message);
        } else {
          tracker.recordFatalError(error.code, this.now());
          void this.advanceFailover("fatal-error", error.message);
        }
        this.healthRegistry.markDirty(session.streamId);
      }
    }
  }

  private prepareManualSelection(): void {
    const current = this.currentCandidate();
    if (current) this.manualExcludedCandidateIds.add(current.id);
    this.clearFailoverAttempt();
    const until = this.now() + this.manualOverrideMs;
    this.failoverCoordinator.setManualOverride(until);
    if (this.failoverCoordinator.state.status !== "idle" && this.failoverCoordinator.state.status !== "disabled") {
      this.failoverCoordinator.cancel("用户手动选择线路");
    }
  }

  private candidatesForChannel(channelId: string): LiveFailoverCandidateUiState[] {
    const channel = this.repository.getAllChannels().find((candidate) => candidate.id === channelId);
    if (!channel) return [];
    const source = this.repository.getSource(channel.sourceId);
    return channel.streams
      .filter((stream) => isSupportedLiveProtocol(stream.protocol, stream.url))
      .map((stream, index) => this.candidateForStream(channel, source?.name ?? "未知来源", stream, index));
  }

  private candidateForStream(
    channel: LiveChannelWithStreams,
    sourceName: string,
    stream: LiveChannelWithStreams["streams"][number],
    index: number,
    smartChannelId: string | null = null,
    memberId: string | null = null,
  ): LiveFailoverCandidateUiState {
    return {
      id: `live:${channel.id}:${stream.id}`,
      channelId: channel.id,
      streamId: stream.id,
      sourceId: channel.sourceId,
      sourceName,
      channelName: channel.name,
      streamLabel: stream.label ?? `线路 ${index + 1}`,
      memberId,
      smartChannelId,
      healthScore: this.healthRegistry.score(stream.id, channel.sourceId),
    };
  }

  private currentCandidate(): LiveFailoverCandidateUiState | null {
    const session = this.current;
    if (!session) return null;
    return this.failoverCandidatesValue.find((candidate) => candidate.streamId === session.streamId)
      ?? this.candidatesForChannel(session.channelId).find((candidate) => candidate.streamId === session.streamId)
      ?? null;
  }

  private decorateCatalog(catalog: ReturnType<typeof buildLiveCatalog>): ReturnType<typeof buildLiveCatalog> {
    return {
      ...catalog,
      channels: catalog.channels.map((channel) => {
        const streams = channel.streams.map((stream) => {
          const source = this.repository.getSource(channel.sourceId);
          const health = source ? this.healthRegistry.snapshot(stream.id, channel.sourceId) : null;
          return { ...stream, health };
        });
        const currentStream = streams.find((stream) => stream.id === this.current?.streamId);
        const firstWithSamples = streams.find((stream) => stream.health?.score !== null);
        return {
          ...channel,
          streams,
          health: currentStream?.health ?? firstWithSamples?.health ?? null,
        };
      }),
    };
  }

  private async advanceFailover(trigger: import("./live-types.js").LiveFailoverTrigger, reason: string): Promise<void> {
    if (this.closed || !this.current) return;
    const now = this.now();
    const state = this.failoverCoordinator.state;
    const current = this.currentCandidate();
    if (!current) return;
    if (state.status === "idle" || state.status === "disabled" || state.status === "cancelled" || state.status === "stopped" || state.status === "recovered") {
      const candidates = this.availableFailoverCandidates(current);
      this.failoverCoordinator.begin(candidates, current.id, state.manualOverrideUntil, now);
    }
    const cooldownUntil = this.circuitBreaker.open(current.streamId, now);
    this.healthRegistry.setCooldown(current.streamId, current.sourceId, cooldownUntil);
    const decision = this.failoverCoordinator.trigger(trigger, reason, now);
    if (decision.kind === "attempt") await this.startFailoverAttempt(decision.candidate);
  }

  private availableFailoverCandidates(current: LiveFailoverCandidateUiState): LiveFailoverCandidateUiState[] {
    const now = this.now();
    const manualOverrideUntil = this.failoverCoordinator.state.manualOverrideUntil;
    const manualOverrideActive = manualOverrideUntil !== null && manualOverrideUntil > now;
    if (!manualOverrideActive) this.manualExcludedCandidateIds.clear();
    const candidates = this.failoverCandidatesValue.length > 0
      ? this.failoverCandidatesValue
      : this.candidatesForChannel(current.channelId);
    const available = candidates.filter((candidate) => {
      if (candidate.id !== current.id && manualOverrideActive && this.manualExcludedCandidateIds.has(candidate.id)) return false;
      return candidate.id === current.id || !this.isCoolingDown(candidate);
    });
    return available;
  }

  private isCoolingDown(candidate: LiveFailoverCandidateUiState): boolean {
    const now = this.now();
    const snapshot = this.healthRegistry.snapshot(candidate.streamId, candidate.sourceId);
    return this.circuitBreaker.isCoolingDown(candidate.streamId, now)
      || (snapshot.cooldownUntil !== null && snapshot.cooldownUntil > now);
  }

  private async startFailoverAttempt(candidate: LiveFailoverCandidateUiState): Promise<void> {
    this.clearFailoverAttemptTimer();
    this.failoverAttemptController?.abort();
    const controller = new AbortController();
    this.failoverAttemptController = controller;
    const task = this.selectChannel(candidate.channelId, candidate.streamId, {
      reason: "failover",
      smartChannelId: candidate.smartChannelId,
      smartMemberId: candidate.memberId,
      failoverCandidates: this.failoverCandidatesValue,
    }).then(() => {
      if (controller.signal.aborted) return;
      const deadlineAt = this.failoverCoordinator.state.deadlineAt;
      const delay = deadlineAt === null
        ? 10_000
        : Math.max(1, Math.min(10_000, deadlineAt - this.now()));
      this.failoverAttemptTimer = setTimeout(() => {
        this.failoverAttemptTimer = undefined;
        if (this.current?.streamId === candidate.streamId && this.failoverCoordinator.state.status === "trying") {
          void this.advanceFailover("startup-timeout", "备选线路起播超时");
        }
      }, delay);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      void this.advanceFailover("startup-failure", error instanceof Error ? error.message : "备选线路不可用");
    });
    this.failoverTask = task;
    try {
      await task;
    } finally {
      if (this.failoverTask === task) this.failoverTask = null;
      if (this.failoverAttemptController === controller) this.failoverAttemptController = null;
    }
  }

  private clearFailoverAttemptTimer(): void {
    if (this.failoverAttemptTimer !== undefined) clearTimeout(this.failoverAttemptTimer);
    this.failoverAttemptTimer = undefined;
  }

  private clearFailoverAttempt(): void {
    const pending = this.pending;
    const failoverController = this.failoverAttemptController;
    this.clearFailoverAttemptTimer();
    failoverController?.abort();
    if (failoverController && pending) pending.controller.abort();
    this.failoverAttemptController = null;
    this.failoverTask = null;
  }

  private async restoreStableCandidate(): Promise<void> {
    const stable = this.stableCandidate;
    if (!stable || this.current?.streamId === stable.streamId) return;
    await this.selectChannel(stable.channelId, stable.streamId, {
      reason: "user",
      smartChannelId: stable.smartChannelId,
      smartMemberId: stable.memberId,
      failoverCandidates: this.failoverCandidatesValue,
    }).catch(() => undefined);
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
    this.clearBufferFailoverTimer();
    const session = this.current;
    this.current = null;
    this.playerController.stop();
    if (session) {
      const tracker = this.healthRegistry.tracker(session.streamId, session.sourceId);
      tracker.recordStop(this.now(), "switch");
      this.healthRegistry.markDirty(session.streamId);
    }
    if (session?.proxy) {
      const proxy = session.proxy;
      session.proxy = undefined;
      await proxy.close().catch(() => undefined);
    }
  }

  private clearBufferFailoverTimer(): void {
    if (this.bufferFailoverTimer !== undefined) clearTimeout(this.bufferFailoverTimer);
    this.bufferFailoverTimer = undefined;
  }
}

function toUiSession(session: InternalLivePlaybackSession): LivePlaybackSessionUiState {
  return {
    sessionId: session.sessionId,
    sourceId: session.sourceId,
    channelId: session.channelId,
    streamId: session.streamId,
    smartChannelId: session.smartChannelId,
    smartMemberId: session.smartMemberId,
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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
