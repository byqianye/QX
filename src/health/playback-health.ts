export type PlaybackFallbackMode = "off" | "prompt" | "auto";

export type PlaybackFallbackTrigger =
  | "player-content-failure"
  | "parse-failure"
  | "proxy-fatal"
  | "player-fatal"
  | "startup-timeout"
  | "segment-errors"
  | "user-pause"
  | "seek"
  | "single-buffer"
  | "short-fluctuation";

export type FallbackCandidateKind =
  | "retry-current"
  | "reparse-current"
  | "same-content"
  | "healthier";

export interface FallbackCandidate {
  id: string;
  label: string;
  kind: FallbackCandidateKind;
  healthScore?: number | null;
  sourceId?: string;
  lineKey?: string;
  parseAttempt?: number;
  errorCode?: string;
}

export interface AutoFallbackV2Policy {
  maxSources?: number;
  maxLinesPerSource?: number;
  maxParsesPerSource?: number;
  totalTimeoutMs?: number;
}

export const DEFAULT_AUTO_FALLBACK_V2_POLICY: Required<AutoFallbackV2Policy> = {
  maxSources: 5,
  maxLinesPerSource: 3,
  maxParsesPerSource: 3,
  totalTimeoutMs: 45_000,
};

const AUTO_FALLBACK_RETRYABLE_CODES = new Set([
  "SOURCE_TIMEOUT",
  "PLAYER_FAILED",
  "PLAYBACK_UPSTREAM_ERROR",
  "JVM_SPIDER_ERROR",
  "MEDIA_HTTP_403",
  "MEDIA_HTTP_404",
  "HLS_MANIFEST_FAILED",
  "HLS_SEGMENT_FAILED",
  "PLAYER_FATAL_ERROR",
]);

export function isAutoFallbackRetryable(code: string | undefined): boolean {
  if (!code) return false;
  const normalized = code.trim().toUpperCase();
  return normalized.startsWith("PARSE_")
    || [...AUTO_FALLBACK_RETRYABLE_CODES].some((allowed) => normalized === allowed || normalized.includes(allowed));
}

export function limitAutoFallbackCandidates(
  candidates: readonly FallbackCandidate[],
  policy: AutoFallbackV2Policy = {},
): FallbackCandidate[] {
  const limits = { ...DEFAULT_AUTO_FALLBACK_V2_POLICY, ...policy };
  const sources = new Set<string>();
  const lines = new Map<string, Set<string>>();
  let parseAttempts = 0;
  return candidates.filter((candidate) => {
    const sourceId = candidate.sourceId ?? "current";
    const lineKey = candidate.lineKey ?? candidate.id;
    if (candidate.kind === "retry-current" || candidate.kind === "reparse-current") {
      if (candidate.kind === "reparse-current") {
        parseAttempts += 1;
        if (parseAttempts > limits.maxParsesPerSource) return false;
      }
      return true;
    }
    if (!sources.has(sourceId) && sources.size >= limits.maxSources) return false;
    const sourceLines = lines.get(sourceId) ?? new Set<string>();
    if (!sourceLines.has(lineKey) && sourceLines.size >= limits.maxLinesPerSource) return false;
    sources.add(sourceId);
    sourceLines.add(lineKey);
    lines.set(sourceId, sourceLines);
    return true;
  });
}

export interface PlaybackHealthMetric<T> {
  value: T | null;
  samples: number;
}

export interface PlaybackHealthEvent {
  sequence: number;
  at: number;
  type: string;
  safeDetails: Readonly<Record<string, string>>;
}

export interface PlaybackHealthScore {
  value: number | null;
  reasons: readonly string[];
}

export interface PlaybackHealthSnapshot {
  sourceId: string;
  resolveSuccess: PlaybackHealthMetric<boolean>;
  firstFrameMs: PlaybackHealthMetric<number>;
  startupFailure: PlaybackHealthMetric<number>;
  bufferingCount: PlaybackHealthMetric<number>;
  bufferingDuration: PlaybackHealthMetric<number>;
  fatalError: PlaybackHealthMetric<number>;
  httpStatus: PlaybackHealthMetric<number>;
  segmentFailure: PlaybackHealthMetric<number>;
  playbackDuration: PlaybackHealthMetric<number>;
  completion: PlaybackHealthMetric<boolean>;
  lastSuccess: PlaybackHealthMetric<number>;
  consecutiveFailures: PlaybackHealthMetric<number>;
  score: PlaybackHealthScore;
  events: readonly PlaybackHealthEvent[];
}

export interface PlaybackHealthTrackerOptions {
  sourceId: string;
  now?: () => number;
  maxEvents?: number;
  segmentFailureThreshold?: number;
}

type MutableMetric<T> = PlaybackHealthMetric<T>;

type TrackerScoreSnapshot = Pick<PlaybackHealthSnapshot,
  | "resolveSuccess"
  | "firstFrameMs"
  | "bufferingCount"
  | "segmentFailure"
  | "fatalError"
  | "httpStatus"
  | "consecutiveFailures"
>;

export class PlaybackHealthTracker {
  private readonly sourceId: string;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly segmentFailureThreshold: number;
  private readonly eventsValue: PlaybackHealthEvent[] = [];
  private eventSequence = 0;
  private attemptStartedAt: number | null = null;
  private bufferStartedAt: number | null = null;
  private consecutiveSegmentFailures = 0;
  private consecutiveFailuresValue = 0;
  private readonly resolveSuccessValue = emptyMetric<boolean>();
  private readonly firstFrameMsValue = emptyMetric<number>();
  private readonly startupFailureValue = emptyMetric<number>();
  private readonly bufferingCountValue = emptyMetric<number>();
  private readonly bufferingDurationValue = emptyMetric<number>();
  private readonly fatalErrorValue = emptyMetric<number>();
  private readonly httpStatusValue = emptyMetric<number>();
  private readonly segmentFailureValue = emptyMetric<number>();
  private readonly playbackDurationValue = emptyMetric<number>();
  private readonly completionValue = emptyMetric<boolean>();
  private readonly lastSuccessValue = emptyMetric<number>();
  private readonly consecutiveFailuresMetric = emptyMetric<number>();

  public constructor(options: PlaybackHealthTrackerOptions) {
    this.sourceId = safeIdentifier(options.sourceId, "source");
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 100));
    this.segmentFailureThreshold = Math.max(2, Math.floor(options.segmentFailureThreshold ?? 2));
  }

  public beginAttempt(at = this.now()): void {
    this.attemptStartedAt = finiteTime(at, this.now());
    this.bufferStartedAt = null;
    this.consecutiveSegmentFailures = 0;
    this.recordEvent("attempt-started", this.attemptStartedAt);
  }

  public recordResolve(success: boolean, at = this.now()): void {
    setMetric(this.resolveSuccessValue, success);
    if (!success) this.incrementFailure();
    this.recordEvent(success ? "resolve-success" : "resolve-failure", at);
  }

  public recordFirstFrame(at = this.now()): void {
    const timestamp = finiteTime(at, this.now());
    const elapsed = this.attemptStartedAt === null ? null : Math.max(0, timestamp - this.attemptStartedAt);
    if (elapsed !== null) setMetric(this.firstFrameMsValue, elapsed);
    this.consecutiveFailuresValue = 0;
    this.consecutiveSegmentFailures = 0;
    setMetric(this.consecutiveFailuresMetric, 0);
    setMetric(this.lastSuccessValue, timestamp);
    this.recordEvent("first-frame", timestamp, elapsed === null ? {} : { elapsedMs: String(elapsed) });
  }

  public recordStartupFailure(reason = "startup timeout", at = this.now()): void {
    incrementMetric(this.startupFailureValue);
    this.incrementFailure();
    this.recordEvent("startup-failure", at, { reason });
  }

  public recordBufferStart(at = this.now()): void {
    if (this.bufferStartedAt === null) this.bufferStartedAt = finiteTime(at, this.now());
    this.recordEvent("buffer-start", at);
  }

  public recordBufferEnd(at = this.now()): void {
    const timestamp = finiteTime(at, this.now());
    const duration = this.bufferStartedAt === null ? 0 : Math.max(0, timestamp - this.bufferStartedAt);
    this.bufferStartedAt = null;
    incrementMetric(this.bufferingCountValue);
    addMetric(this.bufferingDurationValue, duration);
    this.recordEvent("buffer-end", timestamp, { durationMs: String(duration) });
  }

  public recordFatalError(code = "PLAYER_FATAL", at = this.now()): void {
    incrementMetric(this.fatalErrorValue);
    this.incrementFailure();
    this.recordEvent("fatal-error", at, { code });
  }

  public recordHttpStatus(status: number, at = this.now()): void {
    if (!Number.isInteger(status) || status < 100 || status > 599) return;
    setMetric(this.httpStatusValue, status);
    this.recordEvent("http-status", at, { status: String(status) });
  }

  public recordSegmentFailure(reason = "segment failure", at = this.now()): void {
    incrementMetric(this.segmentFailureValue);
    this.incrementFailure();
    this.consecutiveSegmentFailures += 1;
    this.recordEvent("segment-failure", at, { reason });
  }

  public recordPlaybackDuration(seconds: number, at = this.now()): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    setMetric(this.playbackDurationValue, seconds);
    this.recordEvent("playback-duration", at, { seconds: String(Math.round(seconds * 100) / 100) });
  }

  public recordCompletion(at = this.now()): void {
    const timestamp = finiteTime(at, this.now());
    setMetric(this.completionValue, true);
    setMetric(this.lastSuccessValue, timestamp);
    this.consecutiveFailuresValue = 0;
    this.consecutiveSegmentFailures = 0;
    setMetric(this.consecutiveFailuresMetric, 0);
    this.recordEvent("completion", timestamp);
  }

  public recordUserPause(at = this.now()): void {
    this.recordEvent("user-pause", at);
  }

  public recordSeek(at = this.now()): void {
    this.recordEvent("seek", at);
  }

  public shouldTriggerSegmentFailure(): boolean {
    return this.consecutiveSegmentFailures >= this.segmentFailureThreshold;
  }

  public snapshotWithoutScore(): TrackerScoreSnapshot {
    return {
      resolveSuccess: cloneMetric(this.resolveSuccessValue),
      firstFrameMs: cloneMetric(this.firstFrameMsValue),
      bufferingCount: cloneMetric(this.bufferingCountValue),
      segmentFailure: cloneMetric(this.segmentFailureValue),
      fatalError: cloneMetric(this.fatalErrorValue),
      httpStatus: cloneMetric(this.httpStatusValue),
      consecutiveFailures: cloneMetric(this.consecutiveFailuresMetric),
    };
  }

  public snapshot(): PlaybackHealthSnapshot {
    return {
      sourceId: this.sourceId,
      resolveSuccess: cloneMetric(this.resolveSuccessValue),
      firstFrameMs: cloneMetric(this.firstFrameMsValue),
      startupFailure: cloneMetric(this.startupFailureValue),
      bufferingCount: cloneMetric(this.bufferingCountValue),
      bufferingDuration: cloneMetric(this.bufferingDurationValue),
      fatalError: cloneMetric(this.fatalErrorValue),
      httpStatus: cloneMetric(this.httpStatusValue),
      segmentFailure: cloneMetric(this.segmentFailureValue),
      playbackDuration: cloneMetric(this.playbackDurationValue),
      completion: cloneMetric(this.completionValue),
      lastSuccess: cloneMetric(this.lastSuccessValue),
      consecutiveFailures: cloneMetric(this.consecutiveFailuresMetric),
      score: scoreFor(this),
      events: this.eventsValue.map((event) => ({ ...event, safeDetails: { ...event.safeDetails } })),
    };
  }

  private incrementFailure(): void {
    this.consecutiveFailuresValue += 1;
    setMetric(this.consecutiveFailuresMetric, this.consecutiveFailuresValue);
  }

  private recordEvent(type: string, at: number, details: Record<string, string> = {}): void {
    this.eventsValue.push({
      sequence: ++this.eventSequence,
      at: finiteTime(at, this.now()),
      type,
      safeDetails: sanitizeDetails(details),
    });
    while (this.eventsValue.length > this.maxEvents) this.eventsValue.shift();
  }
}

export class PlaybackHealthRegistry {
  private readonly trackers = new Map<string, PlaybackHealthTracker>();
  private readonly options: Omit<PlaybackHealthTrackerOptions, "sourceId">;

  public constructor(options: Omit<PlaybackHealthTrackerOptions, "sourceId"> = {}) {
    this.options = { ...options };
  }

  public tracker(sourceId: string): PlaybackHealthTracker {
    const key = safeIdentifier(sourceId, "source");
    let tracker = this.trackers.get(key);
    if (!tracker) {
      tracker = new PlaybackHealthTracker({ ...this.options, sourceId: key });
      this.trackers.set(key, tracker);
    }
    return tracker;
  }

  public snapshot(sourceId: string): PlaybackHealthSnapshot {
    return this.tracker(sourceId).snapshot();
  }

  public score(sourceId: string): number | null {
    return this.tracker(sourceId).snapshot().score.value;
  }
}

export type PlaybackFallbackStatus = "idle" | "prompt" | "trying" | "recovered" | "cancelled" | "stopped" | "disabled";

export interface PlaybackFallbackState {
  mode: PlaybackFallbackMode;
  status: PlaybackFallbackStatus;
  trigger: PlaybackFallbackTrigger | null;
  reason: string | null;
  current: FallbackCandidate | null;
  next: FallbackCandidate | null;
  attempts: number;
  maxAttempts: number;
  tried: readonly string[];
  startedAt: number | null;
  deadlineAt: number | null;
}

export interface PlaybackFallbackCoordinatorOptions {
  mode?: PlaybackFallbackMode;
  maxAttempts?: number;
  totalTimeoutMs?: number;
  now?: () => number;
  autoFallbackV2?: AutoFallbackV2Policy;
}

export type PlaybackFallbackDecision =
  | { kind: "none"; reason?: string }
  | { kind: "prompt"; candidate: FallbackCandidate }
  | { kind: "attempt"; candidate: FallbackCandidate }
  | { kind: "stopped"; reason: string };

export class PlaybackFallbackCoordinator {
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly totalTimeoutMs: number;
  private readonly autoFallbackV2: AutoFallbackV2Policy;
  private mode: PlaybackFallbackMode;
  private candidates: FallbackCandidate[] = [];
  private triedValue: string[] = [];
  private stateValue: PlaybackFallbackState;

  public constructor(options: PlaybackFallbackCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
    this.totalTimeoutMs = Math.max(1, Math.floor(options.totalTimeoutMs ?? 30_000));
    this.autoFallbackV2 = options.autoFallbackV2 ?? {};
    this.mode = options.mode ?? "prompt";
    this.stateValue = this.initialState();
  }

  public get state(): PlaybackFallbackState {
    return cloneFallbackState(this.stateValue);
  }

  public begin(candidates: readonly FallbackCandidate[], at = this.now()): PlaybackFallbackState {
    const startedAt = finiteTime(at, this.now());
    this.candidates = uniqueCandidates(limitAutoFallbackCandidates(rankFallbackCandidates(candidates), this.autoFallbackV2));
    this.triedValue = [];
    this.stateValue = {
      ...this.initialState(),
      startedAt,
      deadlineAt: startedAt + this.totalTimeoutMs,
    };
    return this.state;
  }

  public setMode(mode: PlaybackFallbackMode): PlaybackFallbackState {
    this.mode = mode;
    this.stateValue = {
      ...this.stateValue,
      mode,
      status: mode === "off" ? "disabled" : this.stateValue.status === "disabled" ? "idle" : this.stateValue.status,
    };
    return this.state;
  }

  public trigger(trigger: PlaybackFallbackTrigger, reason: string, at = this.now()): PlaybackFallbackDecision {
    if (isIgnoredTrigger(trigger)) return { kind: "none", reason: "ignored-user-event" };
    if (this.mode === "off") {
      this.stateValue = { ...this.stateValue, mode: "off", status: "disabled", trigger, reason: safeReason(reason) };
      return { kind: "none", reason: "fallback-disabled" };
    }
    if (this.stateValue.status === "cancelled" || this.stateValue.status === "stopped" || this.stateValue.status === "recovered") {
      return { kind: "none", reason: `fallback-${this.stateValue.status}` };
    }
    this.stateValue = { ...this.stateValue, trigger, reason: safeReason(reason) };
    if (this.mode === "prompt") {
      const next = this.peekNext(at);
      if (!next) return this.stop("没有可尝试的线路", at);
      this.stateValue = { ...this.stateValue, status: "prompt", next };
      return { kind: "prompt", candidate: next };
    }
    return this.takeNext(at);
  }

  public approveNext(at = this.now()): PlaybackFallbackDecision {
    if (this.stateValue.status !== "prompt") return { kind: "none", reason: "no-prompt" };
    return this.takeNext(at);
  }

  public next(at = this.now()): PlaybackFallbackDecision {
    if (this.stateValue.status === "cancelled" || this.stateValue.status === "stopped" || this.stateValue.status === "recovered") {
      return { kind: "none", reason: `fallback-${this.stateValue.status}` };
    }
    const now = finiteTime(at, this.now());
    if (this.stateValue.attempts >= this.maxAttempts) return this.stop("达到最大回退次数", now);
    if (this.stateValue.deadlineAt !== null && now > this.stateValue.deadlineAt) return this.stop("回退总超时", now);
    if (this.mode === "prompt") {
      const next = this.peekNext(now);
      if (!next) return this.stop("没有可尝试的线路", now);
      this.stateValue = { ...this.stateValue, status: "prompt", next };
      return { kind: "prompt", candidate: next };
    }
    return this.takeNext(now);
  }

  public finishAttempt(success: boolean): PlaybackFallbackState {
    if (success) {
      this.stateValue = { ...this.stateValue, status: "recovered", current: null, next: null };
    } else {
      this.stateValue = { ...this.stateValue, status: "idle", current: null, next: null };
    }
    return this.state;
  }

  public cancel(reason = "用户取消"): PlaybackFallbackState {
    this.stateValue = { ...this.stateValue, status: "cancelled", reason: safeReason(reason), current: null, next: null };
    return this.state;
  }

  public stop(reason = "回退已停止", at = this.now()): PlaybackFallbackDecision {
    const safe = safeReason(reason);
    this.stateValue = { ...this.stateValue, status: "stopped", reason: safe, current: null, next: null };
    return { kind: "stopped", reason: safe };
  }

  private takeNext(at: number): PlaybackFallbackDecision {
    const now = finiteTime(at, this.now());
    if (this.stateValue.deadlineAt !== null && now > this.stateValue.deadlineAt) return this.stop("回退总超时", now);
    if (this.stateValue.attempts >= this.maxAttempts) return this.stop("达到最大回退次数", now);
    const next = this.peekNext(now);
    if (!next) return this.stop("没有可尝试的线路", now);
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

  private peekNext(at: number): FallbackCandidate | null {
    const now = finiteTime(at, this.now());
    if (this.stateValue.deadlineAt !== null && now > this.stateValue.deadlineAt) return null;
    return this.candidates.find((candidate) => !this.triedValue.includes(candidate.id)) ?? null;
  }

  private initialState(): PlaybackFallbackState {
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
    };
  }
}

export function rankFallbackCandidates(candidates: readonly FallbackCandidate[]): FallbackCandidate[] {
  const kindRank: Record<FallbackCandidateKind, number> = {
    "retry-current": 0,
    "reparse-current": 1,
    "same-content": 2,
    healthier: 3,
  };
  return candidates
    .map((candidate, index) => ({ candidate: { ...candidate, id: safeIdentifier(candidate.id, `candidate-${index}`), label: safeCandidateLabel(candidate.label) }, index }))
    .sort((left, right) => {
      const kind = kindRank[left.candidate.kind] - kindRank[right.candidate.kind];
      if (kind !== 0) return kind;
      const leftScore = left.candidate.healthScore;
      const rightScore = right.candidate.healthScore;
      if (leftScore !== rightScore) {
        if (leftScore === null || leftScore === undefined) return 1;
        if (rightScore === null || rightScore === undefined) return -1;
        return rightScore - leftScore;
      }
      return left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

function scoreFor(tracker: PlaybackHealthTracker): PlaybackHealthScore {
  const snapshot = tracker.snapshotWithoutScore();
  const hasSample = Object.values(snapshot).some((metric) => metric.samples > 0);
  if (!hasSample) return { value: null, reasons: ["样本不足"] };

  let score = 100;
  const reasons: string[] = [];
  if (snapshot.resolveSuccess.value === false) {
    score -= 35;
    reasons.push("解析失败");
  }
  if (snapshot.firstFrameMs.value !== null) {
    reasons.push(`首帧 ${Math.round(snapshot.firstFrameMs.value)}ms`);
    if (snapshot.firstFrameMs.value > 5_000) score -= 15;
  }
  if ((snapshot.bufferingCount.value ?? 0) > 0) {
    score -= Math.min(20, (snapshot.bufferingCount.value ?? 0) * 5);
    reasons.push(`缓冲 ${snapshot.bufferingCount.value} 次`);
  }
  if ((snapshot.segmentFailure.value ?? 0) > 0) {
    score -= Math.min(25, (snapshot.segmentFailure.value ?? 0) * 8);
    reasons.push(`分片失败 ${snapshot.segmentFailure.value} 次`);
  }
  if ((snapshot.fatalError.value ?? 0) > 0) {
    score -= Math.min(30, (snapshot.fatalError.value ?? 0) * 20);
    reasons.push(`致命错误 ${snapshot.fatalError.value} 次`);
  }
  if (snapshot.httpStatus.value !== null && snapshot.httpStatus.value >= 400) {
    score -= 25;
    reasons.push(`HTTP ${snapshot.httpStatus.value}`);
  }
  if ((snapshot.consecutiveFailures.value ?? 0) > 0) {
    score -= Math.min(30, (snapshot.consecutiveFailures.value ?? 0) * 10);
    reasons.push(`连续失败 ${snapshot.consecutiveFailures.value} 次`);
  }
  return { value: Math.max(0, Math.min(100, score)), reasons };
}

function emptyMetric<T>(): MutableMetric<T> {
  return { value: null, samples: 0 };
}

function cloneMetric<T>(metric: PlaybackHealthMetric<T>): PlaybackHealthMetric<T> {
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

function finiteTime(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : Math.round(fallback);
}

function safeIdentifier(value: string, fallback: string): string {
  const text = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "_").slice(0, 120);
  return text || fallback;
}

function safeCandidateLabel(value: string): string {
  const text = value.trim();
  if (/\b(?:https?|file):\/\//i.test(text) || /^[A-Za-z]:\\|^\//.test(text)) return "[已脱敏线路]";
  return text.slice(0, 80) || "未命名线路";
}

function safeReason(value: string): string {
  return safeCandidateLabel(value).replace(/[\r\n]+/g, " ");
}

function sanitizeDetails(details: Record<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40),
      safeReason(value),
    ]),
  );
}

function uniqueCandidates(candidates: readonly FallbackCandidate[]): FallbackCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function cloneFallbackState(state: PlaybackFallbackState): PlaybackFallbackState {
  return {
    ...state,
    current: state.current ? { ...state.current } : null,
    next: state.next ? { ...state.next } : null,
    tried: [...state.tried],
  };
}

function isIgnoredTrigger(trigger: PlaybackFallbackTrigger): boolean {
  return trigger === "user-pause"
    || trigger === "seek"
    || trigger === "single-buffer"
    || trigger === "short-fluctuation";
}
