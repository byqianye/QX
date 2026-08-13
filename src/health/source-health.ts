import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HealthOperation = "init" | "search" | "detail" | "player";
export type CircuitState = "closed" | "open";

export interface OperationHealth {
  attempts: number;
  successes: number;
  failures: number;
  totalMs: number;
  lastMs: number | null;
  averageMs: number | null;
}

export interface SourceHealthSnapshot {
  sourceId: string;
  circuit: CircuitState;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  timeoutCount: number;
  sidecarCrashCount: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  operations: Readonly<Record<HealthOperation, OperationHealth>>;
}

export interface SourceHealthOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export class SourceHealthRegistry {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly sources = new Map<string, MutableHealth>();

  public constructor(options: SourceHealthOptions = {}) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 3));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs ?? 30_000));
  }

  public canRun(sourceId: string): boolean {
    return !this.isCoolingDown(sourceId);
  }

  public isCoolingDown(sourceId: string): boolean {
    const health = this.sources.get(sourceId);
    return health !== undefined && health.cooldownUntil !== null && health.cooldownUntil > Date.now();
  }

  public recordSuccess(sourceId: string, operation: HealthOperation, elapsedMs: number): void {
    const health = this.getOrCreate(sourceId);
    const metric = health.operations[operation];
    metric.attempts += 1;
    metric.successes += 1;
    metric.totalMs += Math.max(0, elapsedMs);
    metric.lastMs = Math.max(0, elapsedMs);
    metric.averageMs = metric.totalMs / Math.max(1, metric.successes + metric.failures);
    health.consecutiveFailures = 0;
    health.cooldownUntil = null;
    health.lastSuccessAt = Date.now();
    health.lastError = null;
  }

  public recordFailure(sourceId: string, operation: HealthOperation, error: unknown, elapsedMs: number): void {
    const health = this.getOrCreate(sourceId);
    const metric = health.operations[operation];
    metric.attempts += 1;
    metric.failures += 1;
    metric.totalMs += Math.max(0, elapsedMs);
    metric.lastMs = Math.max(0, elapsedMs);
    metric.averageMs = metric.totalMs / Math.max(1, metric.successes + metric.failures);
    health.consecutiveFailures += 1;
    if (isTimeout(error)) health.timeoutCount += 1;
    if (isCrash(error)) health.sidecarCrashCount += 1;
    health.lastError = sanitizeHealthMessage(errorMessage(error));
    if (health.consecutiveFailures >= this.failureThreshold) {
      health.cooldownUntil = Date.now() + this.cooldownMs;
    }
  }

  public async track<T>(
    sourceId: string,
    operation: HealthOperation,
    action: () => Promise<T>,
    failure?: (value: T) => unknown,
  ): Promise<T> {
    if (!this.canRun(sourceId)) {
      const error = healthError("SOURCE_CIRCUIT_OPEN", `Source is cooling down: ${sourceId}`);
      throw error;
    }
    const startedAt = Date.now();
    try {
      const value = await action();
      const failureValue = failure?.(value);
      if (failureValue) {
        this.recordFailure(
          sourceId,
          operation,
          failureValue === true ? new Error(`Source ${operation} returned an unsuccessful response`) : failureValue,
          Date.now() - startedAt,
        );
      } else {
        this.recordSuccess(sourceId, operation, Date.now() - startedAt);
      }
      return value;
    } catch (error) {
      this.recordFailure(sourceId, operation, error, Date.now() - startedAt);
      throw error;
    }
  }

  public markSidecarCrash(sourceId: string, error: unknown = new Error("sidecar crashed")): void {
    const health = this.getOrCreate(sourceId);
    health.sidecarCrashCount += 1;
    health.lastError = sanitizeHealthMessage(errorMessage(error));
  }

  public retry(sourceId: string): void {
    const health = this.getOrCreate(sourceId);
    health.consecutiveFailures = 0;
    health.cooldownUntil = null;
    health.lastError = null;
  }

  public get(sourceId: string): SourceHealthSnapshot {
    return snapshot(this.getOrCreate(sourceId));
  }

  public list(): readonly SourceHealthSnapshot[] {
    return [...this.sources.values()].map(snapshot);
  }

  private getOrCreate(sourceId: string): MutableHealth {
    let health = this.sources.get(sourceId);
    if (!health) {
      health = {
        sourceId,
        cooldownUntil: null,
        consecutiveFailures: 0,
        timeoutCount: 0,
        sidecarCrashCount: 0,
        lastSuccessAt: null,
        lastError: null,
        operations: {
          init: emptyOperation(),
          search: emptyOperation(),
          detail: emptyOperation(),
          player: emptyOperation(),
        },
      };
      this.sources.set(sourceId, health);
    }
    return health;
  }
}

interface MutableHealth extends Omit<SourceHealthSnapshot, "circuit" | "operations"> {
  operations: Record<HealthOperation, OperationHealth>;
}

function snapshot(health: MutableHealth): SourceHealthSnapshot {
  const cooling = health.cooldownUntil !== null && health.cooldownUntil > Date.now();
  return {
    sourceId: health.sourceId,
    circuit: cooling ? "open" : "closed",
    cooldownUntil: cooling ? health.cooldownUntil : null,
    consecutiveFailures: health.consecutiveFailures,
    timeoutCount: health.timeoutCount,
    sidecarCrashCount: health.sidecarCrashCount,
    lastSuccessAt: health.lastSuccessAt,
    lastError: health.lastError,
    operations: Object.fromEntries(
      Object.entries(health.operations).map(([key, value]) => [key, { ...value }]),
    ) as Record<HealthOperation, OperationHealth>,
  };
}

function emptyOperation(): OperationHealth {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    totalMs: 0,
    lastMs: null,
    averageMs: null,
  };
}

function isTimeout(error: unknown): boolean {
  const code = errorCode(error);
  return code?.includes("TIMEOUT") === true || /timeout/i.test(errorMessage(error));
}

function isCrash(error: unknown): boolean {
  const code = errorCode(error);
  return code?.includes("CRASH") === true || /sidecar.*(crash|exit)|process.*exit/i.test(errorMessage(error));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizeHealthMessage(message: string): string {
  return message
    .replace(/(authorization\s*:\s*)(bearer|basic)\s+[^\s]+/gi, "$1$2 [redacted]")
    .replace(/((?:cookie|set-cookie)\s*:\s*)(.*?)(?=\s+(?:authorization|cookie|set-cookie)\s*:|$)/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|auth|password|secret|cookie|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (value) => {
      try {
        const url = new URL(value);
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    });
}

export type SourceHealthV2Operation = "search" | "detail" | "player" | "playback";

export interface SourceHealthV2OperationSnapshot extends OperationHealth {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
}

export interface SourceHealthV2Snapshot {
  sourceId: string;
  score: number;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  playbackSuccessCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  requiresAuth: boolean;
  authenticated: boolean;
  operations: Readonly<Record<SourceHealthV2Operation, SourceHealthV2OperationSnapshot>>;
}

export interface SourceHealthServiceOptions {
  storePath?: string;
  failureThreshold?: number;
  cooldownMs?: number;
  decayHalfLifeMs?: number;
  now?: () => number;
}

export interface SourceHealthRankInput {
  sourceId: string;
  matchScore: number;
  compatibilityScore?: number;
  compatibilityStatus?: string;
  averageLatencyMs?: number | null;
  requiresAuth?: boolean;
  authenticated?: boolean;
}

export interface RankedSource {
  sourceId: string;
  eligible: boolean;
  matchScore: number;
  compatibilityScore: number;
  healthScore: number;
  averageLatencyMs: number | null;
  reason?: string;
}

/**
 * V2 health is deliberately separate from the legacy circuit registry. The
 * legacy registry remains a cheap in-memory guard for existing sessions;
 * this service owns durable, privacy-safe source health and ranking inputs.
 */
export class SourceHealthService {
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly decayHalfLifeMs: number;
  private readonly storePath: string | undefined;
  private readonly sources = new Map<string, MutableHealthV2>();

  public constructor(options: SourceHealthServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 3));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs ?? 10 * 60_000));
    this.decayHalfLifeMs = Math.max(1, Math.floor(options.decayHalfLifeMs ?? 6 * 60 * 60_000));
    this.storePath = options.storePath;
    this.load();
  }

  public getHealth(sourceId: string): SourceHealthV2Snapshot {
    return snapshotV2(this.getOrCreateV2(sourceId), this.now(), this.decayHalfLifeMs);
  }

  public canRun(sourceId: string): boolean {
    const value = this.getOrCreateV2(sourceId);
    return value.cooldownUntil === null || value.cooldownUntil <= this.now();
  }

  public recordSearchSuccess(sourceId: string, latencyMs: number): void { this.recordV2(sourceId, "search", true, latencyMs); }
  public recordSearchFailure(sourceId: string, error: unknown, latencyMs: number): void { this.recordV2(sourceId, "search", false, latencyMs, error); }
  public recordDetailSuccess(sourceId: string, latencyMs: number): void { this.recordV2(sourceId, "detail", true, latencyMs); }
  public recordDetailFailure(sourceId: string, error: unknown, latencyMs: number): void { this.recordV2(sourceId, "detail", false, latencyMs, error); }
  public recordPlayerSuccess(sourceId: string, latencyMs: number): void { this.recordV2(sourceId, "player", true, latencyMs); }
  public recordPlayerFailure(sourceId: string, error: unknown, latencyMs: number): void { this.recordV2(sourceId, "player", false, latencyMs, error); }
  public recordPlaybackSuccess(sourceId: string, latencyMs: number): void { this.recordV2(sourceId, "playback", true, latencyMs); }
  public recordPlaybackFailure(sourceId: string, error: unknown, latencyMs: number): void { this.recordV2(sourceId, "playback", false, latencyMs, error); }

  public setAuthentication(sourceId: string, requiresAuth: boolean, authenticated: boolean): void {
    const value = this.getOrCreateV2(sourceId);
    value.requiresAuth = requiresAuth;
    value.authenticated = authenticated;
    this.persist();
  }

  public setConfigFingerprint(sourceId: string, fingerprint: string): void {
    const value = this.getOrCreateV2(sourceId);
    const normalized = fingerprint.trim().slice(0, 160);
    if (!normalized || value.configFingerprint === normalized) return;
    if (value.configFingerprint !== null) this.sources.set(sourceId, emptyHealthV2(sourceId, normalized));
    else value.configFingerprint = normalized;
    this.persist();
  }

  public resetSourceHealth(sourceId?: string): void {
    if (sourceId === undefined) this.sources.clear();
    else this.sources.delete(sourceId);
    this.persist();
  }

  public retry(sourceId: string): void {
    const value = this.getOrCreateV2(sourceId);
    value.cooldownUntil = null;
    value.consecutiveFailures = 0;
    this.persist();
  }

  public getRankedSources(inputs: readonly SourceHealthRankInput[]): readonly RankedSource[] {
    return inputs.map((input) => {
      const health = this.getHealth(input.sourceId);
      const authBlocked = input.requiresAuth === true && input.authenticated !== true;
      const cooling = health.cooldownUntil !== null && health.cooldownUntil > this.now();
      return {
        sourceId: input.sourceId,
        eligible: !authBlocked && !cooling,
        matchScore: input.matchScore,
        compatibilityScore: input.compatibilityScore ?? compatibilityScore(input.compatibilityStatus),
        healthScore: health.score,
        averageLatencyMs: input.averageLatencyMs ?? averageLatency(health),
        ...(authBlocked ? { reason: "AUTH_REQUIRED" } : cooling ? { reason: "SOURCE_COOLDOWN" } : {}),
      } satisfies RankedSource;
    }).sort((left, right) => Number(right.eligible) - Number(left.eligible)
      || right.matchScore - left.matchScore
      || right.compatibilityScore - left.compatibilityScore
      || right.healthScore - left.healthScore
      || latencyRank(left.averageLatencyMs) - latencyRank(right.averageLatencyMs)
      || left.sourceId.localeCompare(right.sourceId));
  }

  private recordV2(sourceId: string, operation: SourceHealthV2Operation, success: boolean, latencyMs: number, error?: unknown): void {
    const value = this.getOrCreateV2(sourceId);
    const metric = value.operations[operation];
    const elapsed = Math.max(0, Number.isFinite(latencyMs) ? latencyMs : 0);
    metric.attempts += 1;
    metric.totalMs += elapsed;
    metric.lastMs = elapsed;
    metric.averageMs = metric.totalMs / metric.attempts;
    const at = this.now();
    if (success) {
      metric.successes += 1;
      metric.lastSuccessAt = at;
      value.successCount += 1;
      if (operation === "playback") value.playbackSuccessCount += 1;
      value.consecutiveFailures = 0;
      value.cooldownUntil = null;
    } else {
      metric.failures += 1;
      metric.lastFailureAt = at;
      metric.lastFailureCode = safeFailureCode(error);
      value.failureCount += 1;
      value.consecutiveFailures += 1;
      value.lastFailureAt = at;
      value.lastFailureCode = metric.lastFailureCode;
      if (value.consecutiveFailures >= this.failureThreshold) value.cooldownUntil = at + this.cooldownMs;
    }
    if (success) value.lastSuccessAt = at;
    this.persist();
  }

  private getOrCreateV2(sourceId: string): MutableHealthV2 {
    const key = sourceId.trim() || "source";
    let value = this.sources.get(key);
    if (!value) {
      value = emptyHealthV2(key, null);
      this.sources.set(key, value);
    }
    return value;
  }

  private load(): void {
    if (!this.storePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as unknown;
      if (!isRecordValue(raw) || !Array.isArray(raw.sources)) return;
      for (const item of raw.sources) {
        const value = deserializeHealthV2(item);
        if (value) this.sources.set(value.sourceId, value);
      }
    } catch {
      // Corrupt or missing health is disposable; playback must continue.
    }
  }

  private persist(): void {
    if (!this.storePath) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const payload = JSON.stringify({ version: 1, sources: [...this.sources.values()].map(serializeHealthV2) }, null, 2);
      const temp = `${this.storePath}.tmp`;
      writeFileSync(temp, `${payload}\n`, "utf8");
      renameSync(temp, this.storePath);
    } catch {
      // Health is advisory state. A read-only data directory must not break playback.
    }
  }
}

interface MutableHealthV2 {
  sourceId: string;
  configFingerprint: string | null;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  playbackSuccessCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureCode: string | null;
  requiresAuth: boolean;
  authenticated: boolean;
  operations: Record<SourceHealthV2Operation, SourceHealthV2OperationSnapshot>;
}

function emptyHealthV2(sourceId: string, configFingerprint: string | null): MutableHealthV2 {
  return {
    sourceId,
    configFingerprint,
    cooldownUntil: null,
    consecutiveFailures: 0,
    successCount: 0,
    failureCount: 0,
    playbackSuccessCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    requiresAuth: false,
    authenticated: false,
    operations: {
      search: emptyV2Operation(),
      detail: emptyV2Operation(),
      player: emptyV2Operation(),
      playback: emptyV2Operation(),
    },
  };
}

function emptyV2Operation(): SourceHealthV2OperationSnapshot {
  return { ...emptyOperation(), lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null };
}

function snapshotV2(value: MutableHealthV2, now: number, halfLifeMs: number): SourceHealthV2Snapshot {
  const score = healthScore(value, now, halfLifeMs);
  return {
    sourceId: value.sourceId,
    score,
    cooldownUntil: value.cooldownUntil !== null && value.cooldownUntil > now ? value.cooldownUntil : null,
    consecutiveFailures: value.consecutiveFailures,
    successCount: value.successCount,
    failureCount: value.failureCount,
    playbackSuccessCount: value.playbackSuccessCount,
    lastSuccessAt: value.lastSuccessAt,
    lastFailureAt: value.lastFailureAt,
    lastFailureCode: value.lastFailureCode,
    requiresAuth: value.requiresAuth,
    authenticated: value.authenticated,
    operations: Object.fromEntries(Object.entries(value.operations).map(([key, item]) => [key, { ...item }])) as SourceHealthV2Snapshot["operations"],
  };
}

function healthScore(value: MutableHealthV2, now: number, halfLifeMs: number): number {
  const rate = (operation: SourceHealthV2Operation): number => {
    const item = value.operations[operation];
    return item.attempts === 0 ? 0 : item.successes / item.attempts;
  };
  const search = rate("search");
  const detail = rate("detail");
  const player = rate("player");
  const playback = rate("playback");
  const latency = averageLatency(value);
  const speed = latency === null ? 0 : Math.max(0, Math.min(1, 1 - latency / 12_000));
  let score = search * 25 + detail * 20 + player * 25 + speed * 15 + playback * 10;
  if (value.requiresAuth && !value.authenticated) score = Math.max(10, score);
  if (value.consecutiveFailures > 0) score -= Math.min(20, value.consecutiveFailures * 7);
  if (value.lastSuccessAt !== null) score *= Math.pow(0.5, Math.max(0, now - value.lastSuccessAt) / halfLifeMs);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function averageLatency(value: MutableHealthV2 | SourceHealthV2Snapshot): number | null {
  const operations = Object.values(value.operations);
  const attempts = operations.reduce((total, item) => total + item.attempts, 0);
  return attempts === 0 ? null : operations.reduce((total, item) => total + item.totalMs, 0) / attempts;
}

function compatibilityScore(status: string | undefined): number {
  switch (status) {
    case "FULLY_PLAYABLE": return 100;
    case "SEARCH_DETAIL_ONLY": return 70;
    case "SEARCH_ONLY": return 40;
    case "AUTH_REQUIRED": return 30;
    default: return 0;
  }
}

function latencyRank(value: number | null): number { return value === null ? Number.MAX_SAFE_INTEGER : value; }
function safeFailureCode(error: unknown): string { return (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "SOURCE_FAILED").replace(/[^A-Z0-9_.-]/giu, "_").slice(0, 80); }

function serializeHealthV2(value: MutableHealthV2): Record<string, unknown> {
  return {
    sourceId: value.sourceId,
    configFingerprint: value.configFingerprint,
    cooldownUntil: value.cooldownUntil,
    consecutiveFailures: value.consecutiveFailures,
    successCount: value.successCount,
    failureCount: value.failureCount,
    playbackSuccessCount: value.playbackSuccessCount,
    lastSuccessAt: value.lastSuccessAt,
    lastFailureAt: value.lastFailureAt,
    lastFailureCode: value.lastFailureCode,
    requiresAuth: value.requiresAuth,
    authenticated: value.authenticated,
    operations: value.operations,
  };
}

function deserializeHealthV2(value: unknown): MutableHealthV2 | undefined {
  if (!isRecordValue(value) || typeof value.sourceId !== "string") return undefined;
  const result = emptyHealthV2(value.sourceId, typeof value.configFingerprint === "string" ? value.configFingerprint : null);
  for (const key of ["cooldownUntil", "consecutiveFailures", "successCount", "failureCount", "playbackSuccessCount", "lastSuccessAt", "lastFailureAt"] as const) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number)) result[key] = number;
  }
  result.lastFailureCode = typeof value.lastFailureCode === "string" ? value.lastFailureCode.slice(0, 80) : null;
  result.requiresAuth = value.requiresAuth === true;
  result.authenticated = value.authenticated === true;
  if (isRecordValue(value.operations)) {
    for (const operation of ["search", "detail", "player", "playback"] as const) {
      const source = value.operations[operation];
      if (!isRecordValue(source)) continue;
      const target = result.operations[operation];
      for (const key of ["attempts", "successes", "failures", "totalMs", "lastMs", "averageMs", "lastSuccessAt", "lastFailureAt"] as const) {
        const number = source[key];
        if ((key === "lastMs" || key === "averageMs" || key === "lastSuccessAt" || key === "lastFailureAt") && number === null) target[key] = null;
        else if (typeof number === "number" && Number.isFinite(number)) target[key] = number;
      }
      target.lastFailureCode = typeof source.lastFailureCode === "string" ? source.lastFailureCode.slice(0, 80) : null;
    }
  }
  return result;
}

function isRecordValue(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }


function healthError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
