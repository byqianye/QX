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

function healthError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
