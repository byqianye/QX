export interface SourceSessionEntry<T> {
  key: string;
  client: T;
  refs: number;
  state: "creating" | "ready" | "idle" | "destroying";
  createdAt: number;
  lastUsedAt: number;
}

export interface SourceSessionRegistryOptions {
  maxActiveSessions?: number;
  idleMs?: number;
}

export interface SourceSessionLease<T> {
  readonly key: string;
  readonly client: T;
  release(): Promise<void>;
  init<R>(initializer: (client: T) => Promise<R>): Promise<R>;
}

export class SourceSessionRegistry<T> {
  private readonly maxActiveSessions: number;
  private readonly idleMs: number;
  private readonly entries = new Map<string, InternalEntry<T>>();
  private readonly creating = new Map<string, Promise<InternalEntry<T>>>();
  private readonly waiters: Array<() => void> = [];
  private activeSlots = 0;
  private closed = false;

  public constructor(options: SourceSessionRegistryOptions = {}) {
    this.maxActiveSessions = Math.max(1, Math.floor(options.maxActiveSessions ?? 4));
    this.idleMs = Math.max(0, Math.floor(options.idleMs ?? 30_000));
  }

  public async acquire(
    key: string,
    factory: () => Promise<T> | T,
    destroy?: (client: T) => Promise<void> | void,
  ): Promise<SourceSessionLease<T>> {
    if (this.closed) throw registryError("SOURCE_SESSION_REGISTRY_CLOSED", "Source session registry is closed");
    let entry = this.entries.get(key);
    if (!entry) {
      let creating = this.creating.get(key);
      if (!creating) {
        creating = this.createEntry(key, factory, destroy);
        this.creating.set(key, creating);
      }
      entry = await creating;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.refs += 1;
    entry.state = "ready";
    entry.lastUsedAt = Date.now();
    return new Lease(this, key, entry.client);
  }

  public get(key: string): SourceSessionEntry<T> | undefined {
    const entry = this.entries.get(key);
    return entry ? snapshot(entry) : undefined;
  }

  public list(): readonly SourceSessionEntry<T>[] {
    return [...this.entries.values()].map(snapshot);
  }

  public async release(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsedAt = Date.now();
    if (entry.refs > 0 || entry.state === "destroying") return;
    if (this.idleMs === 0) {
      await this.destroyEntry(key, entry);
      return;
    }
    entry.state = "idle";
    entry.idleTimer = setTimeout(() => {
      void this.destroyEntry(key, entry);
    }, this.idleMs);
  }

  public async destroy(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs = 0;
    await this.destroyEntry(key, entry);
  }

  public async destroyAll(): Promise<void> {
    this.closed = true;
    this.releaseWaiters();
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    await Promise.all([...this.entries].map(([key, entry]) => this.destroyEntry(key, entry)));
    await Promise.allSettled([...this.creating.values()]);
    this.entries.clear();
    this.creating.clear();
  }

  public state(): {
    active: number;
    maxActive: number;
    sessions: readonly SourceSessionEntry<T>[];
    closed: boolean;
  } {
    return {
      active: this.entries.size,
      maxActive: this.maxActiveSessions,
      sessions: this.list(),
      closed: this.closed,
    };
  }

  private async createEntry(
    key: string,
    factory: () => Promise<T> | T,
    destroy?: (client: T) => Promise<void> | void,
  ): Promise<InternalEntry<T>> {
    await this.acquireSlot();
    let stored = false;
    const now = Date.now();
    const creating: InternalEntry<T> = {
      key,
      client: undefined as T,
      refs: 0,
      state: "creating",
      createdAt: now,
      lastUsedAt: now,
      initPromise: null,
      destroyPromise: null,
      destroy: undefined,
      idleTimer: undefined,
    };
    try {
      creating.client = await factory();
      creating.destroy = destroy ?? inferDestroy(creating.client);
      if (this.closed) {
        await creating.destroy?.(creating.client);
        throw registryError("SOURCE_SESSION_REGISTRY_CLOSED", "Source session registry is closed");
      }
      creating.state = "ready";
      this.entries.set(key, creating);
      stored = true;
      return creating;
    } finally {
      if (!stored) this.releaseSlot();
      this.creating.delete(key);
    }
  }

  public async initialize<R>(key: string, initializer: (client: T) => Promise<R>): Promise<R> {
    const entry = this.entries.get(key);
    if (!entry) throw registryError("SOURCE_SESSION_NOT_FOUND", `Source session not found: ${key}`);
    if (entry.initPromise) return entry.initPromise as Promise<R>;
    const promise = initializer(entry.client).finally(() => {
      entry.initPromise = null;
    });
    entry.initPromise = promise;
    return promise;
  }

  private async destroyEntry(key: string, entry: InternalEntry<T>): Promise<void> {
    if (entry.destroyPromise) return entry.destroyPromise;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.state = "destroying";
    const promise = Promise.resolve()
      .then(() => entry.destroy?.(entry.client))
      .finally(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.state = "destroying";
        entry.destroyPromise = null;
        this.releaseSlot();
      });
    entry.destroyPromise = promise;
    return promise;
  }

  private async acquireSlot(): Promise<void> {
    if (this.closed) throw registryError("SOURCE_SESSION_REGISTRY_CLOSED", "Source session registry is closed");
    if (this.activeSlots < this.maxActiveSessions) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.acquireSlot();
  }

  private releaseSlot(): void {
    this.activeSlots = Math.max(0, this.activeSlots - 1);
    while (this.waiters.length > 0 && this.activeSlots < this.maxActiveSessions) {
      this.waiters.shift()?.();
    }
  }

  private releaseWaiters(): void {
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }
}

class Lease<T> implements SourceSessionLease<T> {
  private released = false;

  public constructor(
    private readonly registry: SourceSessionRegistry<T>,
    public readonly key: string,
    public readonly client: T,
  ) {}

  public release(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.released = true;
    return this.registry.release(this.key);
  }

  public init<R>(initializer: (client: T) => Promise<R>): Promise<R> {
    if (this.released) return Promise.reject(registryError("SOURCE_SESSION_RELEASED", "Source session lease is released"));
    return this.registry.initialize(this.key, initializer);
  }
}

interface InternalEntry<T> extends SourceSessionEntry<T> {
  client: T;
  initPromise: Promise<unknown> | null;
  destroyPromise: Promise<void> | null;
  destroy: ((client: T) => Promise<void> | void) | undefined;
  idleTimer: NodeJS.Timeout | undefined;
}

function snapshot<T>(entry: InternalEntry<T>): SourceSessionEntry<T> {
  return {
    key: entry.key,
    client: entry.client,
    refs: entry.refs,
    state: entry.state,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

function registryError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function inferDestroy<T>(client: T): ((value: T) => Promise<void>) | undefined {
  if (!client || typeof client !== "object") return undefined;
  const destroy = (client as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") return undefined;
  return (value) => Promise.resolve((destroy as (this: T) => void).call(value));
}
