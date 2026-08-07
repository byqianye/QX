import { redactSensitiveText } from "../data/safe-persistence.js";
import type {
  LiveFailoverCandidateUiState,
  LiveFailoverMode,
  LiveFailoverStatus,
  LiveFailoverTrigger,
  LiveHealthMetricUiState,
  LiveStreamHealthUiState,
} from "./live-types.js";

export const LIVE_LONG_BUFFER_THRESHOLD_MS = 8_000;

export interface LiveHealthEvent {
  sequence: number;
  at: number;
  type: string;
  safeDetails: Readonly<Record<string, string>>;
}

export interface LiveStreamHealthSnapshot extends LiveStreamHealthUiState {
  events: readonly LiveHealthEvent[];
}

export interface LiveHealthStore {
  readStream(streamId: string): unknown | null;
  upsertStream(record: { id: string; sourceId: string; snapshot: unknown; updatedAt: number }): void;
  upsertStreams?(records: readonly { id: string; sourceId: string; snapshot: unknown; updatedAt: number }[]): void;
}

export interface LiveStreamHealthTrackerOptions {
  streamId: string;
  sourceId: string;
  now?: () => number;
  maxEvents?: number;
  snapshot?: unknown;
}

export interface LiveHealthScore {
  value: number | null;
  reasons: readonly string[];
}

type MutableMetric<T> = LiveHealthMetricUiState<T>;

export class LiveStreamHealthTracker {
  public readonly streamId: string;
  public readonly sourceId: string;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly eventsValue: LiveHealthEvent[] = [];
  private eventSequence = 0;
  private attemptStartedAt: number | null = null;
  private playingStartedAt: number | null = null;
  private bufferStartedAt: number | null = null;
  private consecutiveSegmentFailures = 0;
  private consecutivePlaylistFailures = 0;
  private readonly startupSuccessValue = emptyMetric<boolean>();
  private readonly firstFrameMsValue = emptyMetric<number>();
  private readonly playlistRefreshFailureValue = emptyMetric<number>();
  private readonly segmentFailureValue = emptyMetric<number>();
  private readonly bufferCountValue = emptyMetric<number>();
  private readonly bufferDurationValue = emptyMetric<number>();
  private readonly fatalErrorValue = emptyMetric<number>();
  private readonly disconnectCountValue = emptyMetric<number>();
  private readonly uptimeValue = emptyMetric<number>();
  private lastSuccessAtValue: number | null = null;
  private lastFailureAtValue: number | null = null;
  private consecutiveFailuresValue = 0;
  private cooldownUntilValue: number | null = null;

  public constructor(options: LiveStreamHealthTrackerOptions) {
    this.streamId = safeIdentifier(options.streamId, "stream");
    this.sourceId = safeIdentifier(options.sourceId, "source");
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 120));
    this.hydrate(options.snapshot);
  }

  public beginAttempt(at = this.now()): void {
    this.attemptStartedAt = finiteTime(at, this.now());
    this.bufferStartedAt = null;
    this.consecutiveSegmentFailures = 0;
    this.consecutivePlaylistFailures = 0;
    this.recordEvent("attempt-started", this.attemptStartedAt);
  }

  public recordFirstFrame(at = this.now()): void {
    const timestamp = finiteTime(at, this.now());
    const elapsed = this.attemptStartedAt === null ? null : Math.max(0, timestamp - this.attemptStartedAt);
    setMetric(this.startupSuccessValue, true);
    if (elapsed !== null) setMetric(this.firstFrameMsValue, elapsed);
    this.lastSuccessAtValue = timestamp;
    this.consecutiveFailuresValue = 0;
    this.consecutiveSegmentFailures = 0;
    this.consecutivePlaylistFailures = 0;
    this.recordEvent("first-frame", timestamp, elapsed === null ? {} : { elapsedMs: String(elapsed) });
    if (this.playingStartedAt === null) this.playingStartedAt = timestamp;
  }

  public recordStartupFailure(reason = "startup failure", at = this.now()): void {
    setMetric(this.startupSuccessValue, false);
    this.recordFailure("startup-failure", reason, at);
  }

  public recordPlaylistRefreshFailure(reason = "playlist refresh failure", at = this.now()): void {
    incrementMetric(this.playlistRefreshFailureValue);
    this.consecutivePlaylistFailures += 1;
    this.recordFailure("playlist-refresh-failure", reason, at);
  }

  public recordPlaylistRefreshSuccess(at = this.now()): void {
    this.consecutivePlaylistFailures = 0;
    this.recordEvent("playlist-refresh-success", at);
  }

  public recordSegmentFailure(reason = "segment failure", at = this.now()): void {
    incrementMetric(this.segmentFailureValue);
    this.consecutiveSegmentFailures += 1;
    this.recordFailure("segment-failure", reason, at);
  }

  public recordBufferStart(at = this.now()): void {
    if (this.bufferStartedAt === null) this.bufferStartedAt = finiteTime(at, this.now());
    this.recordEvent("buffer-start", at);
  }

  public recordBufferEnd(at = this.now()): number {
    const timestamp = finiteTime(at, this.now());
    const duration = this.bufferStartedAt === null ? 0 : Math.max(0, timestamp - this.bufferStartedAt);
    this.bufferStartedAt = null;
    incrementMetric(this.bufferCountValue);
    addMetric(this.bufferDurationValue, duration);
    this.recordEvent("buffer-end", timestamp, { durationMs: String(duration) });
    return duration;
  }

  public recordFatalError(code = "PLAYER_FATAL", at = this.now()): void {
    incrementMetric(this.fatalErrorValue);
    this.recordFailure("fatal-error", code, at);
  }

  public recordDisconnect(reason = "disconnect", at = this.now()): void {
    incrementMetric(this.disconnectCountValue);
    this.recordFailure("disconnect", reason, at);
  }

  public recordUserPause(at = this.now()): void {
    this.recordEvent("user-pause", at);
  }

  public recordSeek(at = this.now()): void {
    this.recordEvent("seek", at);
  }

  public recordStop(at = this.now(), reason = "stop"): void {
    const timestamp = finiteTime(at, this.now());
    this.addUptime(timestamp);
    this.recordEvent(reason === "user" ? "user-stop" : "stop", timestamp);
  }

  public shouldTriggerSegmentFailure(): boolean {
    return this.consecutiveSegmentFailures >= 2;
  }

  public shouldTriggerPlaylistFailure(): boolean {
    return this.consecutivePlaylistFailures >= 2;
  }

  public shouldTriggerLongBuffer(durationMs: number): boolean {
    return Number.isFinite(durationMs) && durationMs >= LIVE_LONG_BUFFER_THRESHOLD_MS;
  }

  public setCooldown(until: number | null): void {
    this.cooldownUntilValue = until !== null && Number.isFinite(until) ? Math.max(0, Math.round(until)) : null;
  }

  public snapshot(at = this.now()): LiveStreamHealthSnapshot {
    const uptime = this.currentUptime(at);
    const ui: LiveStreamHealthUiState = {
      streamId: this.streamId,
      sourceId: this.sourceId,
      startupSuccess: cloneMetric(this.startupSuccessValue),
      firstFrameMs: cloneMetric(this.firstFrameMsValue),
      playlistRefreshFailure: cloneMetric(this.playlistRefreshFailureValue),
      segmentFailure: cloneMetric(this.segmentFailureValue),
      bufferCount: cloneMetric(this.bufferCountValue),
      bufferDuration: cloneMetric(this.bufferDurationValue),
      fatalError: cloneMetric(this.fatalErrorValue),
      disconnectCount: cloneMetric(this.disconnectCountValue),
      uptimeMs: { ...cloneMetric(this.uptimeValue), value: uptime },
      lastSuccessAt: this.lastSuccessAtValue,
      lastFailureAt: this.lastFailureAtValue,
      consecutiveFailures: this.consecutiveFailuresValue,
      score: null,
      scoreReasons: [],
      cooldownUntil: this.cooldownUntilValue,
    };
    const score = calculateLiveHealthScore(ui, at);
    return {
      ...ui,
      score: score.value,
      scoreReasons: score.reasons,
      events: this.eventsValue.map((event) => ({ ...event, safeDetails: { ...event.safeDetails } })),
    };
  }

  private recordFailure(type: string, reason: string, at: number): void {
    const timestamp = finiteTime(at, this.now());
    this.consecutiveFailuresValue += 1;
    this.lastFailureAtValue = timestamp;
    this.recordEvent(type, timestamp, { reason });
  }

  private addUptime(at: number): void {
    if (this.playingStartedAt === null) return;
    const duration = Math.max(0, at - this.playingStartedAt);
    addMetric(this.uptimeValue, duration);
    this.playingStartedAt = null;
  }

  private currentUptime(at: number): number | null {
    if (this.uptimeValue.samples === 0 && this.playingStartedAt === null) return null;
    const active = this.playingStartedAt === null ? 0 : Math.max(0, finiteTime(at, this.now()) - this.playingStartedAt);
    return (this.uptimeValue.value ?? 0) + active;
  }

  private recordEvent(type: string, at: number, details: Record<string, string> = {}): void {
    this.eventsValue.push({
      sequence: ++this.eventSequence,
      at: finiteTime(at, this.now()),
      type: safeIdentifier(type, "event"),
      safeDetails: sanitizeDetails(details),
    });
    while (this.eventsValue.length > this.maxEvents) this.eventsValue.shift();
  }

  private hydrate(value: unknown): void {
    if (!isRecord(value)) return;
    hydrateMetric(this.startupSuccessValue, value.startupSuccess, isBoolean);
    hydrateMetric(this.firstFrameMsValue, value.firstFrameMs, isFiniteNonNegative);
    hydrateMetric(this.playlistRefreshFailureValue, value.playlistRefreshFailure, isFiniteNonNegative);
    hydrateMetric(this.segmentFailureValue, value.segmentFailure, isFiniteNonNegative);
    hydrateMetric(this.bufferCountValue, value.bufferCount, isFiniteNonNegative);
    hydrateMetric(this.bufferDurationValue, value.bufferDuration, isFiniteNonNegative);
    hydrateMetric(this.fatalErrorValue, value.fatalError, isFiniteNonNegative);
    hydrateMetric(this.disconnectCountValue, value.disconnectCount, isFiniteNonNegative);
    hydrateMetric(this.uptimeValue, value.uptimeMs, isFiniteNonNegative);
    this.lastSuccessAtValue = finiteOrNull(value.lastSuccessAt);
    this.lastFailureAtValue = finiteOrNull(value.lastFailureAt);
    this.consecutiveFailuresValue = boundedInteger(value.consecutiveFailures, 0);
    this.cooldownUntilValue = finiteOrNull(value.cooldownUntil);
    const events = Array.isArray(value.events) ? value.events : [];
    for (const item of events) {
      if (!isRecord(item) || typeof item.type !== "string") continue;
      this.eventsValue.push({
        sequence: boundedInteger(item.sequence, this.eventsValue.length + 1),
        at: finiteOrFallback(item.at, this.now()),
        type: safeIdentifier(item.type, "event"),
        safeDetails: sanitizeDetails(isRecord(item.safeDetails) ? stringRecord(item.safeDetails) : {}),
      });
    }
    while (this.eventsValue.length > this.maxEvents) this.eventsValue.shift();
    this.eventSequence = this.eventsValue.at(-1)?.sequence ?? 0;
  }
}

export interface LiveHealthRegistryOptions {
  store?: LiveHealthStore;
  now?: () => number;
  persistDebounceMs?: number;
  maxEvents?: number;
}

export class LiveHealthRegistry {
  private readonly store: LiveHealthStore | undefined;
  private readonly now: () => number;
  private readonly persistDebounceMs: number;
  private readonly maxEvents: number;
  private readonly trackers = new Map<string, LiveStreamHealthTracker>();
  private readonly dirty = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: LiveHealthRegistryOptions = {}) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.persistDebounceMs = Math.max(0, Math.floor(options.persistDebounceMs ?? 500));
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 120));
  }

  public tracker(streamId: string, sourceId: string): LiveStreamHealthTracker {
    const key = safeIdentifier(streamId, "stream");
    let tracker = this.trackers.get(key);
    if (!tracker) {
      tracker = new LiveStreamHealthTracker({
        streamId: key,
        sourceId,
        now: this.now,
        maxEvents: this.maxEvents,
        snapshot: this.store?.readStream(key),
      });
      this.trackers.set(key, tracker);
    }
    return tracker;
  }

  public snapshot(streamId: string, sourceId: string): LiveStreamHealthSnapshot {
    return this.tracker(streamId, sourceId).snapshot(this.now());
  }

  public score(streamId: string, sourceId: string): number | null {
    return this.snapshot(streamId, sourceId).score;
  }

  public markDirty(streamId: string): void {
    if (!this.store) return;
    this.dirty.add(safeIdentifier(streamId, "stream"));
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, this.persistDebounceMs);
  }

  public setCooldown(streamId: string, sourceId: string, until: number | null): void {
    const tracker = this.tracker(streamId, sourceId);
    tracker.setCooldown(until);
    this.markDirty(streamId);
  }

  public clearCooldown(streamId: string, sourceId: string): void {
    this.setCooldown(streamId, sourceId, null);
  }

  public flush(): void {
    if (!this.store || this.dirty.size === 0) return;
    const records = [...this.dirty].map((id) => {
      const tracker = this.trackers.get(id);
      if (!tracker) return null;
      const snapshot = tracker.snapshot(this.now());
      return { id, sourceId: snapshot.sourceId, snapshot, updatedAt: this.now() };
    }).filter((record): record is { id: string; sourceId: string; snapshot: LiveStreamHealthSnapshot; updatedAt: number } => record !== null);
    if (records.length === 0) return;
    if (this.store.upsertStreams) this.store.upsertStreams(records);
    else for (const record of records) this.store.upsertStream(record);
    this.dirty.clear();
  }

  public close(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.flush();
  }
}

export interface LiveCircuitBreakerOptions {
  cooldownMs?: number;
  now?: () => number;
}

export class LiveStreamCircuitBreaker {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly cooldowns = new Map<string, number>();

  public constructor(options: LiveCircuitBreakerOptions = {}) {
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs ?? 15_000));
    this.now = options.now ?? Date.now;
  }

  public open(streamId: string, at = this.now()): number {
    const until = finiteTime(at, this.now()) + this.cooldownMs;
    this.cooldowns.set(safeIdentifier(streamId, "stream"), until);
    return until;
  }

  public recover(streamId: string): void {
    this.cooldowns.delete(safeIdentifier(streamId, "stream"));
  }

  public isCoolingDown(streamId: string, at = this.now()): boolean {
    const until = this.cooldowns.get(safeIdentifier(streamId, "stream"));
    if (until === undefined) return false;
    if (until <= finiteTime(at, this.now())) {
      this.cooldowns.delete(safeIdentifier(streamId, "stream"));
      return false;
    }
    return true;
  }

  public cooldownUntil(streamId: string, at = this.now()): number | null {
    return this.isCoolingDown(streamId, at) ? this.cooldowns.get(safeIdentifier(streamId, "stream")) ?? null : null;
  }
}

export interface LiveFailoverCoordinatorOptions {
  mode?: LiveFailoverMode;
  maxAttempts?: number;
  totalTimeoutMs?: number;
  now?: () => number;
}

export type LiveFailoverDecision =
  | { kind: "none"; reason?: string }
  | { kind: "prompt"; candidate: LiveFailoverCandidateUiState }
  | { kind: "attempt"; candidate: LiveFailoverCandidateUiState }
  | { kind: "stopped"; reason: string };

export class LiveFailoverCoordinator {
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly totalTimeoutMs: number;
  private mode: LiveFailoverMode;
  private candidates: LiveFailoverCandidateUiState[] = [];
  private triedValue: string[] = [];
  private stateValue: import("./live-types.js").LiveFailoverUiState;

  public constructor(options: LiveFailoverCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.totalTimeoutMs = Math.max(1, Math.floor(options.totalTimeoutMs ?? 30_000));
    this.mode = options.mode ?? "ask";
    this.stateValue = this.initialState();
  }

  public get state(): import("./live-types.js").LiveFailoverUiState {
    return cloneFailoverState(this.stateValue);
  }

  public setMode(mode: LiveFailoverMode): import("./live-types.js").LiveFailoverUiState {
    this.mode = mode;
    this.stateValue = {
      ...this.stateValue,
      mode,
      status: mode === "off" ? "disabled" : this.stateValue.status === "disabled" ? "idle" : this.stateValue.status,
    };
    return this.state;
  }

  public begin(
    candidates: readonly LiveFailoverCandidateUiState[],
    currentId: string,
    manualOverrideUntil: number | null = null,
    at = this.now(),
  ): import("./live-types.js").LiveFailoverUiState {
    const startedAt = finiteTime(at, this.now());
    this.candidates = uniqueCandidates(candidates);
    const current = this.candidates.find((candidate) => candidate.id === currentId) ?? null;
    this.triedValue = current ? [current.id] : [];
    this.stateValue = {
      ...this.initialState(),
      mode: this.mode,
      current,
      next: this.peekNext(),
      tried: [...this.triedValue],
      startedAt,
      deadlineAt: startedAt + this.totalTimeoutMs,
      manualOverrideUntil,
    };
    return this.state;
  }

  public trigger(
    trigger: LiveFailoverTrigger,
    reason: string,
    at = this.now(),
  ): LiveFailoverDecision {
    const timestamp = finiteTime(at, this.now());
    if (this.mode === "off") {
      this.stateValue = { ...this.stateValue, mode: "off", status: "disabled", trigger, reason: safeReason(reason) };
      return { kind: "none", reason: "failover-disabled" };
    }
    if (this.stateValue.status === "cancelled" || this.stateValue.status === "stopped" || this.stateValue.status === "recovered") {
      return { kind: "none", reason: `failover-${this.stateValue.status}` };
    }
    this.stateValue = { ...this.stateValue, trigger, reason: safeReason(reason) };
    if (this.mode === "ask") {
      const next = this.peekNext();
      if (!next) return this.stop("no available failover candidate", timestamp);
      this.stateValue = { ...this.stateValue, status: "prompt", next };
      return { kind: "prompt", candidate: next };
    }
    return this.takeNext(timestamp);
  }

  public approve(at = this.now()): LiveFailoverDecision {
    if (this.stateValue.status !== "prompt") return { kind: "none", reason: "no-prompt" };
    return this.takeNext(finiteTime(at, this.now()));
  }

  public next(at = this.now()): LiveFailoverDecision {
    if (this.stateValue.status === "cancelled" || this.stateValue.status === "stopped" || this.stateValue.status === "recovered") {
      return { kind: "none", reason: `failover-${this.stateValue.status}` };
    }
    return this.takeNext(finiteTime(at, this.now()));
  }

  public finishAttempt(success: boolean): import("./live-types.js").LiveFailoverUiState {
    this.stateValue = success
      ? { ...this.stateValue, status: "recovered", next: null }
      : { ...this.stateValue, status: "idle", current: null, next: this.peekNext() };
    return this.state;
  }

  public cancel(reason = "cancelled"): import("./live-types.js").LiveFailoverUiState {
    this.stateValue = { ...this.stateValue, status: "cancelled", reason: safeReason(reason), current: null, next: null };
    return this.state;
  }

  public stay(reason = "user stayed"): import("./live-types.js").LiveFailoverUiState {
    this.stateValue = { ...this.stateValue, status: "stopped", reason: safeReason(reason), current: null, next: null };
    return this.state;
  }

  public setManualOverride(until: number | null): import("./live-types.js").LiveFailoverUiState {
    this.stateValue = { ...this.stateValue, manualOverrideUntil: until };
    return this.state;
  }

  public stop(reason = "no available failover candidate", at = this.now()): LiveFailoverDecision {
    this.stateValue = { ...this.stateValue, status: "stopped", reason: safeReason(reason), current: null, next: null, deadlineAt: this.stateValue.deadlineAt ?? finiteTime(at, this.now()) };
    return { kind: "stopped", reason: safeReason(reason) };
  }

  private takeNext(at: number): LiveFailoverDecision {
    if (this.stateValue.deadlineAt !== null && at > this.stateValue.deadlineAt) return this.stop("failover timeout", at);
    if (this.stateValue.attempts >= this.maxAttempts) return this.stop("maximum failover attempts reached", at);
    const next = this.peekNext();
    if (!next) return this.stop("no available failover candidate", at);
    this.triedValue.push(next.id);
    this.stateValue = {
      ...this.stateValue,
      status: "trying",
      current: next,
      next: null,
      attempts: this.stateValue.attempts + 1,
      tried: [...this.triedValue],
    };
    return { kind: "attempt", candidate: next };
  }

  private peekNext(): LiveFailoverCandidateUiState | null {
    return this.candidates.find((candidate) => !this.triedValue.includes(candidate.id)) ?? null;
  }

  private initialState(): import("./live-types.js").LiveFailoverUiState {
    return {
      mode: this.mode,
      status: this.mode === "off" ? "disabled" : "idle",
      trigger: null,
      reason: null,
      current: null,
      next: null,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      tried: [],
      startedAt: null,
      deadlineAt: null,
      cooldownUntil: null,
      manualOverrideUntil: null,
    };
  }
}

export function calculateLiveHealthScore(snapshot: LiveStreamHealthUiState, now = Date.now()): LiveHealthScore {
  const hasSamples = [
    snapshot.startupSuccess,
    snapshot.firstFrameMs,
    snapshot.playlistRefreshFailure,
    snapshot.segmentFailure,
    snapshot.bufferCount,
    snapshot.bufferDuration,
    snapshot.fatalError,
    snapshot.disconnectCount,
    snapshot.uptimeMs,
  ].some((metric) => metric.samples > 0)
    || snapshot.lastSuccessAt !== null
    || snapshot.lastFailureAt !== null;
  if (!hasSamples) return { value: null, reasons: ["sample unavailable"] };

  let score = 100;
  const reasons: string[] = [];
  if (snapshot.startupSuccess.value === false) {
    score -= 35;
    reasons.push("startup failed");
  }
  if (snapshot.firstFrameMs.value !== null) {
    if (snapshot.firstFrameMs.value > 5_000) score -= 15;
    reasons.push(`first frame ${Math.round(snapshot.firstFrameMs.value)}ms`);
  }
  const playlistFailures = snapshot.playlistRefreshFailure.value ?? 0;
  if (playlistFailures > 0) {
    score -= Math.min(25, playlistFailures * 8);
    reasons.push(`playlist failures ${playlistFailures}`);
  }
  const segmentFailures = snapshot.segmentFailure.value ?? 0;
  if (segmentFailures > 0) {
    score -= Math.min(25, segmentFailures * 6);
    reasons.push(`segment failures ${segmentFailures}`);
  }
  const buffers = snapshot.bufferCount.value ?? 0;
  const bufferDuration = snapshot.bufferDuration.value ?? 0;
  if (buffers > 0 || bufferDuration > 0) {
    score -= Math.min(20, buffers * 4 + Math.floor(bufferDuration / 5_000));
    reasons.push(`buffer ${buffers}x/${Math.round(bufferDuration)}ms`);
  }
  const fatalErrors = snapshot.fatalError.value ?? 0;
  if (fatalErrors > 0) {
    score -= Math.min(30, fatalErrors * 20);
    reasons.push(`fatal errors ${fatalErrors}`);
  }
  const disconnects = snapshot.disconnectCount.value ?? 0;
  if (disconnects > 0) {
    score -= Math.min(20, disconnects * 10);
    reasons.push(`disconnects ${disconnects}`);
  }
  if (snapshot.consecutiveFailures > 0) {
    score -= Math.min(30, snapshot.consecutiveFailures * 10);
    reasons.push(`consecutive failures ${snapshot.consecutiveFailures}`);
  }
  if (snapshot.lastSuccessAt !== null) {
    const age = Math.max(0, now - snapshot.lastSuccessAt);
    if (age > 5 * 60_000) {
      score -= 10;
      reasons.push("sample stale");
    } else {
      reasons.push("recent success");
    }
  } else {
    reasons.push("no successful frame yet");
  }
  return { value: Math.max(0, Math.min(100, score)), reasons };
}

function emptyMetric<T>(): MutableMetric<T> {
  return { value: null, samples: 0 };
}

function cloneMetric<T>(metric: MutableMetric<T>): MutableMetric<T> {
  return { ...metric };
}

function setMetric<T>(metric: MutableMetric<T>, value: T): void {
  metric.value = value;
  metric.samples += 1;
}

function incrementMetric(metric: MutableMetric<number>): void {
  metric.value = (metric.value ?? 0) + 1;
  metric.samples += 1;
}

function addMetric(metric: MutableMetric<number>, value: number): void {
  metric.value = (metric.value ?? 0) + Math.max(0, value);
  metric.samples += 1;
}

function hydrateMetric<T>(metric: MutableMetric<T>, value: unknown, valid: (value: unknown) => value is T): void {
  if (!isRecord(value) || !valid(value.value)) return;
  metric.value = value.value;
  metric.samples = boundedInteger(value.samples, 1);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function finiteOrFallback(value: unknown, fallback: number): number {
  return finiteOrNull(value) ?? Math.round(fallback);
}

function boundedInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function finiteTime(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : Math.round(fallback);
}

function safeIdentifier(value: string, fallback: string): string {
  const text = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "_").slice(0, 120);
  return text || fallback;
}

function sanitizeDetails(details: Record<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40),
      safeReason(value),
    ]),
  );
}

function safeReason(value: string): string {
  return redactSensitiveText(value).replace(/(?:https?|file):\/\/[^\s]+/giu, "[redacted]").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function uniqueCandidates(candidates: readonly LiveFailoverCandidateUiState[]): LiveFailoverCandidateUiState[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  }).map((candidate) => ({
    ...candidate,
    sourceName: safeReason(candidate.sourceName),
    channelName: safeReason(candidate.channelName),
    streamLabel: safeReason(candidate.streamLabel),
  }));
}

function cloneFailoverState(state: import("./live-types.js").LiveFailoverUiState): import("./live-types.js").LiveFailoverUiState {
  return {
    ...state,
    current: state.current ? { ...state.current } : null,
    next: state.next ? { ...state.next } : null,
    tried: [...state.tried],
  };
}
